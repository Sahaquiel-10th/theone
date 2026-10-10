import test from 'node:test';
import assert from 'node:assert/strict';
import {discussionOnly} from './executionIntent';
test('current explicit discussion restrictions do not inherit an old execution request', () => {
  for (const text of ['只回答，不执行。','问问结果，不执行、不重跑。','本轮只讨论，不执行。','先只讨论方案，等我确认。','不执行','Answer only.']) assert.equal(discussionOnly(text),true,text);
  for (const text of ['开始执行这次回读，不执行之前的修改任务。','标题改成 xxx，执行。','我们讨论完了，开搞。','如果用户说“不执行”，怎么办？']) assert.equal(discussionOnly(text),false,text);
});
