import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { createHash } from "node:crypto";

export class StandardToolError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new StandardToolError(code); };
const object = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("INVALID_DEFINITION");
  return v as Record<string, any>;
};
function keys(v: Record<string, any>, allowed: string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) fail("UNSUPPORTED_DEFINITION");
}
type ScalarSchema = { type: "string" | "number" | "integer" | "boolean" };
type Fields = Record<string, ScalarSchema>;
export type HttpTool = {
  id: string; endpoint: string; input: Fields; required: string[];
  output: Fields; outputRequired: string[]; digest: string;
};
export function httpToolDigest(tool: Omit<HttpTool, "digest">) {
  const { id, endpoint, input, required, output, outputRequired } = tool;
  return createHash("sha256").update(JSON.stringify({ id, endpoint, input, required, output, outputRequired })).digest("hex");
}
function scalar(value: unknown): ScalarSchema {
  const s = object(value); keys(s, ["type", "description"]);
  if (!["string", "number", "integer", "boolean"].includes(s.type)) fail("UNSUPPORTED_SCHEMA");
  return { type: s.type };
}
function safeName(name: string) {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name) || ["constructor", "prototype", "__proto__"].includes(name)) fail("INVALID_FIELD");
}

/** Deliberately narrow OpenAPI 3.1 subset. Parsing is NOT approval. No URL fetch,
 * refs, secrets, servers overrides, write operations or executable extensions.
 * allowedEndpoints comes from reviewed SERVER configuration, never the document.
 */
export function importReadOnlyOperation(document: unknown, operationId: string, allowedEndpoints: readonly string[]): HttpTool {
  const d = object(document);
  keys(d, ["openapi", "info", "servers", "paths"]);
  if (!/^3\.1\.\d+$/.test(d.openapi) || !Array.isArray(d.servers) || d.servers.length !== 1) fail("UNSUPPORTED_DEFINITION");
  const server = object(d.servers[0]); keys(server, ["url", "description"]);
  const origin = new URL(server.url);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.port || origin.pathname !== "/" || isIP(origin.hostname)) fail("UNSAFE_ENDPOINT");
  const candidates: HttpTool[] = [];
  for (const [path, value] of Object.entries(object(d.paths))) {
    if (!/^\/[a-zA-Z0-9/_-]*$/.test(path) || path.includes("//")) fail("UNSUPPORTED_PATH");
    const item = object(value); keys(item, ["get"]);
    const op = object(item.get); keys(op, ["operationId", "summary", "description", "parameters", "responses"]);
    if (typeof op.operationId !== "string") fail("INVALID_OPERATION");
    safeName(op.operationId);
    const endpoint = new URL(path, origin).href;
    if (!allowedEndpoints.includes(endpoint)) fail("ENDPOINT_NOT_APPROVED");
    const input: Fields = {}, required: string[] = [];
    if (op.parameters !== undefined && !Array.isArray(op.parameters)) fail("INVALID_PARAMETERS");
    for (const value of op.parameters ?? []) {
      const p = object(value); keys(p, ["name", "in", "required", "schema", "description"]);
      if (typeof p.name !== "string" || p.in !== "query" || (p.required !== undefined && typeof p.required !== "boolean")) fail("UNSUPPORTED_PARAMETER");
      safeName(p.name);
      if (Object.hasOwn(input, p.name)) fail("DUPLICATE_PARAMETER");
      input[p.name] = scalar(p.schema); if (p.required) required.push(p.name);
    }
    const responses = object(op.responses); keys(responses, ["200"]);
    const response = object(responses["200"]); keys(response, ["description", "content"]);
    const content = object(response.content); keys(content, ["application/json"]);
    const media = object(content["application/json"]); keys(media, ["schema"]);
    const schema = object(media.schema); keys(schema, ["type", "properties", "required", "additionalProperties", "description"]);
    if (schema.type !== "object" || schema.additionalProperties !== false) fail("UNSUPPORTED_SCHEMA");
    const output: Fields = {};
    for (const [name, field] of Object.entries(object(schema.properties))) { safeName(name); output[name] = scalar(field); }
    const outputRequired = schema.required ?? [];
    if (!Array.isArray(outputRequired) || outputRequired.some(k => typeof k !== "string" || !Object.hasOwn(output, k))) fail("UNSUPPORTED_SCHEMA");
    if (Object.keys(input).length > 20 || Object.keys(output).length > 50) fail("SCHEMA_TOO_LARGE");
    const definition = { id: op.operationId, endpoint, input, required, output, outputRequired };
    candidates.push({ ...definition, digest: httpToolDigest(definition) });
  }
  const matches = candidates.filter(c => c.id === operationId);
  if (matches.length !== 1) fail("OPERATION_NOT_UNIQUE");
  return matches[0];
}
export function validateFields(value: unknown, fields: Fields, required: string[]) {
  const v = object(value); keys(v, Object.keys(fields));
  if (required.some(k => !Object.hasOwn(v, k))) fail("MISSING_FIELD");
  const result: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(v).sort()) {
    const item = v[key], type = fields[key].type;
    if (type === "integer" ? !Number.isSafeInteger(item) : typeof item !== type) fail("INVALID_FIELD_TYPE");
    if (typeof item === "number" && !Number.isFinite(item)) fail("INVALID_FIELD_TYPE");
    if (typeof item === "string" && item.length > 8000) fail("FIELD_TOO_LARGE");
    result[key] = item;
  }
  return result;
}

// Conservative IPv4-only egress: reserved/private/link-local/metadata networks
// cannot be used. IPv6 support needs its own reviewed address policy.
export function publicIpv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export type JsonTransport = (url: URL, signal: AbortSignal) => Promise<unknown>;
export function createFixedHttpsJson(dependencies = { resolve4, request }): JsonTransport {
 return async (url, signal) => {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || isIP(url.hostname)) fail("UNSAFE_ENDPOINT");
  if (!url.hostname.includes(".") || /\.(localhost|local|internal)\.?$/i.test(url.hostname)) fail("UNSAFE_ADDRESS");
  const addresses = await dependencies.resolve4(url.hostname);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(a => !publicIpv4(a))) fail("UNSAFE_ADDRESS");
  return new Promise((resolve, reject) => {
    // Pin the checked IP; TLS still verifies the original hostname. No proxy,
    // redirects, cookies, compression, credential forwarding or connection reuse.
    const req = dependencies.request(url, { method: "GET", agent: false, signal, family: 4,
      lookup: (_host, _options, callback) => callback(null, addresses[0], 4),
      headers: { Accept: "application/json", "Accept-Encoding": "identity" } }, res => {
      if (res.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(String(res.headers["content-type"]))) {
        res.destroy(); reject(new StandardToolError("INVALID_HTTP_RESPONSE")); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 262144) { res.destroy(new StandardToolError("RESULT_TOO_LARGE")); return; }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new StandardToolError("INVALID_JSON")); } });
    });
    req.on("error", reject); req.end();
  });
 };
}
export const fixedHttpsJson = createFixedHttpsJson();
export async function callReadOnlyHttp(tool: HttpTool, input: unknown, transport: JsonTransport = fixedHttpsJson, timeoutMs = 10000) {
  if (httpToolDigest(tool) !== tool.digest) fail("TOOL_DEFINITION_CHANGED");
  const values = validateFields(input, tool.input, tool.required);
  const url = new URL(tool.endpoint);
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([transport(url, controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new StandardToolError("TOOL_TIMEOUT")); }, timeoutMs);
    })]);
    return validateFields(result, tool.output, tool.outputRequired);
  } catch (error) {
    // Never echo a remote body, query, hostname or credentials into API/logs.
    throw error instanceof StandardToolError ? error : new StandardToolError("TOOL_UNAVAILABLE");
  } finally { clearTimeout(timer); controller.abort(); }
}
