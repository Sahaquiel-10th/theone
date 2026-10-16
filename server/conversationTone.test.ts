import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyConversationGuidance } from './conversationTone.js';
test('friendly communication preserves truthful status, artifact style and structural contracts', () => {
  assert.match(friendlyConversationGuidance, /先用简短自然的话说结果/);
  assert.match(friendlyConversationGuidance, /不编造成功/);
  assert.match(friendlyConversationGuidance, /成果仍按用户要求的体裁/);
  assert.match(friendlyConversationGuidance, /结构化结果格式和工具参数/);
  assert.match(friendlyConversationGuidance, /不改变权限、安全规则、预算/);
  assert.match(friendlyConversationGuidance, /懒懒的、半睁着眼的猫/);
  assert.match(friendlyConversationGuidance, /不催促、嘲讽或责怪用户/);
  assert.match(friendlyConversationGuidance, /不把猫的口吻写进正式成果/);
});
