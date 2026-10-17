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
  assert.equal(knowledgePolicy(db,scope,'只用公开素材，不查知识库，不联网').required,false);
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
  assert.match(validateTaskReport('not json',facts),/文案.*已经做好/);
  assert.doesNotMatch(taskReportFallback({...facts,done:[]}),/成果已|全部|大部分/);
});
test('revoked source results cannot be reused through a prerequisite after authorization changes',()=>{
  const db=database(),connection=db.knowledgeConnections[0];
  db.chatOperations=[{...scope,id:'parent',operationId:'parent',conversationId:'task',workRun:{state:'completed',sources:[{id:connection.id,binding:sourceBinding(connection)}]}} as any];
  assert.equal(dependencyState(db,scope,['parent']),'ready');connection.status='revoked';assert.equal(dependencyState(db,scope,['parent']),'blocked');
});
