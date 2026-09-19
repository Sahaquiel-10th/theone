import assert from "node:assert/strict";
import test from "node:test";
import type { Store } from "../db.js";
import type { Database } from "../types.js";
import { decryptCredential, encryptCredential, knowledgeCredentialContext } from "./credentialCipher.js";
import { YinxiangService } from "./yinxiangService.js";

function fixture() { const database = { knowledgeConnections: [], auditLogs: [] } as unknown as Database; const store = { async read() { return database; }, async mutate<T>(fn: (db: Database) => T) { return fn(database); } } as Store; return { database, store }; }

test("印象笔记 OAuth1 授权加密保存、单次使用并精确绑定 workspace", async () => {
  const previousKey = process.env.YINXIANG_CONSUMER_KEY, previousSecret = process.env.YINXIANG_CONSUMER_SECRET;
  process.env.YINXIANG_CONSUMER_KEY = "consumer-key"; process.env.YINXIANG_CONSUMER_SECRET = "consumer-secret";
  try {
    const f = fixture();
    const clients: Array<{ token?: string }> = [];
    const service = new YinxiangService(f.store, { createClient: options => {
      clients.push({ token: options.token });
      return {
        getRequestToken(callback: string, done: (error: unknown, token?: string, secret?: string) => void) { assert.equal(callback, "https://one.example/api/knowledge/connections/yinxiang/oauth/callback"); done(undefined, "request-token", "request-secret"); },
        getAuthorizeUrl(token: string) { return `https://app.yinxiang.com/OAuth.action?oauth_token=${token}`; },
        getAccessToken(token: string, secret: string, verifier: string, done: (error: unknown, token?: string, secret?: string, results?: Record<string, unknown>) => void) { assert.deepEqual([token, secret, verifier], ["request-token", "request-secret", "approved"]); done(undefined, "access-secret", "", { edam_expires: String(Date.now() + 3600000) }); },
        getUserStore() { return { async getUser() { return { id: 7, username: "owner" }; }, async getUserUrls() { return { noteStoreUrl: "https://app.yinxiang.com/shard/s1/notestore" }; } }; },
        getNoteStore() { throw new Error("unused"); }
      } as never;
    } });
    const started = await service.beginAuthorization({ workspaceId: "workspace-a", userId: "user-a", appOrigin: "https://one.example" });
    assert.equal(new URL(started.authorizationUrl).hostname, "app.yinxiang.com");
    const connection = await service.completeAuthorization("request-token", "approved");
    assert.equal(connection.workspaceId, "workspace-a");
    assert.equal(decryptCredential(connection.encryptedAccessToken!, knowledgeCredentialContext("workspace-a", "yinxiang", "access_token")), "access-secret");
    assert.doesNotMatch(JSON.stringify(connection), /access-secret|request-secret/);
    await assert.rejects(service.completeAuthorization("request-token", "approved"), /无效|使用/);
    await assert.rejects(service.search("workspace-b", "private", 5), /连接印象笔记/);
    assert.deepEqual(clients.map(item => item.token), [undefined, undefined, "access-secret"]);
  } finally { if (previousKey === undefined) delete process.env.YINXIANG_CONSUMER_KEY; else process.env.YINXIANG_CONSUMER_KEY = previousKey; if (previousSecret === undefined) delete process.env.YINXIANG_CONSUMER_SECRET; else process.env.YINXIANG_CONSUMER_SECRET = previousSecret; }
});

test("印象笔记检索只调用读取方法并将 ENML 转为有界参考资料", async () => {
  const previousKey = process.env.YINXIANG_CONSUMER_KEY, previousSecret = process.env.YINXIANG_CONSUMER_SECRET;
  process.env.YINXIANG_CONSUMER_KEY = "consumer-key"; process.env.YINXIANG_CONSUMER_SECRET = "consumer-secret";
  try {
    const f = fixture();
    const service = new YinxiangService(f.store, { createClient: options => ({
      getRequestToken() {}, getAuthorizeUrl() { return ""; }, getAccessToken() {}, getUserStore() { return { async getUser() { return {}; }, async getUserUrls() { return { noteStoreUrl: "https://app.yinxiang.com/shard/s1/notestore" }; } }; },
      getNoteStore(url?: string) { assert.equal(options.token, "read-token"); assert.equal(url, "https://app.yinxiang.com/shard/s1/notestore"); return { async findNotesMetadata(filter: Record<string, unknown>, offset: number, maxNotes: number, spec: Record<string, unknown>) { assert.deepEqual({ filter, offset, maxNotes, spec }, { filter: { words: "项目", inactive: false, includeAllReadableNotebooks: true }, offset: 0, maxNotes: 3, spec: { includeTitle: true } }); return { notes: [{ guid: "abcd-note", title: "计划" }] }; }, async getNote(guid: string, withContent: boolean, data: boolean, recognition: boolean, alternate: boolean) { assert.deepEqual([guid, withContent, data, recognition, alternate], ["abcd-note", true, false, false, false]); return { guid, title: "计划", content: "<en-note><div>第一行</div><div>第二行</div></en-note>" }; } }; }
    }) as never });
    f.database.knowledgeConnections.push({ id: "yinxiang-a", workspaceId: "workspace-a", provider: "yinxiang", status: "connected", clientId: "consumer-key", encryptedAccessToken: encryptCredential("read-token", knowledgeCredentialContext("workspace-a", "yinxiang", "access_token")), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const chunks = await service.search("workspace-a", "项目", 3);
    assert.equal(chunks[0].provider, "yinxiang");
    assert.equal(chunks[0].content, "第一行\n第二行");
  } finally { if (previousKey === undefined) delete process.env.YINXIANG_CONSUMER_KEY; else process.env.YINXIANG_CONSUMER_KEY = previousKey; if (previousSecret === undefined) delete process.env.YINXIANG_CONSUMER_SECRET; else process.env.YINXIANG_CONSUMER_SECRET = previousSecret; }
});

test("印象笔记拒绝平台返回的非官方 NoteStore 地址", async () => {
  const previousKey = process.env.YINXIANG_CONSUMER_KEY, previousSecret = process.env.YINXIANG_CONSUMER_SECRET;
  process.env.YINXIANG_CONSUMER_KEY = "consumer-key"; process.env.YINXIANG_CONSUMER_SECRET = "consumer-secret";
  try {
    const f = fixture(); let noteStoreCalled = false;
    const service = new YinxiangService(f.store, { createClient: () => ({ getRequestToken() {}, getAuthorizeUrl() { return ""; }, getAccessToken() {}, getUserStore() { return { async getUser() { return {}; }, async getUserUrls() { return { noteStoreUrl: "https://attacker.example/notestore" }; } }; }, getNoteStore() { noteStoreCalled = true; throw new Error("must not connect"); } }) as never });
    f.database.knowledgeConnections.push({ id: "yinxiang-a", workspaceId: "workspace-a", provider: "yinxiang", status: "connected", clientId: "consumer-key", encryptedAccessToken: encryptCredential("read-token", knowledgeCredentialContext("workspace-a", "yinxiang", "access_token")), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await assert.rejects(service.search("workspace-a", "private", 3), /无效的读取地址/);
    assert.equal(noteStoreCalled, false);
  } finally { if (previousKey === undefined) delete process.env.YINXIANG_CONSUMER_KEY; else process.env.YINXIANG_CONSUMER_KEY = previousKey; if (previousSecret === undefined) delete process.env.YINXIANG_CONSUMER_SECRET; else process.env.YINXIANG_CONSUMER_SECRET = previousSecret; }
});
