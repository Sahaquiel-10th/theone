import test from 'node:test';
import assert from 'node:assert/strict';
import { taskConversationView } from './taskConversationView';

const original = { id: 'msg-a', role: 'user' as const, content: '画一张蓝色机器人，再做一份表格', createdAt: '2026-10-14T00:00:00Z' };
test('task view displays its narrow handoff without altering stored originals', () => {
  const result = taskConversationView([original], [{ inputMessageId: 'msg-a', instruction: '画一张蓝色机器人' }]);
  assert.equal(result[0].content, '画一张蓝色机器人');
  assert.equal(result[0].originalContent, original.content);
  assert.equal(original.content, '画一张蓝色机器人，再做一份表格');
  assert.notEqual(result[0], original);
});
test('discussion, unauthorized missing handoffs and unrelated anchors stay original', () => {
  assert.equal(taskConversationView([original], [{ inputMessageId: 'other', instruction: '别的任务' }])[0].content, original.content);
  assert.equal(taskConversationView([original], [{ inputMessageId: 'msg-a' }])[0].originalContent, undefined);
  assert.equal(taskConversationView([original], [{ inputMessageId: 'msg-a', instruction: ' ' }])[0].content, original.content);
  const assistant = { ...original, role: 'assistant' as const };
  assert.equal(taskConversationView([assistant], [{ inputMessageId: 'msg-a', instruction: '其他内容' }])[0].content, original.content);
});
