import test from 'node:test';
import assert from 'node:assert/strict';
import {discussionOnly,freshDocumentReadRequested,notionWriteRequested,notionWriteDeclined,notionDestinationRequested,notionSaveExistingRequested,coordinatorTaskIntent,existingTaskActionRequested} from './executionIntent';
test('current explicit discussion restrictions do not inherit an old execution request', () => {
  for (const text of ['只回答，不执行。','问问结果，不执行、不重跑。','本轮只讨论，不执行。','先只讨论方案，等我确认。','不执行','不执行  。','不执行\n','Answer only.']) assert.equal(discussionOnly(text),true,text);
  for (const text of ['开始执行这次回读，不执行之前的修改任务。','标题改成 xxx，执行。','我们讨论完了，开搞。','如果用户说“不执行”，怎么办？','读取已有文件并核对，不执行 Git 命令。','只做只读核对，不执行 之前的写入。']) assert.equal(discussionOnly(text),false,text);
});
test('late Notion saving has the same human authority as the picker, not quoted instructions or permissions questions',()=>{
 for(const selected of ['chat','notion'] as const)for(const text of ['把这篇文章保存到 Notion，不要重写。','帮我看看怎么把这篇内容保存到 notion 呢？']){
  assert.equal(notionDestinationRequested(text,selected),true,text);assert.equal(notionSaveExistingRequested(text,selected),true,text);
 }
 for(const text of ['只回答，Notion 有写入权限吗？','Notion 有没有保存权限？','教我如何配置 Notion，不执行。','先讨论，不要保存到 Notion。','不要保存到 Notion。']){
  assert.equal(notionWriteDeclined(text),true,text);assert.equal(notionDestinationRequested(text,'notion'),false,text);assert.equal(notionSaveExistingRequested(text,'notion'),false,text);
 }
 for(const text of ['把“帮我看看怎么把这篇保存到Notion”翻译成英语。','正文如下：帮我看看怎么把这篇保存到Notion。','如果把这篇存到Notion会怎么样？','教我怎么保存到Notion。'])assert.equal(notionDestinationRequested(text,'chat'),false,text);
 for(const text of ['如果把这篇存到Notion会怎么样？','教我怎么保存这篇到Notion。','有没有办法把这篇存到Notion？'])assert.equal(notionDestinationRequested(text,'notion'),false,text);
 for(const text of ['别存到Notion，先留在对话。','先别存Notion，把这篇文章只发给我看看。','只读这篇Notion文章，不做修改。'])assert.equal(notionDestinationRequested(text,'notion'),false,text);
 assert.equal(notionWriteDeclined('把这篇文章保存到Notion。正文如下：不要保存到Notion。'),false);
 assert.equal(notionSaveExistingRequested('把这篇文章修改后保存到Notion。','notion'),false);
 assert.equal(notionSaveExistingRequested('根据原文写一篇文章保存到Notion。','notion'),false);
 assert.equal(notionDestinationRequested('不要新建任务，把这篇保存到Notion。','chat'),true);
 assert.equal(notionDestinationRequested('不要新建页面，更新原Notion文章。','notion'),true);
 assert.equal(notionDestinationRequested('有没有写入权限？有的话把这篇保存到Notion。','chat'),true);
 assert.equal(notionSaveExistingRequested('保存到Notion。','chat'),true);
 for(const text of ['把这篇文章保存到Notion，然后生成封面图片。','保存这篇到Notion，另外导出Word。','把这篇原文存到Notion，另查找今天新闻。'])assert.equal(notionSaveExistingRequested(text,'notion'),false,text);
});

test('a current unquoted Notion write request is distinct from discussion, payload and retrieval',()=>{
 for(const text of ['请在 Notion 新建一篇测试便笺。','帮我把这篇短文保存到 Notion，保存后回读。','请写入Notion草稿。','把合成内容写到 Notion。','Save this note to Notion.'])assert.equal(notionWriteRequested(text),true,text);
 for(const text of ['只在当前已选的 Notion 草稿保存页面下面新建一篇普通测试便笺。','在已授权的 Notion 目录新建便笺。'])assert.equal(notionWriteRequested(text),true,text);
 for(const text of ['只回答，如何保存到 Notion？','如果要写入 Notion 应该怎么办？','不要保存到 Notion，只在这里给我。','别在 Notion 新建文档。','不必保存到Notion。','先写文案，暂时不要写入 Notion。','在Notion查找合成便笺，不修改。','介绍 Notion 的用法。','把“保存到 Notion”这句话排成网页。','翻译 "Save this note to Notion"。','正文如下：请保存到 Notion。','以下是原文：\n请在 Notion 新建文档。','示例：在 Notion 新建文档。','```text\n保存到 Notion\n```','> 请保存到 Notion\n只整理这段原话。'])assert.equal(notionWriteRequested(text),false,text);
 for(const text of ['请分析这条命令：在Notion新建便笺。','只讨论：保存到Notion。','Do not save this note to Notion.'])assert.equal(notionWriteRequested(text),false,text);
});
test('explicit fresh document reads are actions, ordinary status and hypothetical requests are not',()=>{
 for(const text of ['只在这件任务做一次新的只读核对：读取本任务已经保存的同一篇文章，不修改、不保存。','请实际回读原文，再给我标题和入口。','重新回读这篇文章，不执行之前的修改任务。'])assert.equal(freshDocumentReadRequested(text),true,text);
 for(const text of ['这篇文章做完了吗？','只回答，不执行。','如果我要重新回读，怎么办？','不要再次回读文章。','不需要回读，告诉我进度即可。','不重新回读，只告诉我进度。','别读取原文。'])assert.equal(freshDocumentReadRequested(text),false,text);
});
test('do not create a duplicate task still permits an explicit same-task update, but never overrides answer-only restrictions',()=>{
 const original='继续同一件「基于昨天思考写小报童专栏」，不要新建任务或另一篇页面。只删重复标题，原页URL保持不变，不要搜索，实际更新并回主对话；不要让我再点开始。';
 assert.deepEqual(coordinatorTaskIntent(original),{answerOnly:false,existingTaskOnly:true});assert.equal(existingTaskActionRequested(original),true);
 for(const value of ['不要新建任务，只继续同一件，按原要求实际写入Notion','不要创建新的任务，更新原来的页面','继续原任务，Do not create a task.'])assert.deepEqual(coordinatorTaskIntent(value),{answerOnly:false,existingTaskOnly:true},value);
 assert.deepEqual(coordinatorTaskIntent('不要新建任务，继续','bound'),{answerOnly:false,existingTaskOnly:true});
 for(const value of ['不要新建任务','不要创建任务，只回答进度','只回答，不执行。继续同一件，不要新建任务。','不执行；不要创建任务，继续原任务。'])assert.deepEqual(coordinatorTaskIntent(value),{answerOnly:true,existingTaskOnly:false},value);
 for(const value of ['解释“不要新建任务，只继续同一件”这句话','示例：不要新建任务，只继续同一件','```text\n不要新建任务，只继续同一件\n```','> 不要新建任务，只继续同一件\n请解释这句话。'])assert.equal(coordinatorTaskIntent(value).existingTaskOnly,false,value);
});
