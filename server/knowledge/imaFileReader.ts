import { fork } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertAllowedConnectorUrl } from "../connectors/securityPolicy.js";

// Expand only after reviewing an actual official media response. No URL/host
// supplied by the browser, model or a customer can change this list.
export const imaFileHosts: readonly string[] = ["pkb.ima.myqcloud.com"];
export const imaFileMaxBytes = 12 * 1024 * 1024;
const fileIssues = new Set(["IMA_FILE_HEADERS_DENIED", "IMA_FILE_HOST_DENIED", "IMA_FILE_TOO_LARGE", "IMA_FILE_EMPTY", "IMA_FILE_UNAVAILABLE", "IMA_FILE_PARSE_UNAVAILABLE", "IMA_FILE_RUNTIME_UNSUPPORTED", "IMA_FILE_HTTP_401", "IMA_FILE_HTTP_403", "IMA_FILE_HTTP_404", "IMA_FILE_HTTP_429"]);
export function imaFileIssue(error: unknown) { return error instanceof Error && fileIssues.has(error.message) ? error.message : "IMA_FILE_DOWNLOAD_OR_PARSE_UNAVAILABLE"; }
let active = 0;
export type ImaFileFormat = "pdf" | "docx" | "txt";
export function imaFileFormat(mediaType: unknown, title: string): ImaFileFormat | undefined {
  if (mediaType === 1) return "pdf";
  if (mediaType === 3 && /\.docx$/i.test(title)) return "docx";
  if ([7, 13].includes(Number(mediaType))) return "txt";
}

async function boundedBytes(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (!response.ok || declared > imaFileMaxBytes || !response.body) { await response.body?.cancel(); throw Error(!response.ok ? `IMA_FILE_HTTP_${response.status}` : declared > imaFileMaxBytes ? "IMA_FILE_TOO_LARGE" : "IMA_FILE_EMPTY"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const value = await reader.read(); if (value.done) break; size += value.value.byteLength; if (size > imaFileMaxBytes) { await reader.cancel(); throw Error("IMA_FILE_TOO_LARGE"); } chunks.push(value.value); }
  } finally { reader.releaseLock(); }
  if (!size) throw Error("IMA_FILE_EMPTY");
  return Buffer.concat(chunks, size);
}

export async function parseImaFile(bytes: Buffer, format: ImaFileFormat, query: string, signal: AbortSignal): Promise<string> {
  if (!bytes.length || bytes.length > imaFileMaxBytes || !["pdf", "docx", "txt"].includes(format) || signal.aborted) throw Error("IMA_FILE_UNAVAILABLE");
  const workerPath = fileURLToPath(new URL("./imaFileWorker.cjs", import.meta.url));
  const modules = await fs.realpath(fileURLToPath(new URL("../../node_modules", import.meta.url)));
  const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 20) throw Error("IMA_FILE_RUNTIME_UNSUPPORTED");
  const permissionFlag = major > 22 || major === 22 && minor >= 13 ? "--permission" : "--experimental-permission";
  return new Promise((resolve, reject) => {
    // No provider token, URL, workspace DB, writable directory or inherited
    // application environment is passed to the parser. Node permissions are an
    // additional guard, not a claim of an OS/container security sandbox.
    const worker = fork(workerPath, [], { serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"], env: { NODE_ENV: "production" }, execArgv: [permissionFlag, `--allow-fs-read=${modules}`, `--allow-fs-read=${packagePath}`, "--max-old-space-size=256", "--disallow-code-generation-from-strings"] });
    let settled = false;
    const finish = (text?: string) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort); worker.kill("SIGKILL"); if (typeof text === "string" && text.trim() && text.length <= 24_000) resolve(text); else reject(Error("IMA_FILE_PARSE_UNAVAILABLE")); };
    const abort = () => finish();
    const timer = setTimeout(abort, 10_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.once("error", abort); worker.once("exit", abort);
    worker.once("message", value => { const result = value as { text?: unknown }; finish(typeof result?.text === "string" ? result.text : undefined); });
    worker.send({ bytes, format, query: query.slice(0, 400) }, error => { if (error) abort(); });
    if (signal.aborted) abort();
  });
}

export async function readImaFile(input: { url: unknown; headers: unknown; mediaType: unknown; title: string; query: string; signal: AbortSignal }, fetcher: typeof fetch = fetch): Promise<string> {
  if (active >= 2) throw Error("IMA_FILE_BUSY");
  const format = imaFileFormat(input.mediaType, input.title);
  if (!format || typeof input.url !== "string") throw Error("IMA_FILE_UNAVAILABLE");
  let url: URL;
  try { url = assertAllowedConnectorUrl(input.url, imaFileHosts); } catch { throw Error("IMA_FILE_HOST_DENIED"); }
  const headers = new Headers();
  if (input.headers !== undefined && (typeof input.headers !== "object" || input.headers === null || Array.isArray(input.headers))) throw Error("IMA_FILE_HEADERS_DENIED");
  const entries = Object.entries(input.headers ?? {});
  if (entries.length > 12) throw Error("IMA_FILE_HEADERS_DENIED");
  for (const [name, value] of entries) {
    if (typeof value !== "string" || value.length > 8192 || /[\r\n]/.test(value)) throw Error("IMA_FILE_HEADERS_DENIED");
    if (name.toLowerCase() === "host" && value.toLowerCase() === url.host) continue; // fetch supplies the validated Host itself.
    if (!["authorization", "date", "content-type", "content-md5", "x-cos-security-token", "x-cos-server-side-encryption-customer-algorithm", "x-cos-server-side-encryption-customer-key", "x-cos-server-side-encryption-customer-key-md5"].includes(name.toLowerCase())) throw Error("IMA_FILE_HEADERS_DENIED");
    headers.set(name, value);
  }
  active++;
  try {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]);
    const response = await fetcher(url, { method: "GET", headers, redirect: "error", signal });
    const bytes = await boundedBytes(response);
    try { return await parseImaFile(bytes, format, input.query, signal); }
    finally { bytes.fill(0); }
  } finally { active--; }
}
