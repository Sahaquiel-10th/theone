import test from 'node:test';
import assert from 'node:assert/strict';
import {previewReceiptMatches, previewUnavailableMessage} from './staticPreviewState.js';
test('only the same confirmed live preview keeps its link', () => {
  assert.equal(previewReceiptMatches('a', {status:'ready', url:'a'}), true);
  for (const reply of [{status:'stopped'}, {status:'unknown'}, {status:'ready', url:'b'}, {status:'ready'}]) assert.equal(previewReceiptMatches('a', reply), false);
  assert.match(previewUnavailableMessage({status:'stopped'}), /已停止/);
  assert.match(previewUnavailableMessage({status:'unknown'}), /更新/);
  assert.match(previewUnavailableMessage(), /尚未确认/);
});
