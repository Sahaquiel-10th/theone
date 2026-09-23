import type { AuditLog } from './types.js';
import { compareRuntimeVersions, validRuntimeVersion, type RuntimeIdentity } from './runtimeUpdate.js';
import type { RuntimeUpdateProgress } from './oneKeyPresence.js';

export type UpdateOwner = { deviceId: string; installationId?: string; userId: string; workspaceId: string };
export function disconnectedRuntimeUpdate(logs: AuditLog[], owner: UpdateOwner, now = Date.now()) {
  const rows = logs.filter(row => row.action === 'one_runtime.update.checkpoint'
    && row.workspaceId === owner.workspaceId && row.actorUserId === owner.userId
    && row.targetId === owner.deviceId && row.details?.installationId === owner.installationId
    && validRuntimeVersion(row.details?.fromVersion)
    && ['macos', 'windows'].includes(String(row.details?.platform))
    && ['arm64', 'x86_64', 'amd64'].includes(String(row.details?.architecture))
    && now - Date.parse(row.createdAt) >= 0 && now - Date.parse(row.createdAt) < 30 * 60_000);
  rows.sort((a, b) => Number(b.details!.startedAt) - Number(a.details!.startedAt) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const row = rows[0];
  if (!row) return undefined;
  const runtime = { platform: row.details!.platform, architecture: row.details!.architecture, version: row.details!.fromVersion, updateProtocol: 1 } as RuntimeIdentity;
  const update = recoverRuntimeUpdate(logs, owner, runtime);
  if (!update) return undefined;
  return { runtime, update };
}
const phases = ['requested', 'downloading', 'verifying', 'installing', 'failed', 'completed'];

// Only this journal includes all four ownership dimensions and the platform.
// Older audit rows cannot safely be attributed to this computer.
export function recoverRuntimeUpdate(logs: AuditLog[], owner: UpdateOwner, runtime: RuntimeIdentity): RuntimeUpdateProgress | undefined {
  const rows = logs.filter(row => row.action === 'one_runtime.update.checkpoint'
    && row.workspaceId === owner.workspaceId && row.actorUserId === owner.userId
    && row.targetId === owner.deviceId && row.details?.installationId === owner.installationId
    && row.details?.platform === runtime.platform && typeof row.requestId === 'string'
    && validRuntimeVersion(row.details?.version) && phases.includes(String(row.details?.status))
    && Number.isFinite(Number(row.details?.startedAt)) && Number.isFinite(Date.parse(row.createdAt)));
  rows.sort((a, b) => Number(b.details!.startedAt) - Number(a.details!.startedAt)
    || Date.parse(b.createdAt) - Date.parse(a.createdAt)
    || phases.indexOf(String(b.details!.status)) - phases.indexOf(String(a.details!.status)));
  const row = rows[0];
  if (!row || compareRuntimeVersions(runtime.version, String(row.details!.version)) >= 0) return undefined;
  const status = row.details!.status as RuntimeUpdateProgress['status'];
  return { requestId: row.requestId!, status, version: String(row.details!.version), updatedAt: row.createdAt,
    recoveryRequired: status !== 'failed',
    message: status === 'failed' ? '上次更新未完成，请重试' : undefined };
}
