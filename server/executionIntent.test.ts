import test from 'node:test';
import assert from 'node:assert/strict';
import {discussionOnly,freshDocumentReadRequested} from './executionIntent';
test('current explicit discussion restrictions do not inherit an old execution request', () => {
  for (const text of ['只回答，不执行。','问问结果，不执行、不重跑。','本轮只讨论，不执行。','先只讨论方案，等我确认。','不执行','不执行  。','不执行\n','Answer only.']) assert.equal(discussionOnly(text),true,text);
  for (const text of ['开始执行这次回读，不执行之前的修改任务。','标题改成 xxx，执行。','我们讨论完了，开搞。','如果用户说“不执行”，怎么办？','读取已有文件并核对，不执行 Git 命令。','只做只读核对，不执行 之前的写入。']) assert.equal(discussionOnly(text),false,text);
});
test('explicit fresh document reads are actions, ordinary status and hypothetical requests are not',()=>{
 for(const text of ['只在这件任务做一次新的只读核对：读取本任务已经保存的同一篇文章，不修改、不保存。','请实际回读原文，再给我标题和入口。','重新回读这篇文章，不执行之前的修改任务。'])assert.equal(freshDocumentReadRequested(text),true,text);
 for(const text of ['这篇文章做完了吗？','只回答，不执行。','如果我要重新回读，怎么办？','不要再次回读文章。','不需要回读，告诉我进度即可。','不重新回读，只告诉我进度。','别读取原文。'])assert.equal(freshDocumentReadRequested(text),false,text);
});
