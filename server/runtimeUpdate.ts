import crypto from "node:crypto";
import fs from "node:fs";

export type RuntimePlatform = "macos" | "windows";
export type RuntimeArchitecture = "arm64" | "x86_64" | "amd64";

export type RuntimeIdentity = {
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture;
  version: string;
  updateProtocol: number;
};

export type RuntimeUpdateArtifact = {
  platform: RuntimePlatform;
  architecture: RuntimeArchitecture | "universal";
  version: string;
  url: string;
  sha256: string;
  size: number;
};

export type RuntimeUpdatePayload = {
  schemaVersion: 1;
  channel: "stable";
  releasedAt: string;
  artifacts: RuntimeUpdateArtifact[];
};

export type SignedRuntimeUpdate = { payload: string; signature: string };

const ed25519SpkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
const versionPattern = /^(0|[1-9]\d*)(?:\.(0|[1-9]\d*)){1,3}$/;

export function validRuntimeVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && versionPattern.test(value);
}

export function compareRuntimeVersions(left: string, right: string) {
  if (!validRuntimeVersion(left) || !validRuntimeVersion(right)) throw new Error("ONE_RUNTIME_VERSION_INVALID");
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function releasePublicKey(raw: string) {
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) throw new Error("ONE_UPDATE_PUBLIC_KEY_INVALID");
  return crypto.createPublicKey({ key: Buffer.concat([ed25519SpkiPrefix, bytes]), format: "der", type: "spki" });
}

function parseArtifact(value: unknown): RuntimeUpdateArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ONE_UPDATE_ARTIFACT_INVALID");
  const item = value as Record<string, unknown>;
  if (item.platform !== "macos" && item.platform !== "windows") throw new Error("ONE_UPDATE_PLATFORM_INVALID");
  if (!(["arm64", "x86_64", "amd64", "universal"] as unknown[]).includes(item.architecture)) throw new Error("ONE_UPDATE_ARCHITECTURE_INVALID");
  if (!validRuntimeVersion(item.version)) throw new Error("ONE_UPDATE_VERSION_INVALID");
  if (typeof item.url !== "string" || item.url.length > 2048) throw new Error("ONE_UPDATE_URL_INVALID");
  const url = new URL(item.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("ONE_UPDATE_URL_INVALID");
  if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error("ONE_UPDATE_HASH_INVALID");
  if (!Number.isSafeInteger(item.size) || Number(item.size) <= 0 || Number(item.size) > 512 * 1024 * 1024) throw new Error("ONE_UPDATE_SIZE_INVALID");
  return {
    platform: item.platform,
    architecture: item.architecture as RuntimeUpdateArtifact["architecture"],
    version: item.version,
    url: url.toString(),
    sha256: item.sha256,
    size: Number(item.size)
  };
}

export function verifyRuntimeUpdateEnvelope(envelope: SignedRuntimeUpdate, publicKeyRaw: string): RuntimeUpdatePayload {
  if (!envelope || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("ONE_UPDATE_MANIFEST_INVALID");
  const payloadBytes = Buffer.from(envelope.payload, "base64url");
  const signature = Buffer.from(envelope.signature, "base64url");
  if (!payloadBytes.length || payloadBytes.length > 128 * 1024 || signature.length !== 64) throw new Error("ONE_UPDATE_MANIFEST_INVALID");
  if (!crypto.verify(null, payloadBytes, releasePublicKey(publicKeyRaw), signature)) throw new Error("ONE_UPDATE_SIGNATURE_INVALID");
  let raw: unknown;
  try { raw = JSON.parse(payloadBytes.toString("utf8")); }
  catch { throw new Error("ONE_UPDATE_PAYLOAD_INVALID"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ONE_UPDATE_PAYLOAD_INVALID");
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== 1 || value.channel !== "stable" || typeof value.releasedAt !== "string" || !Number.isFinite(Date.parse(value.releasedAt))) throw new Error("ONE_UPDATE_PAYLOAD_INVALID");
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 12) throw new Error("ONE_UPDATE_PAYLOAD_INVALID");
  const artifacts = value.artifacts.map(parseArtifact);
  const unique = new Set(artifacts.map(item => `${item.platform}:${item.architecture}`));
  if (unique.size !== artifacts.length) throw new Error("ONE_UPDATE_ARTIFACT_DUPLICATE");
  return { schemaVersion: 1, channel: "stable", releasedAt: value.releasedAt, artifacts };
}

export function selectRuntimeUpdate(payload: RuntimeUpdatePayload, runtime: RuntimeIdentity) {
  const candidates = payload.artifacts.filter(item => item.platform === runtime.platform && (item.architecture === runtime.architecture || item.architecture === "universal"));
  return candidates.sort((left, right) => compareRuntimeVersions(right.version, left.version))[0];
}

// A launcher reports completion just before it replaces its resident process.
// During that short hand-off window the old socket can still advertise the
// previous version. Do not immediately offer the same package again while the
// completed update is still attached to that socket.
export function runtimeUpdateWasCompleted(progress: { status?: string; version?: string } | undefined, candidateVersion: string | undefined) {
  return Boolean(
    progress?.status === "completed"
      && progress.version
      && candidateVersion
      && compareRuntimeVersions(progress.version, candidateVersion) >= 0
  );
}

export class RuntimeUpdateCatalog {
  constructor(
    private manifestPath = process.env.ONE_UPDATE_MANIFEST_PATH?.trim()
      || (process.env.ONE_UPDATE_DIRECTORY?.trim() ? `${process.env.ONE_UPDATE_DIRECTORY.trim()}/stable.json` : ""),
    private publicKeyRaw = process.env.ONE_UPDATE_PUBLIC_KEY?.trim() || ""
  ) {}

  configured() { return Boolean(this.manifestPath && this.publicKeyRaw); }

  load(): { envelope: SignedRuntimeUpdate; payload: RuntimeUpdatePayload } | undefined {
    if (!this.configured()) return undefined;
    if (!fs.existsSync(this.manifestPath)) return undefined;
    const envelope = JSON.parse(fs.readFileSync(this.manifestPath, "utf8")) as SignedRuntimeUpdate;
    return { envelope, payload: verifyRuntimeUpdateEnvelope(envelope, this.publicKeyRaw) };
  }

  updateFor(runtime: RuntimeIdentity) {
    const loaded = this.load();
    if (!loaded) return undefined;
    const artifact = selectRuntimeUpdate(loaded.payload, runtime);
    if (!artifact || compareRuntimeVersions(artifact.version, runtime.version) <= 0) return undefined;
    return { envelope: loaded.envelope, artifact };
  }
}
