// A queued workRun has not called a model/executor and survives startup intact.
// All other pending operations (including unknown states) still block restart.
export function pendingWork(rows) {
  let active = 0, queued = 0;
  for (const row of rows) {
    const count = Number(row.total);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('ONE_PENDING_COUNT_INVALID');
    if (row.state === 'queued') queued += count;
    else active += count;
  }
  return { active, queued };
}
