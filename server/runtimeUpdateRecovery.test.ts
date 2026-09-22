import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverRuntimeUpdate } from './runtimeUpdateRecovery.js';
import type { AuditLog } from './types.js';

const owner = { deviceId: 'key-a', installationId: 'computer-a', userId: 'user-a', workspaceId: 'workspace-a' };
const runtime = { platform: 'macos', architecture: 'arm64', version: '0.3.8', updateProtocol: 1 } as const;
const row: AuditLog = { id: 'a', action: 'one_runtime.update.checkpoint', targetType: 'one_key_device',
  targetId: owner.deviceId, workspaceId: owner.workspaceId, actorUserId: owner.userId, requestId: 'update-a',
  createdAt: '2026-09-23T01:00:00Z', details: { installationId: owner.installationId, platform: 'macos',
    status: 'installing', version: '0.3.9', startedAt: 100 } };

test('update checkpoints survive restart without claiming a running upgrade or retrying an uncertain write', () => {
  const result = recoverRuntimeUpdate(JSON.parse(JSON.stringify([row])), owner, runtime);
  assert.equal(result?.recoveryRequired, true);
  assert.equal(result?.status, 'installing');
  assert.equal(recoverRuntimeUpdate([row], owner, { ...runtime, version: '0.3.9' }), undefined);
  assert.equal(recoverRuntimeUpdate([row], owner, { ...runtime, version: '0.3.10' }), undefined);
});

test('update recovery is exact scoped to workspace, account, Key, computer and OS', () => {
  for (const field of ['workspaceId', 'userId', 'deviceId', 'installationId'] as const) {
    assert.equal(recoverRuntimeUpdate([row], { ...owner, [field]: 'foreign' }, runtime), undefined);
  }
  assert.equal(recoverRuntimeUpdate([row], owner, { ...runtime, platform: 'windows' }), undefined);
  assert.equal(recoverRuntimeUpdate([{ ...row, details: { version: '0.3.9', status: 'completed' } }], owner, runtime), undefined);
});

test('latest attempt wins independent of SQL row order; completed beats delayed earlier phases', () => {
  const completed = { ...row, details: { ...row.details, status: 'completed' } };
  assert.equal(recoverRuntimeUpdate([completed, row], owner, runtime)?.status, 'completed');
  const failed = { ...row, requestId: 'update-b', details: { ...row.details, status: 'failed', startedAt: 200 } };
  assert.equal(recoverRuntimeUpdate([failed, completed], owner, runtime)?.status, 'failed');
  assert.equal(recoverRuntimeUpdate([failed, completed], owner, runtime)?.recoveryRequired, false);
});
