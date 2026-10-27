import test from 'node:test';
import assert from 'node:assert/strict';
import {knowledgePolicy,knowledgeResultComplete} from './taskContract.js';
import {taskReportFallback,validateTaskReport} from './taskNarration.js';
import {dependencyState,resolveWorkDependency} from './workDependencies.js';
import {sourceBinding} from './publicSharing.js';
import type {Database} from './types.js';
const scope={workspaceId:'a',userId:'u'};
function database(){return {settings:{},conversations:[{id:'task',...scope,archived:false}],users:[{id:'u',enabled:true}],workspaceMembers:[{workspaceId:'a',userId:'u'}],workspaces:[{id:'a',status:'active'}],knowledgeConnections:[{id:'n',workspaceId:'a',provider:'notion',status:'connected'},{id:'g',workspaceId:'a',provider:'getnote',status:'error'},{id:'foreign',workspaceId:'b',provider:'feishu',status:'connected'}],chatOperations:[]} as unknown as Database;}
test('explicit platform requests and exhaustive recall stay inside the authorized selection',()=>{
  const db=database();
  assert.deepEqual(knowledgePolicy(db,scope,'帮我去 Notion 查查方案').sourceIds,['n']);
  assert.deepEqual(knowledgePolicy(db,scope,'我记得有个方案，帮我找找').sourceIds,['n','g']);
  assert.deepEqual(knowledgePolicy(db,scope,'查查资料库',['n']).sourceIds,['n']);
  assert.deepEqual(knowledgePolicy(db,scope,'去飞书看看资料').missing,['飞书']);
  assert.deepEqual(knowledgePolicy(db,scope,'查查资料库',['foreign']).sourceIds,[]);
  assert.equal(knowledgePolicy(db,scope,'聊聊网页怎么设计').required,false);
  assert.deepEqual(knowledgePolicy(db,scope,'昨天我的会议说了什么？').sourceIds,['n','g']);
  assert.equal(knowledgePolicy(db,scope,'查昨天联合国会议的公开新闻').required,false);
  assert.equal(knowledgePolicy(db,scope,'只用公开素材，不查知识库，不联网').required,false);
});
test('Notion writing and readback do not require unrelated knowledge search because of 检查',()=>{
 const db=database();
 for(const text of [
  '在当前已选的 Notion 草稿保存页面下面新建文档。正文：明天15时检查小苗。保存后实际回读，不读取知识库或参考文章。',
  '写一篇文章保存到 Notion，检查正文和保存结果。',
  '保存到 Notion 后查看原页面，核对保存结果。',
  '只修改同一篇 Notion 文档，实际保存后回读核对。不读其他页面或知识库，不联网搜索、不操作本机。',
 ])assert.equal(knowledgePolicy(db,scope,text).required,false,text);
 assert.deepEqual(knowledgePolicy(db,scope,'在 Notion 新建草稿；先去得到大脑找一下会议资料').sourceIds,['g']);
 assert.deepEqual(knowledgePolicy(db,scope,'查 Notion 里面的会议资料').sourceIds,['n']);
 assert.deepEqual(knowledgePolicy(db,scope,'我记得 Notion 有个方案').sourceIds,['n']);
 assert.deepEqual(knowledgePolicy(db,scope,'不联网搜索；去 Notion 查会议资料').sourceIds,['n']);
 assert.deepEqual(knowledgePolicy(db,scope,'不读其他页面或知识库；去得到大脑找一下会议资料').sourceIds,['g']);
 for(const choice of ['all','notion',undefined])for(const negative of ['不必联网查知识库','不必联网或查知识库','不需要上网和查询知识库','无需联网及检索知识库']){
  const p=knowledgePolicy(db,scope,`只依据用户给出的主题创作，${negative}。保存到 Notion 后回读。`,undefined,choice);
  assert.equal(p.required,false);assert.equal(p.declined,true);assert.deepEqual(p.sourceIds,[]);
 }
 assert.equal(knowledgePolicy(db,scope,'不联网搜索；去 Notion 查会议资料',undefined,'notion').required,true);
 assert.deepEqual(knowledgePolicy(db,scope,'昨天我的会议说了什么？不联网搜索。').sourceIds,['n','g']);
});
test('a supplied complete Notion manuscript can decline renewed knowledge search without blocking same-page final edits',()=>{
 const request='继续同一件「基于昨天思考写小报童专栏」，不要新建任务或另一篇页面。现有 Notion 草稿已经有全文，本轮只做最终整理：保留全文内容和自然结尾，删掉正文开头重复的二级标题「我把对AI的所有理解都变成了一个小小的启动器」，只留一个主标题。沿用这篇原稿：https://www.notion.so/403a50159991810f8a36fcb45cb015bf。素材已经足够，不要重新搜索知识库或旧资料，不增加或虚构经历，不发布、不分享。请实际更新同一篇草稿，回读核对正文完整和结尾后，在主对话汇报完成并给出原稿入口，不要让我再点开始。';
 for(const choice of [undefined,'all','notion']){
  const policy=knowledgePolicy(database(),scope,request,undefined,choice);
  assert.equal(policy.required,false);assert.equal(policy.declined,true);assert.deepEqual(policy.sourceIds,[]);assert.deepEqual(policy.requested,[]);assert.deepEqual(policy.missing,[]);
 }
});
test('common renewal adverbs stay inside a declined retrieval action without hiding a later affirmative source',()=>{
 const db=database();
 for(const modifier of ['再','重新','继续','额外','另外','再次','再重新','额外去','再帮我'])for(const negative of ['不要','不用','无需','不必','别']){
  const policy=knowledgePolicy(db,scope,`素材已经足够，${negative}${modifier}搜索知识库或旧资料。只整理现有 Notion 草稿。`,undefined,'all');
  assert.equal(policy.required,false,`${negative}${modifier}`);assert.equal(policy.declined,true);assert.deepEqual(policy.sourceIds,[]);
 }
 for(const text of [
  '不要重新搜索 Notion 旧资料，但去得到大脑查一下新材料',
  '不用再搜索旧资料，不过从得到大脑找一下最新会议记录',
  '无需继续查找旧资料而是去得到大脑检索最新资料',
  '不必额外搜索 Notion 旧资料并去得到大脑查一下新记录',
  '别另外查询旧资料，然后去得到大脑继续查会议记录',
  '不要重新搜索旧资料，但也不用查找 Notion，而是去得到大脑检索新资料',
  '不要重新搜索 Notion 旧资料,去得到大脑查一下新资料',
 ]){
  for(const choice of [undefined,'all','notion']){
   const policy=knowledgePolicy(db,scope,text,undefined,choice);assert.equal(policy.required,true,text);assert.equal(policy.declined,false,text);assert.deepEqual(policy.sourceIds,['g'],text);assert.deepEqual(policy.requested,['getnote'],text);
  }
  assert.deepEqual(knowledgePolicy(db,scope,text,['n']).sourceIds,[],`${text}: explicit selection is never expanded`);
  assert.deepEqual(knowledgePolicy(db,{workspaceId:'b',userId:'u'},text).sourceIds,[],`${text}: another workspace is never queried`);
 }
 for(const text of [
  '不要重新搜索旧资料，但也不用查Notion',
  '不要重新搜索旧资料，但也不用查找 Notion',
  '不用再查询旧笔记，不过不要另外搜索 Notion',
  '不要继续检索旧资料，然后也无需再搜索得到大脑',
  '不用额外搜索 Notion,也不要重新检索得到大脑',
 ])for(const choice of [undefined,'all','notion']){
  const policy=knowledgePolicy(db,scope,text,undefined,choice);assert.equal(policy.required,false,text);assert.equal(policy.declined,true,text);assert.deepEqual(policy.sourceIds,[],text);
 }
});
test('no match is a real completed search, not a euphemism for an outage',()=>{
  assert.equal(knowledgeResultComplete({status:'no_match',coverage:[{connectionId:'n',status:'no_match'}]},['n']),true);
  for(const status of ['failed','unavailable'])assert.equal(knowledgeResultComplete({status:'used',coverage:[{connectionId:'n',status:'used'},{connectionId:'g',status}]},['n','g']),false);
  assert.equal(knowledgeResultComplete({status:'partial'},['n']),false);
});
test('only explicit same-owner same-task retries release dependent work; cancellation stays stopped',()=>{
  const db=database();const op=(id:string,state:string,extra={})=>({...scope,id,operationId:id,conversationId:'task',workRun:{state,...extra}} as any);
  db.chatOperations=[op('first','failed')];
  assert.equal(dependencyState(db,scope,['first']),'blocked');
  db.chatOperations.push({...op('fake','completed',{retryOfOperationId:'first'}),workspaceId:'b'});
  db.chatOperations.push({...op('unrelated','completed',{retryOfOperationId:'first'}),conversationId:'other'});
  assert.equal(dependencyState(db,scope,['first']),'blocked');
  db.chatOperations.push(op('retry','queued',{retryOfOperationId:'first'}));
  assert.equal(dependencyState(db,scope,['first']),'waiting');
  db.chatOperations.at(-1)!.workRun!.state='completed';
  assert.equal(resolveWorkDependency(db,scope,'first')!.id,'retry');
  assert.equal(dependencyState(db,scope,['first']),'ready');
  db.chatOperations.at(-1)!.workRun!.state='cancelled';assert.equal(dependencyState(db,scope,['first']),'cancelled');
  assert.equal(dependencyState(db,{workspaceId:'b',userId:'another'},['first']),'blocked');
});
test('friendly reports preserve actual accomplishments without overstating completion or exposing internals',()=>{
  const facts={done:['文案'],pending:['网页'],files:[],reason:'read timed out'};
  const good='文案已经做好，网页这次还没保存成功。可以继续补上，不用重写文案。';
  assert.equal(validateTaskReport(JSON.stringify({message:good}),facts),good);
  for(const message of ['API 调用失败了','大部分完成了，文案已做好','文案和网页全部完成','文案已做好。全部搞定了'])assert.equal(validateTaskReport(JSON.stringify({message}),facts),taskReportFallback(facts));
  const fallback=validateTaskReport('not json',facts);
  assert.match(fallback,/文案已完成/);
  assert.match(fallback,/网页还没做好/);
  assert.doesNotMatch(taskReportFallback({...facts,done:[]}),/成果已|全部|大部分/);
  for(const message of ['文案已经做好，网页还没好。下一步我接着把网页补齐，补完就给你。','文案已做好，网页还差一些，我会继续。','文案已经做好，网页还在处理，我正在补。'])
    assert.equal(validateTaskReport(JSON.stringify({message}),facts),taskReportFallback(facts));
});
test('revoked source results cannot be reused through a prerequisite after authorization changes',()=>{
  const db=database(),connection=db.knowledgeConnections[0];
  db.chatOperations=[{...scope,id:'parent',operationId:'parent',conversationId:'task',workRun:{state:'completed',sources:[{id:connection.id,binding:sourceBinding(connection)}]}} as any];
  assert.equal(dependencyState(db,scope,['parent']),'ready');connection.status='revoked';assert.equal(dependencyState(db,scope,['parent']),'blocked');
});
