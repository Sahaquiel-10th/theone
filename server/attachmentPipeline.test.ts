import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { Store } from "./db.js";
import type { Attachment, Database } from "./types.js";
import { AttachmentService, ATTACHMENT_CHUNK_BYTES, ownedAttachment, removeAttachmentFiles } from "./attachmentService.js";
import { prepareAttachmentContext, attachmentSegments } from "./attachmentRetrieval.js";
import { parseAttachment } from "./attachmentParser.js";

const scope = { workspaceId: "w", userId: "u", conversationId: "c" };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "one-attachments-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let db = { attachments: [] } as unknown as Database;
  const store: Store = { read: async () => db, mutate: async fn => { const next = structuredClone(db); const value = fn(next); db = next; return value; } };
  return { directory, store, service: new AttachmentService(store, directory) };
}
async function ready(store: Store, id: string) {
  for (let n = 0; n < 150; n++) {
    const item = (await store.read()).attachments.find(a => a.id === id)!;
    if (item.status === "ready" || item.status === "failed") return item;
    await new Promise(r => setTimeout(r, 40));
  }
  throw new Error("Parser did not finish");
}

test("chunk upload, crash offset recovery, full text beyond 30k and question-based tail retrieval", async t => {
  const f = await fixture(t);
  const text = "无关背景。".repeat(13000) + "\n尾部验证码 TAIL_SECRET_94827，任务暗号是紫色河马。";
  const bytes = Buffer.from(text);
  const item = await f.service.create(scope, "报告.txt", bytes.length, "text/plain");
  await assert.rejects(f.service.chunk({ ...scope, userId: "other" }, item.id, 0, bytes), /无权/);
  await assert.rejects(f.service.chunk({ ...scope, workspaceId: "other" }, item.id, 0, bytes), /无权/);
  await assert.rejects(f.service.complete(scope, item.id), /尚未/);
  await fs.appendFile(item.storagePath, "uncommitted crash bytes");
  await f.service.chunk(scope, item.id, 0, bytes);
  await assert.rejects(f.service.chunk(scope, item.id, 0, bytes), /进度/);
  await f.service.complete(scope, item.id);
  const parsed = await ready(f.store, item.id);
  assert.equal(parsed.status, "ready", parsed.parseError);
  assert.equal(parsed.extractedText, "");
  assert.equal(parsed.textChars, text.length);
  const attachment = { ...parsed, conversationId: "c" };
  let restored = "";
  for await (const segment of attachmentSegments(attachment)) restored += segment.text;
  assert.equal(restored, text);
  const context = await prepareAttachmentContext([attachment], scope, "尾部验证码 TAIL_SECRET_94827 是什么", 16000, async () => { throw new Error("Unexpected model call"); });
  assert.match(context.text, /TAIL_SECRET_94827/);
  assert.equal(context.truncated, true);
  assert.ok(context.text.length < 16000);
  assert.equal(await fs.readFile(item.storagePath, "utf8"), text);
});

test("private sidecars reject both cross-workspace and cross-conversation access before disk IO", async () => {
  const file = { id: "a", ...scope, storagePath: "/not/readable", kind: "text", segmentCount: 1, textChars: 1, extractedText: "" } as Attachment;
  for (const other of [{ ...scope, userId: "b" }, { ...scope, workspaceId: "b" }, { ...scope, conversationId: "b" }]) {
    await assert.rejects(prepareAttachmentContext([file], other, "hello", 12000, async () => ""), /不属于/);
  }
  assert.throws(() => ownedAttachment([file], { ...scope, userId: "b" }, "a"), /无权/);
});

test("full document summaries visit every segment and preserve billing-callback failure", async () => {
  const text = Array.from({ length: 25 }, (_, n) => `UNIQUE_SECTION_${n} ` + "x".repeat(3980)).join("\n");
  const file = { id: "a", ...scope, originalName: "whole.txt", kind: "text", extractedText: text } as Attachment;
  const calls: string[] = [];
  const result = await prepareAttachmentContext([file], scope, "总结全文", 12000, async text => { calls.push(text); return `批次 ${calls.length} 摘要`; });
  for (let n = 0; n < 25; n++) assert.ok(calls.join("\n").includes(`UNIQUE_SECTION_${n} `));
  assert.ok(calls.length > 1);
  assert.equal(result.truncated, false);
  assert.match(result.text, /覆盖已解析全文/);
  let count = 0;
  await assert.rejects(prepareAttachmentContext([file], scope, "总结全文", 12000, async () => { if (++count === 2) throw new Error("Key removed"); return "first"; }), /Key removed/);
  assert.equal(count, 2);
});

test("malformed files fail safely, retry is scoped, queued work recovers after restart", async t => {
  const f = await fixture(t);
  const item = await f.service.create(scope, "broken.pdf", 5, "application/pdf");
  await f.service.chunk(scope, item.id, 0, Buffer.from("wrong"));
  await f.store.mutate(db => { db.attachments[0].status = "parsing"; });
  await f.service.recover();
  assert.equal((await ready(f.store, item.id)).status, "failed");
  await assert.rejects(f.service.retry({ ...scope, userId: "other" }, item.id), /无权/);
  await f.service.retry(scope, item.id);
  assert.equal((await ready(f.store, item.id)).status, "failed");
  await removeAttachmentFiles(item.storagePath);
  await assert.rejects(fs.stat(item.storagePath));
});

test("upload limits, incomplete upload expiry and cleanup retain conversation data", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.create(scope, "big.txt", 201 * 1024 ** 2, "text/plain"), /200/);
  await assert.rejects(f.service.create(scope, "big.png", 21 * 1024 ** 2, "image/png"), /20/);
  for (let i = 0; i < 5; i++) await f.service.create(scope, "a.txt", 10, "text/plain");
  await assert.rejects(f.service.create(scope, "a.txt", 10, "text/plain"), /5/);
  await f.service.create({ ...scope, userId: "other" }, "a.txt", 10, "text/plain");
  const first = (await f.store.read()).attachments[0];
  await assert.rejects(f.service.chunk(scope, first.id, 0, Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 1)), /进度/);
  await f.store.mutate(db => { db.attachments[0].createdAt = "2000-01-01T00:00:00Z"; db.attachments[1].status = "ready"; db.attachments[1].conversationId = "c"; db.attachments[1].createdAt = "2000-01-01T00:00:00Z"; });
  await f.service.cleanup();
  assert.equal((await f.store.read()).attachments.length, 5);
  await assert.rejects(fs.stat(first.storagePath));
});

test("PPT media does not consume text budget; dangerous XML expansion remains rejected", async () => {
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", "<a:t>第一页内容</a:t>");
  zip.file("ppt/media/image.bin", Buffer.alloc(65 * 1024 ** 2));
  const parsed = await parseAttachment(await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }), "large.pptx", "");
  assert.equal(parsed.extractedText, "[第 1 页]\n第一页内容");
  const bomb = new JSZip();
  bomb.file("ppt/slides/slide1.xml", "x".repeat(61 * 1024 ** 2));
  await assert.rejects(parseAttachment(await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), "bomb.pptx", ""), /文字结构过大/);
});

test("110 MB PPT uploads in bounded chunks and parses in the isolated worker", { skip: process.env.ONE_ATTACHMENT_STRESS !== "1", timeout: 120_000 }, async t => {
  const f = await fixture(t);
  const zip = new JSZip();
  zip.file("ppt/slides/slide1.xml", "<a:t>大型演示文稿的结论</a:t>");
  zip.file("ppt/media/image.bin", Buffer.alloc(110 * 1024 ** 2));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  const item = await f.service.create(scope, "large.pptx", bytes.length, "application/octet-stream");
  for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) await f.service.chunk(scope, item.id, offset, bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES));
  await f.service.complete(scope, item.id);
  const parsed = await ready(f.store, item.id);
  assert.equal(parsed.status, "ready", parsed.parseError);
  assert.equal((await fs.stat(item.storagePath)).size, bytes.length);
  const context = await prepareAttachmentContext([{ ...parsed, conversationId: "c" }], scope, "结论是什么", 24000, async () => { throw new Error("No summary needed"); });
  assert.match(context.text, /大型演示文稿的结论/);
});
