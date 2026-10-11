import { createHash, randomUUID } from "node:crypto";
import type { Store } from "./db.js";
import type { Database } from "./types.js";
import { callReadOnlyHttp, StandardToolError, validateFields, type HttpTool, type JsonTransport } from "./connectors/standardHttp.js";

export type PilotBinding = { featureId: string; featureVersion: number; tool: HttpTool; approvedDigest: string; cost: "free_test_only" };
export type PilotScope = { workspaceId: string; userId: string };
const denied = () => { throw new StandardToolError("PILOT_NOT_AUTHORIZED"); };
function authorize(db: Database, scope: PilotScope, binding: PilotBinding) {
  if (!db.users.some(u => u.id === scope.userId && u.enabled && u.role === "admin") ||
    !db.workspaces.some(w => w.id === scope.workspaceId && w.status === "active") ||
    !db.workspaceMembers.some(m => m.status !== "disabled" && m.workspaceId === scope.workspaceId && m.userId === scope.userId)) denied();
  const feature = db.settings.officialFeatures?.find(f => f.id === binding.featureId);
  if (feature?.status !== "approved" || feature.current?.version !== binding.featureVersion || feature.current.values.integration !== "openapi" ||
    binding.cost !== "free_test_only" || binding.approvedDigest !== binding.tool.digest) denied();
}

/** Internal pilot, not the public agent runner. Caller must additionally verify
 * live Key presence. Only code-reviewed, zero-cost public/synthetic-data tools
 * may be registered. No models, private connector credentials or new billing.
 */
export async function runOfficialFeaturePilot(store: Store, scope: PilotScope, binding: PilotBinding, operationId: string, input: unknown, transport?: JsonTransport) {
  if (!/^[a-zA-Z0-9_-]{16,80}$/.test(operationId)) throw new StandardToolError("INVALID_OPERATION_ID");
  // Detach from caller-owned configuration before awaiting.
  binding = structuredClone(binding);
  const normalized = validateFields(input, binding.tool.input, binding.tool.required);
  const fingerprint = createHash("sha256").update(JSON.stringify([binding.featureId, binding.featureVersion, binding.tool.digest, normalized])).digest("hex");
  const targetId = createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.userId, operationId])).digest("hex");
  const start = Date.now();
  const claim = await store.mutate(db => {
    authorize(db, scope, binding);
    const own = db.auditLogs.filter(r => r.targetType === "official_feature_pilot" && r.workspaceId === scope.workspaceId && r.actorUserId === scope.userId);
    const previous = own.find(r => r.targetId === targetId && r.action === "official_feature.pilot.started");
    if (previous) {
      if (previous.details?.fingerprint !== fingerprint) throw new StandardToolError("OPERATION_CONFLICT");
      const finished = own.find(r => r.targetId === targetId && r.action === "official_feature.pilot.finished");
      return { replay: true as const, status: finished?.details?.status ?? (start - Date.parse(previous.createdAt) > 30000 ? "unknown" : "running") };
    }
    const recent = own.filter(r => r.action === "official_feature.pilot.started" && start - Date.parse(r.createdAt) < 3600000);
    if (recent.length >= 60 || recent.some(r => start - Date.parse(r.createdAt) < 30000 && !own.some(end => end.targetId === r.targetId && end.action === "official_feature.pilot.finished"))) throw new StandardToolError("PILOT_RATE_LIMITED");
    db.auditLogs.push({ id: randomUUID(), workspaceId: scope.workspaceId, actorUserId: scope.userId,
      action: "official_feature.pilot.started", targetType: "official_feature_pilot", targetId,
      details: { featureId: binding.featureId, version: binding.featureVersion, toolDigest: binding.tool.digest, fingerprint, costMicros: 0 }, createdAt: new Date(start).toISOString() });
    return { replay: false as const };
  });
  // Never re-execute a request left running by a crash. A replay returns metadata
  // only; original results aren't retained in the global operations audit.
  if (claim.replay) return { runId: targetId, replay: true, status: claim.status };
  let result: Record<string, string | number | boolean> | undefined, code: string | undefined;
  try {
    authorize(await store.read(), scope, binding);
    result = await callReadOnlyHttp(binding.tool, normalized, transport);
    authorize(await store.read(), scope, binding);
  } catch (error) { code = error instanceof StandardToolError ? error.code : "TOOL_UNAVAILABLE"; }
  const status = code ? (code === "TOOL_TIMEOUT" ? "unknown" : "failed") : "completed";
  await store.mutate(db => { db.auditLogs.push({ id: randomUUID(), workspaceId: scope.workspaceId, actorUserId: scope.userId,
    action: "official_feature.pilot.finished", targetType: "official_feature_pilot", targetId,
    details: { status, ...(code ? { code } : {}), durationMs: Date.now() - start, costMicros: 0 }, createdAt: new Date().toISOString() }); });
  return { runId: targetId, replay: false, status, ...(code ? { code } : { result }) };
}
