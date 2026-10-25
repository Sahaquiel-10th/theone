import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('background refresh preserves friendly scoped feedback until the next explicit submission, not a stranded red error', () => {
  const source = readFileSync(new URL('./useCoordinator.ts', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('const acceptReceipt='), source.indexOf('async function submit'));
  assert.match(refresh, /setError\(submissionError\.current\)/);
  assert.doesNotMatch(source.slice(source.indexOf('const performRefresh = useCallback'),source.indexOf('const refreshQueue=')), /setError\(""\)/);
  assert.match(refresh, /setFailureReply\(\{scope:userId,operationId:operation,text:coordinatorRecoveryCopy/);
  assert.match(refresh, /setFailureReply\(old=>old\?\.scope===userId&&old.operationId===operation\?null:old\)/,'a late success clears only its own temporary failure reply');
  assert.match(source,/failureReply\?\.scope===userId/);
  const submit = source.slice(source.indexOf('async function submit'), source.indexOf('async function direct'));
  assert.match(submit, /submissionError\.current = ""/);
  assert.match(submit, /不会自动重复|沿用|chatSubmission/);
  assert.match(submit,/setFailureReply\(null\)/);
  assert.match(submit,/receipt.status==='completed'/);
  assert.match(submit,/input.localExecution\)throw e/,'local handoff cleanup must still receive a failed request');
});
