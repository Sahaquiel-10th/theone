import test from 'node:test';
import assert from 'node:assert/strict';
import {advanceExecutionAppearance,endExecutionAppearanceWait,forgetExecutionAppearanceConversation,executionAppearanceActive,executionAppearanceWaiting,executionWaitsForInput,initialExecutionAppearance,readExecutionAppearance,writeExecutionAppearance,executionAppearanceStorageKey,type AppearanceTask} from './executionAppearance';
const scope={userId:'person-a',workspaceId:'workspace-a'};
const task=(overrides:Partial<AppearanceTask>={}):AppearanceTask=>({...scope,id:'local-a',conversationId:'thing-a',status:'running',reportRound:0,updatedAt:'2026-11-03T01:00:00.000Z',...overrides});
const step=(state:ReturnType<typeof initialExecutionAppearance>,...tasks:AppearanceTask[])=>advanceExecutionAppearance(state,scope,tasks);

test('one accepted local lifecycle stays dark through confirmation, continuation and final result',()=>{
 let state=initialExecutionAppearance(scope);
 state=step(state,task({status:'queued'}));assert.equal(executionAppearanceActive(state),true);
 const waiting=task({status:'completed',updatedAt:'2026-11-03T01:01:00.000Z',finalResponse:'已检查目标文件。\n\n请确认要使用橙色，确认后我再继续修改。'});
 state=step(state,waiting);assert.equal(executionAppearanceActive(state),true);assert.equal(executionAppearanceWaiting(state)?.id,'local-a');
 state=step(state,task({reportRound:1,updatedAt:'2026-11-03T01:02:00.000Z'}));assert.equal(executionAppearanceActive(state),true);
 state=step(state,task({status:'completed',reportRound:1,updatedAt:'2026-11-03T01:03:00.000Z',finalResponse:'已修改并回读 index.html，背景为 #f59e0b。'}));assert.equal(executionAppearanceActive(state),false);
});
test('disconnect and missing status do not masquerade as operation completion; confirmed cancel releases',()=>{
 let state=step(initialExecutionAppearance(scope),task());
 state=step(state);assert.equal(executionAppearanceActive(state),true);
 state=step(state,task({status:'failed',updatedAt:'2026-11-03T01:01:00.000Z',resultDeliveryPending:true}));assert.equal(executionAppearanceActive(state),true);
 state=step(state,task({status:'cancelled',updatedAt:'2026-11-03T01:02:00.000Z',requiresExecutionCheck:true}));assert.equal(executionAppearanceActive(state),true);
 state=step(state,task({status:'cancelled',updatedAt:'2026-11-03T01:03:00.000Z'}));assert.equal(executionAppearanceActive(state),false);
});
test('older rounds and stale same-round snapshots cannot clear or relight the current lifecycle',()=>{
 let state=step(initialExecutionAppearance(scope),task({reportRound:2,updatedAt:'2026-11-03T01:02:00.000Z'}));
 state=step(state,task({status:'completed',reportRound:1,updatedAt:'2026-11-03T01:03:00.000Z'}));assert.equal(executionAppearanceActive(state),true);
 state=step(state,task({status:'completed',reportRound:2,updatedAt:'2026-11-03T01:01:00.000Z'}));assert.equal(executionAppearanceActive(state),true);
 state=step(state,task({status:'completed',reportRound:2,updatedAt:'2026-11-03T01:03:00.000Z'}));assert.equal(executionAppearanceActive(state),false);
 state=step(state,task({reportRound:1,updatedAt:'2026-11-03T01:04:00.000Z'}));assert.equal(executionAppearanceActive(state),false);
});
test('no draft, historical question, historical failure or other workspace acquires a local lifecycle',()=>{
 let state=step(initialExecutionAppearance(scope),task({status:'completed',finalResponse:'请确认后我再修改。'}),task({id:'old-failed',status:'failed'}),task({id:'foreign',workspaceId:'workspace-b'}),task({id:'another-person',userId:'person-b'}));
 assert.equal(executionAppearanceActive(state),false);
 state=step(state,task());assert.equal(executionAppearanceActive(state),true);
 state=advanceExecutionAppearance(state,{...scope,workspaceId:'workspace-b'},[task()]);assert.equal(executionAppearanceActive(state),false);
 state=advanceExecutionAppearance(state,{...scope,userId:'person-b'},[task()]);assert.equal(executionAppearanceActive(state),false);
});
test('only the exact stopped waiting round can end its appearance; no cancel or execution is fabricated',()=>{
 let state=step(initialExecutionAppearance(scope),task());
 const waiting=task({status:'completed',updatedAt:'2026-11-03T01:01:00.000Z',finalResponse:'请选择一个输出文件名。'});
 state=step(state,waiting);
 assert.equal(endExecutionAppearanceWait(state,scope,task()),state);
 assert.equal(endExecutionAppearanceWait(state,scope,{...waiting,reportRound:1}),state);
 assert.equal(endExecutionAppearanceWait(state,{...scope,userId:'person-b'},waiting),state);
 const ended=endExecutionAppearanceWait(state,scope,waiting);assert.equal(executionAppearanceActive(ended),false);assert.equal(waiting.status,'completed');
 assert.equal(executionAppearanceActive(step(ended,waiting)),false);
 assert.equal(executionAppearanceActive(step(ended,{...waiting,updatedAt:'2026-11-03T01:02:00.000Z'})),false);
 assert.equal(executionAppearanceActive(step(ended,task({reportRound:1,updatedAt:'2026-11-03T01:03:00.000Z'}))),true);
});
test('an ordinary terminal failure releases the view and one finished task cannot clear another running task',()=>{
 let state=step(initialExecutionAppearance(scope),task(),task({id:'local-b',conversationId:'thing-b'}));
 state=step(state,task({status:'completed',updatedAt:'2026-11-03T01:01:00.000Z'}));assert.equal(executionAppearanceActive(state),true);
 state=step(state,task({id:'local-b',conversationId:'thing-b',status:'failed',updatedAt:'2026-11-03T01:01:00.000Z',finalResponse:'模型连接失败，本轮已结束。'}));assert.equal(executionAppearanceActive(state),false);
});
for(const response of ['请确认后我再继续修改。','请选择一个输出文件名。','目录已检查。\n\n请确认要使用橙色。','请告诉我输出文件名。','请提供目标目录。','请确认允许修改这个文件。','请确认授权范围。','请告诉我输出文件名，我再创建。','目录已检查。\n\n需要你先补充模板，之后才能继续。','你确认后我就开始修改。','已检查目标文件。\n\n请先确认项目目录。\n\n确认后，我会继续修改。','当前目录有两个候选项目。\n\n你确认一下要改哪一个，我再继续。'])test(`direct local hand-back holds: ${response}`,()=>assert.equal(executionWaitsForInput(response),true));
for(const response of ['已完成。需要的话可以继续改。','文档已经保存。\n\n请选择一个输出文件名。','已写好文章。\n\n请确认背景色的表述。','以下是使用说明。\n\n请选择一个文件夹。','文档已经保存，下面是下一步使用说明。\n\n请选择上传照片，然后点击保存。','已写好方案。\n\n请确认文中的数据是否准确。','已修改并回读 index.html。\n\n请确认文件里的颜色。','已创建文件，是否还需要我进一步优化？','方法文章：\n\n第一步可以对客户说“请确认后我再修改”。','交付正文：\n\n> 请确认后我再继续。','代码如下：\n\n```txt\n请确认后我再继续修改。\n```','已修改并回读。\n\n如果你需要，请告诉我下一步。'])test(`delivered content does not become a local confirmation: ${response}`,()=>assert.equal(executionWaitsForInput(response),false));

test('a new accepted execution of the same goal replaces its old waiting view',()=>{
 let state=step(initialExecutionAppearance(scope),task());
 state=step(state,task({status:'completed',updatedAt:'2026-11-03T01:01:00.000Z',finalResponse:'请确认后我再修改。'}));
 state=step(state,task({id:'new-local-a',updatedAt:'2026-11-03T01:02:00.000Z'}));
 assert.equal(executionAppearanceWaiting(state),undefined);assert.equal(executionAppearanceActive(state),true);
 state=step(state,task({id:'new-local-a',status:'completed',updatedAt:'2026-11-03T01:03:00.000Z',finalResponse:'已修改并回读。'}));
 assert.equal(executionAppearanceActive(state),false);
});

function storageFixture(){const data=new Map<string,string>();return {data,getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};}
test('this tab can refresh during confirmation and settles against the latest same-round server snapshot',()=>{
 const storage=storageFixture();let state=step(initialExecutionAppearance(scope),task());
 const waiting=task({status:'completed',updatedAt:'2026-11-03T01:01:00.000Z',finalResponse:'请确认后我再修改。'});
 state=step(state,waiting);writeExecutionAppearance(storage,scope,state);
 const raw=storage.getItem(executionAppearanceStorageKey(scope))!;
 assert.doesNotMatch(raw,/finalResponse|请确认|instruction|body|permission/);
 const restored=readExecutionAppearance(storage,scope);assert.equal(executionAppearanceActive(restored),true);
 const stale=step(restored,task({status:'completed',updatedAt:'2026-11-03T00:59:00.000Z',finalResponse:'已完成'}));assert.equal(executionAppearanceActive(stale),true);
 const settled=step(restored,{...waiting,updatedAt:'2026-11-03T01:02:00.000Z',finalResponse:'已修改并回读。'});assert.equal(executionAppearanceActive(settled),false);
 writeExecutionAppearance(storage,scope,settled);assert.equal(storage.getItem(executionAppearanceStorageKey(scope)),null);
});
test('ending the exact waiting view removes the hint; historical completed answers never recreate it',()=>{
 const storage=storageFixture();let state=step(initialExecutionAppearance(scope),task());
 const waiting=task({status:'completed',updatedAt:'2026-11-03T01:01:00.000Z',finalResponse:'请选择文件名。'});
 state=step(state,waiting);writeExecutionAppearance(storage,scope,state);
 state=endExecutionAppearanceWait(state,scope,waiting);writeExecutionAppearance(storage,scope,state);
 const restored=readExecutionAppearance(storage,scope);assert.equal(executionAppearanceActive(step(restored,waiting)),false);
});
test('cached appearance never crosses users or workspaces and malformed metadata cannot acquire a theme',()=>{
 const storage=storageFixture();const active=step(initialExecutionAppearance(scope),task());writeExecutionAppearance(storage,scope,active);
 for(const foreign of [{...scope,userId:'person-b'},{...scope,workspaceId:'workspace-b'}]){
  assert.equal(executionAppearanceActive(readExecutionAppearance(storage,foreign)),false);
  storage.setItem(executionAppearanceStorageKey(foreign),storage.getItem(executionAppearanceStorageKey(scope))!);
  assert.equal(executionAppearanceActive(readExecutionAppearance(storage,foreign)),false);
 }
 const valid=JSON.parse(storage.getItem(executionAppearanceStorageKey(scope))!);
 const mutations=[{...valid,version:2},{...valid,body:'unexpected'}, {...valid,held:[{...valid.held[0],round:-1}]},{...valid,held:[{...valid.held[0],phase:'failed'}]},{...valid,held:[{...valid.held[0],updatedAt:'yesterday'}]},{...valid,held:[{...valid.held[0],finalResponse:'private'}]},{...valid,held:[valid.held[0],valid.held[0]]}];
 for(const invalid of mutations){storage.setItem(executionAppearanceStorageKey(scope),JSON.stringify(invalid));assert.equal(executionAppearanceActive(readExecutionAppearance(storage,scope)),false);}
 storage.setItem(executionAppearanceStorageKey(scope),'not json');assert.equal(executionAppearanceActive(readExecutionAppearance(storage,scope)),false);
});
test('denied browser storage degrades to the observed in-memory lifecycle without touching tasks',()=>{
 const denied={getItem(){throw Error('denied');},setItem(){throw Error('denied');},removeItem(){throw Error('denied');}};
 const state=step(readExecutionAppearance(denied,scope),task());assert.equal(executionAppearanceActive(state),true);
 assert.doesNotThrow(()=>writeExecutionAppearance(denied,scope,state));
 assert.doesNotThrow(()=>writeExecutionAppearance(denied,scope,initialExecutionAppearance(scope)));
});

test('successful deletion clears only that conversation and rejects late old snapshots without treating missing polls as deletion',()=>{
 const storage=storageFixture();let state=step(initialExecutionAppearance(scope),task(),task({id:'local-b',conversationId:'thing-b'}));
 assert.equal(executionAppearanceActive(step(state)),true);
 assert.equal(forgetExecutionAppearanceConversation(state,{...scope,userId:'foreign'},'thing-a'),state);
 state=forgetExecutionAppearanceConversation(state,scope,'thing-a');writeExecutionAppearance(storage,scope,state);
 assert.deepEqual(state.held.map(item=>item.id),['local-b']);assert.equal(executionAppearanceActive(state),true);
 state=step(state,task({updatedAt:'2026-11-03T01:04:00.000Z'}));assert.deepEqual(state.held.map(item=>item.id),['local-b']);
 state=forgetExecutionAppearanceConversation(state,scope,'thing-b');writeExecutionAppearance(storage,scope,state);
 assert.equal(executionAppearanceActive(state),false);assert.equal(storage.getItem(executionAppearanceStorageKey(scope)),null);
 state=step(state,task(),task({id:'local-b',conversationId:'thing-b'}));assert.equal(executionAppearanceActive(state),false);
});
