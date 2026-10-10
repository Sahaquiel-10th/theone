import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('background coordinator refresh preserves submission failure until the next explicit submission', () => {
  const source = readFileSync(new URL('./useCoordinator.ts', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('const refresh = useCallback'), source.indexOf('async function submit'));
  assert.match(refresh, /setError\(submissionError\.current\)/);
  assert.doesNotMatch(refresh, /setError\(""\)/);
  assert.match(refresh, /submissionError\.current = "这条消息未完成/);
  const submit = source.slice(source.indexOf('async function submit'), source.indexOf('async function direct'));
  assert.match(submit, /submissionError\.current = ""/);
  assert.match(submit, /不会自动重复|沿用|chatSubmission/);
});
