import test from 'node:test';
import assert from 'node:assert/strict';
import { providerSearchEvidence, safeProbeError } from '../scripts/provider-search-evidence.js';

test('native search probe requires a completed search call, not a plausible answer with links', () => {
  const message = { type: 'message', content: [{ text: 'I searched MDN', annotations: [{ type: 'url_citation', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API' }] }] };
  assert.equal(providerSearchEvidence({ status: 'completed', output: [message] }).passed, false);
  assert.equal(providerSearchEvidence({ status: 'completed', output: [message, { type: 'web_search_call', status: 'completed' }] }).passed, true);
  assert.equal(providerSearchEvidence({ status: 'incomplete', output: [message, { type: 'web_search_call', status: 'completed' }] }).passed, false);
  assert.equal(providerSearchEvidence({ status: 'completed', output: [message, { type: 'web_search_call', status: 'failed' }] }).passed, false);
});
test('probe never logs returned prose or unsafe source URLs', () => {
  const result = providerSearchEvidence({ status: 'completed', output: [{ type: 'web_search_call', status: 'completed', action: { sources: [
    { url: 'https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API' }, { url: 'https://example.org/?token=secret' },
    { url: 'http://example.org/' }, { url: 'https://secret@example.org/' }, { url: 'file:///private/key' },
  ] } }] });
  assert.equal(result.sources.length, 1); assert.doesNotMatch(JSON.stringify(result), /secret|file:/);
  assert.deepEqual(safeProbeError({ error: { code: 'unsupported_tool', message: 'tool not supported; key=sk-secret' } }), { code: 'unsupported_tool', hint: 'search_tool_not_supported' });
  assert.doesNotMatch(JSON.stringify(safeProbeError({ error: { code: 'sk-secret?value', message: 'sk-secret' } })), /sk-secret/);
});
