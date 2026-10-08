import "dotenv/config";
import fs from "node:fs";
import { decryptCredential } from "../server/knowledge/credentialCipher.js";
import type { ModelConfig } from "../server/types.js";
import { parseProviderUsage } from "../server/modelGateway.js";

// Explicit diagnostic: one tiny, synthetic supplier call, no local task or
// production ledger changes. Never print credentials, provider URL or body.
async function main() {
  const db = JSON.parse(fs.readFileSync(process.argv[2] || "data/db.json", "utf8"));
  const model = (db.models as ModelConfig[]).find(item => item.enabled && item.kind === "chat" && item.protocol === "openai" && (!process.argv[3] || item.id === process.argv[3]));
  if (!model) throw Error("No configured chat model");
  const key = model.encryptedApiKey ? decryptCredential(model.encryptedApiKey) : model.apiKey;
  if (!key) throw Error("No configured credential");
  const endpoint = new URL(`${model.baseUrl.replace(/\/$/, "")}/responses`);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error("Invalid endpoint");
  const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: model.model, input: "Reply with ONE_PROVIDER_OK only. Do not use tools.", stream: true, store: false, max_output_tokens: 3000 }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) { console.log(JSON.stringify({ stage: "supplier_responses", httpStatus: response.status, passed: false })); process.exitCode = 1; return; }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) throw Error("Not SSE");
  let pending = "", bytes = 0, completed = false, marker = false, usage: ReturnType<typeof parseProviderUsage>;
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length; if (bytes > 512 * 1024) throw Error("Oversized response");
      pending = (pending + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
        const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
        if (!data || data === "[DONE]") continue;
        const event = JSON.parse(data);
        if (event.type === "response.completed") {
          completed = event.response?.status === "completed";
          marker = JSON.stringify(event.response?.output).includes("ONE_PROVIDER_OK");
          usage = parseProviderUsage(event.response?.usage);
        }
      }
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const passed = completed && marker && Boolean(usage);
  console.log(JSON.stringify({ stage: "supplier_responses", modelId: model.id, completed, marker, usageReported: Boolean(usage), passed }));
  if (!passed) process.exitCode = 1;
}
main().catch(() => { console.error("Supplier Responses probe failed; no automatic retry. Credentials and upstream body were not logged."); process.exitCode = 1; });
