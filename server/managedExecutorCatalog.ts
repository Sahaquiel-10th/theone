import crypto from "node:crypto";
import { compareRuntimeVersions, validRuntimeVersion, type RuntimeIdentity, type SignedRuntimeUpdate } from "./runtimeUpdate.js";

// Separate signed domain: a launcher release must never authorize a tool install.
export type ManagedExecutorRelease = {
  executor: "codex";
  version: string;
  platform: RuntimeIdentity["platform"];
  architecture: RuntimeIdentity["architecture"];
  url: string;
  sourceUrl: string;
  sha256: string;
  size: number;
  entrypoint: string;
  license: "Apache-2.0";
  licenseFiles: string[];
};
export type ManagedExecutorCatalog = {
  kind: "one-managed-executors";
  schemaVersion: 1;
  releasedAt: string;
  releases: ManagedExecutorRelease[];
};

function fail(): never { throw new Error("ONE_EXECUTOR_CATALOG_INVALID"); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return fail();
  return result;
}
function packagePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 240 || !/^[a-zA-Z0-9_./-]+$/.test(value)
      || value.split("/").some(part => !part || part === "." || part === "..")) return fail();
  return value;
}
function cleanUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2048) return fail();
  let url: URL;
  try { url = new URL(value); } catch { return fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return fail();
  return url;
}

// Origins come from trusted deployment policy, never a browser or model response.
// Verification authorizes metadata only. Installer must additionally hash the
// bytes, reject unsafe archive paths/symlinks and check LICENSE/NOTICE contents.
export function verifyManagedExecutorCatalog(
  envelope: SignedRuntimeUpdate, publicKeyRaw: string, downloadOrigins: readonly string[]
): ManagedExecutorCatalog {
  if (!envelope || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") return fail();
  const bytes = Buffer.from(envelope.payload, "base64url");
  const signature = Buffer.from(envelope.signature, "base64url");
  const rawKey = Buffer.from(publicKeyRaw, "base64url");
  if (!bytes.length || bytes.length > 128 * 1024 || signature.length !== 64 || rawKey.length !== 32) return fail();
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]), format: "der", type: "spki"
  });
  if (!crypto.verify(null, bytes, key, signature)) throw new Error("ONE_EXECUTOR_SIGNATURE_INVALID");
  let decoded: unknown;
  try { decoded = JSON.parse(bytes.toString("utf8")); } catch { return fail(); }
  const payload = record(decoded, ["kind", "schemaVersion", "releasedAt", "releases"]);
  if (payload.kind !== "one-managed-executors" || payload.schemaVersion !== 1
      || typeof payload.releasedAt !== "string" || !Number.isFinite(Date.parse(payload.releasedAt))
      || !Array.isArray(payload.releases) || !payload.releases.length || payload.releases.length > 24) return fail();
  const origins = new Set(downloadOrigins.map(value => {
    const url = cleanUrl(value);
    if (url.pathname !== "/") return fail();
    return url.origin;
  }));
  const releases = payload.releases.map(value => {
    const item = record(value, ["executor", "version", "platform", "architecture", "url", "sourceUrl", "sha256", "size", "entrypoint", "license", "licenseFiles"]);
    // Additional tools require a reviewed adapter and distribution policy.
    if (item.executor !== "codex" || item.license !== "Apache-2.0" || !validRuntimeVersion(item.version)) return fail();
    if (item.platform !== "macos" && item.platform !== "windows") return fail();
    if (item.platform === "macos" ? !["arm64", "x86_64"].includes(String(item.architecture)) : item.architecture !== "amd64") return fail();
    const url = cleanUrl(item.url);
    const source = cleanUrl(item.sourceUrl);
    if (!origins.has(url.origin) || source.origin !== "https://github.com"
        || !source.pathname.startsWith("/openai/codex/releases/download/")
        || source.pathname.split("/").some(part => part === "..")) return fail();
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)
        || !Number.isSafeInteger(item.size) || Number(item.size) <= 0 || Number(item.size) > 512 * 1024 * 1024) return fail();
    if (!Array.isArray(item.licenseFiles) || !item.licenseFiles.length || item.licenseFiles.length > 24) return fail();
    const licenseFiles = item.licenseFiles.map(packagePath);
    if (new Set(licenseFiles).size !== licenseFiles.length || !licenseFiles.some(path => /(^|\/)LICENSE(?:\.(?:txt|md))?$/.test(path))) return fail();
    return {
      executor: "codex", version: item.version, platform: item.platform,
      architecture: item.architecture, url: url.toString(), sourceUrl: source.toString(),
      sha256: item.sha256, size: Number(item.size), entrypoint: packagePath(item.entrypoint),
      license: "Apache-2.0", licenseFiles
    } as ManagedExecutorRelease;
  });
  const identities = releases.map(item => `${item.executor}:${item.platform}:${item.architecture}:${item.version}`);
  if (new Set(identities).size !== identities.length) return fail();
  return { kind: "one-managed-executors", schemaVersion: 1, releasedAt: payload.releasedAt, releases };
}

export function planManagedExecutorPreparation(
  catalog: ManagedExecutorCatalog,
  device: Pick<RuntimeIdentity, "platform" | "architecture">,
  state: { installedVersion?: string; activeExecutions: number }
): { action: "unavailable" | "defer" | "keep" } | { action: "prepare"; release: ManagedExecutorRelease } {
  if (!Number.isSafeInteger(state.activeExecutions) || state.activeExecutions < 0) return fail();
  const release = catalog.releases.filter(item => item.platform === device.platform && item.architecture === device.architecture)
    .sort((a, b) => compareRuntimeVersions(b.version, a.version))[0];
  if (!release) return { action: "unavailable" };
  if (state.installedVersion && compareRuntimeVersions(state.installedVersion, release.version) >= 0) return { action: "keep" };
  if (state.activeExecutions) return { action: "defer" };
  return { action: "prepare", release };
}
