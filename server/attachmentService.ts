import fs from "node:fs/promises";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Store } from "./db.js";
import type { Attachment } from "./types.js";
import { uid } from "./security.js";
import { isSupportedAttachment, safeAttachmentExtension } from "./attachmentParser.js";

export const ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 4 * 1024 * 1024;
export const ATTACHMENT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
type Scope = { workspaceId: string; userId: string };
export function ownedAttachment(items: Attachment[], scope: Scope, id: string) {
  const item = items.find(a => a.id === id && a.workspaceId === scope.workspaceId && a.userId === scope.userId);
  if (!item) throw new Error("附件不存在或无权访问");
  return item;
}
export async function removeAttachmentFiles(storagePath: string) {
  await Promise.all(["", ".segments", ".segments.tmp"].map(suffix => fs.rm(storagePath + suffix, { force: true })));
}

export class AttachmentService {
  private running = false;
  private locks = new Set<string>();
  constructor(private store: Store, private directory: string) {}
  async recover() {
    await this.store.mutate(db => {
      for (const item of db.attachments) if (item.status === "parsing") item.status = "queued";
    });
    await this.cleanup();
    void this.pump();
  }
  async cleanup() {
    const removed: Attachment[] = [];
    await this.store.mutate(db => {
      db.attachments = db.attachments.filter(item => {
        // Only incomplete uploads expire. Never remove user conversation files.
        if (item.status !== "uploading" || this.locks.has(item.id) || Date.now() - Date.parse(item.createdAt) < 24 * 3600_000) return true;
        removed.push(item); return false;
      });
    });
    await Promise.all(removed.map(item => removeAttachmentFiles(item.storagePath)));
  }
  async create(scope: Scope, filename: unknown, size: unknown, mimeType: unknown) {
    if (typeof filename !== "string" || !isSupportedAttachment(filename)) throw new Error("请选择支持的文件格式");
    if (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > ATTACHMENT_MAX_BYTES) throw new Error("单个附件应为 1 字节至 200 MB");
    const image = /\.(png|jpe?g|webp|gif)$/i.test(filename);
    if (image && Number(size) > ATTACHMENT_IMAGE_MAX_BYTES) throw new Error("单张图片不能超过 20 MB，请压缩后上传");
    const space = await fs.statfs(this.directory);
    if (space.bavail * space.bsize < Number(size) + 2 * 1024 ** 3) throw new Error("附件存储空间不足，请稍后重试或联系管理员");
    const id = uid("att");
    const extension = safeAttachmentExtension(filename);
    const originalName = path.basename(filename, path.extname(filename)).slice(0, 180 - extension.length) + extension;
    const item: Attachment = { id, workspaceId: scope.workspaceId, userId: scope.userId, originalName, size: Number(size), mimeType: typeof mimeType === "string" ? mimeType.slice(0, 180) : "application/octet-stream", kind: image ? "image" : "document", storagePath: path.join(this.directory, `${id}${extension}`), extractedText: "", createdAt: new Date().toISOString(), status: "uploading", uploadedBytes: 0 };
    await this.store.mutate(db => {
      const mine = db.attachments.filter(a => a.workspaceId === scope.workspaceId && a.userId === scope.userId);
      if (mine.filter(a => a.status && ["uploading", "queued", "parsing"].includes(a.status)).length >= 5) throw new Error("最多同时处理 5 个附件，请稍后继续");
      if (mine.reduce((n, a) => n + a.size, 0) + item.size > 5 * 1024 ** 3) throw new Error("附件总量已达 5 GB，请删除不需要的对话后继续");
      const pending = db.attachments.filter(a => a.status === "uploading").reduce((n, a) => n + a.size, 0);
      if (space.bavail * space.bsize < pending + item.size + 2 * 1024 ** 3) throw new Error("上传任务较多，请稍后再试");
      db.attachments.push(item);
    });
    try { await fs.writeFile(item.storagePath, "", { flag: "wx", mode: 0o600 }); }
    catch (error) { await this.store.mutate(db => { db.attachments = db.attachments.filter(a => a.id !== id); }); throw error; }
    return item;
  }
  async chunk(scope: Scope, id: string, offset: number, bytes: Buffer) {
    if (this.locks.has(id)) throw new Error("附件正在写入，请稍后重试");
    this.locks.add(id);
    try {
      const item = ownedAttachment((await this.store.read()).attachments, scope, id);
      if (item.status !== "uploading" || !Number.isSafeInteger(offset) || offset !== item.uploadedBytes || !bytes.length || bytes.length > ATTACHMENT_CHUNK_BYTES || offset + bytes.length > item.size) throw new Error("上传进度不一致，请重试这个文件");
      const space = await fs.statfs(this.directory);
      if (space.bavail * space.bsize < bytes.length + 1024 ** 3) throw new Error("附件存储空间不足，请稍后重试");
      const file = await fs.open(item.storagePath, "r+");
      try {
        await file.truncate(offset); // Recover a crash between disk write and metadata commit.
        let written = 0;
        while (written < bytes.length) written += (await file.write(bytes, written, bytes.length - written, offset + written)).bytesWritten;
        await file.sync();
      } finally { await file.close(); }
      await this.store.mutate(db => { ownedAttachment(db.attachments, scope, id).uploadedBytes = offset + bytes.length; });
      return offset + bytes.length;
    } finally { this.locks.delete(id); }
  }
  async complete(scope: Scope, id: string) {
    if (this.locks.has(id)) throw new Error("附件正在写入，请稍后重试");
    await this.store.mutate(db => {
      const item = ownedAttachment(db.attachments, scope, id);
      if (item.status !== "uploading") return;
      if (item.uploadedBytes !== item.size) throw new Error("附件尚未上传完成");
      item.status = "queued";
      db.auditLogs?.push({ id: uid("aud"), workspaceId: scope.workspaceId, actorUserId: scope.userId, action: "attachment.uploaded", targetType: "attachment", targetId: id, details: { bytes: item.size }, createdAt: new Date().toISOString() });
    });
    void this.pump();
  }
  async retry(scope: Scope, id: string) {
    await this.store.mutate(db => {
      const item = ownedAttachment(db.attachments, scope, id);
      if (item.status !== "failed") throw new Error("这个附件不需要重试");
      item.status = "queued"; item.parseError = undefined;
    });
    void this.pump();
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const item = (await this.store.read()).attachments.find(a => a.status === "queued");
        if (!item) break;
        await this.store.mutate(db => { const target = db.attachments.find(a => a.id === item.id); if (target) target.status = "parsing"; });
        const result = await this.parse(item);
        let retained = false;
        await this.store.mutate(db => {
          const target = db.attachments.find(a => a.id === item.id);
          if (!target) return;
          retained = true;
          if (result.ok) Object.assign(target, { kind: result.kind, mimeType: result.mimeType, textChars: result.textChars, segmentCount: result.segmentCount, status: "ready", parseError: undefined });
          else Object.assign(target, { status: "failed", parseError: result.error });
        });
        if (!retained) await removeAttachmentFiles(item.storagePath);
      }
    } catch { /* Persistence failure: leave pending state for recovery, never publish partial text. */ }
    finally { this.running = false; }
  }
  private parse(item: Attachment): Promise<{ ok: boolean; kind?: Attachment["kind"]; mimeType?: string; textChars?: number; segmentCount?: number; error?: string }> {
    return new Promise(resolve => {
      const worker = fork(fileURLToPath(new URL("./attachmentWorker.ts", import.meta.url)), [item.storagePath, item.originalName, item.mimeType], { execArgv: ["--max-old-space-size=256", "--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url))], stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV } });
      let result: Parameters<typeof resolve>[0] = { ok: false, error: "解析未完成：文件过于复杂或超出资源限制，请拆分后重试" };
      const timeout = setTimeout(() => worker.kill("SIGKILL"), 120_000);
      worker.on("message", value => { result = value as typeof result; });
      worker.on("error", () => { clearTimeout(timeout); resolve(result); });
      worker.on("exit", () => { clearTimeout(timeout); resolve(result); });
    });
  }
}
