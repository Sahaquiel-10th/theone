// Explicit integration smoke test. Uses the inserted key, never prints credentials.
import fs from "node:fs";
import crypto from "node:crypto";
const credential = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const base = credential.serverBaseUrl.replace(/\/$/, "");
let cookie = "";
async function request(path, body) {
  const response = await fetch(base + path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${value.error || ""}`);
  const session = response.headers.get("set-cookie");
  if (session) cookie = session.split(";")[0];
  return value;
}
const challenge = await request("/api/one-key/challenge", { deviceId: credential.deviceId });
const key = crypto.createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", d: credential.privateKeyRaw, x: credential.publicKeyRaw } });
const signature = crypto.sign(null, Buffer.from(challenge.nonce, "base64url"), key).toString("base64url");
const verified = await request(`/api/one-key/challenge/${challenge.challengeId}/verify`, { signature });
await request("/api/auth/one-key/redeem", { loginCode: verified.loginCode });
const models = await request("/api/models");
const model = models.models.find((item) => item.kind === "chat");
if (!model) throw new Error("没有可用聊天模型");
const chat = await request("/api/chat", { modelId: model.id, content: "ONE 与 Codex 联调：请在用户选择的工作目录中创建 one-codex-smoke.txt，内容为 ONE_CODEX_OK。只执行这一项测试文件写入。不读取其他文件，不运行无关命令，不访问网络。如果文件已经存在则停止，不覆盖。" });
const conversation = chat.conversation;
const source = conversation.messages.find((item) => item.role === "user");
const result = await request("/api/executions/from-message", { conversationId: conversation.id, sourceMessageId: source.id });
console.log(JSON.stringify({ taskId: result.task.id, conversationId: conversation.id, status: result.task.status }));
const trace = await request(`/api/executions/${result.task.id}/trace`);
if (!JSON.stringify(trace).includes("ONE_CODEX_OK")) throw new Error("执行上下文调试未包含测试指令");
let finished = false;
let lastSnapshot = "";
for (let count = 0; count < 90; count++) {
  const detail = await request(`/api/executions/${result.task.id}`);
  const snapshot = JSON.stringify({ status: detail.task.status, targetName: detail.task.targetName, events: detail.events.map((item) => ({ kind: item.kind, text: item.text })) });
  if (snapshot !== lastSnapshot) console.log(snapshot);
  lastSnapshot = snapshot;
  if (["completed", "failed", "cancelled"].includes(detail.task.status)) {
    finished = true;
    process.exitCode = detail.task.status === "completed" ? 0 : 1;
    if (process.argv[3]) {
      const actual = fs.readFileSync(process.argv[3], "utf8").trimEnd();
      if (actual !== "ONE_CODEX_OK") throw new Error("Codex 已结束但测试文件内容不正确");
      console.log("本地测试文件内容验证成功");
    }
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
}
if (!finished) throw new Error("等待 Codex 执行结果超时，不能判定测试成功");
