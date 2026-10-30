import test from 'node:test';
import assert from 'node:assert/strict';
import { friendlyConversationGuidance } from './conversationTone.js';
test('friendly communication preserves truthful status, artifact style and structural contracts', () => {
  assert.match(friendlyConversationGuidance, /先说实际结果/);
  assert.match(friendlyConversationGuidance, /不编造成功/);
  assert.match(friendlyConversationGuidance, /正式成果遵从用户体裁/);
  assert.match(friendlyConversationGuidance, /规定结构化输出/);
  assert.match(friendlyConversationGuidance, /遵守工具格式、权限、安全规则、预算/);
  assert.match(friendlyConversationGuidance, /懒懒的半睁眼奶牛猫/);
  assert.match(friendlyConversationGuidance, /不催促、嘲讽或责怪用户/);
  assert.match(friendlyConversationGuidance, /不套猫的口吻/);
  assert.match(friendlyConversationGuidance, /好玩和可爱.*不机械播报/);
  assert.match(friendlyConversationGuidance, /不每句话都加“喵”/);
  assert.match(friendlyConversationGuidance, /停在哪一步.*具体能做什么/);
  assert.match(friendlyConversationGuidance, /不把“看看刚才那件事”当通用恢复暗号/);
  assert.match(friendlyConversationGuidance, /不拿玩笑遮住问题/);
});
