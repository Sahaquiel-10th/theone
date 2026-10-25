import test from 'node:test';
import assert from 'node:assert/strict';
import {claimInitialTaskLink,settleInitialTaskLink,viewCoordinatorTask,coordinatorTaskConversation} from './coordinatorTaskView';
import {coordinatorDetailRefreshPlan,coordinatorDetailVersion,type CoordinatorDetailVersion} from './coordinatorDetailRefresh';

test('a task URL waits when models arrive before the coordinator snapshot and is consumed only after routing',()=>{
 const state={opening:false,opened:false};
 assert.equal(claimInitialTaskLink(state,{modelsLoaded:false,demo:false,snapshotKnown:false}),false);
 assert.equal(claimInitialTaskLink(state,{modelsLoaded:true,demo:false,snapshotKnown:false}),false);
 assert.deepEqual(state,{opening:false,opened:false});
 assert.equal(claimInitialTaskLink(state,{modelsLoaded:true,demo:false,snapshotKnown:true}),true);
 assert.equal(claimInitialTaskLink(state,{modelsLoaded:true,demo:false,snapshotKnown:true}),false,'a re-render cannot route the same link twice');
 settleInitialTaskLink(state,false);
 assert.equal(claimInitialTaskLink(state,{modelsLoaded:true,demo:false,snapshotKnown:true}),true,'an unsuccessful open does not consume the link');
 settleInitialTaskLink(state,true);
 assert.equal(claimInitialTaskLink(state,{modelsLoaded:true,demo:false,snapshotKnown:true}),false);
 // snapshotKnown also covers a server-confirmed disabled coordinator: legacy
 // routing remains valid; a local demo does not require a production snapshot.
 assert.equal(claimInitialTaskLink({opening:false,opened:false},{modelsLoaded:true,demo:true,snapshotKnown:false}),true);
});

test('viewing a terminal task without notices loads jobs and recovery and keeps later readback changes fresh without writes',async()=>{
 const task={id:'terminal-link',updatedAt:'v1',running:false,queued:0};
 let selected:string|null=null,reads=0;
 let server={conversation:{updatedAt:'v1',messages:[{id:'first',content:'原要求'}]},jobs:[{notionReceipt:{state:'uncertain'}}],recovery:{kind:'reconciling'}};
 const details:Record<string,typeof server>={},loadedVersions=new Map<string,CoordinatorDetailVersion>();
 const requests:{method:string;path:string}[]=[];
 const load=async(id:string)=>{requests.push({method:'GET',path:`/api/coordinator/tasks/${id}`});reads++;const detail=structuredClone(server);details[id]=detail;loadedVersions.set(id,coordinatorDetailVersion(id,[task],[]));return detail;};
 const input={isCurrent:()=>true,select:(id:string|null)=>{selected=id;},load};
 assert.deepEqual(coordinatorDetailRefreshPlan({selected,tasks:[task],notices:[],details,loadedVersions}),[],'unviewed stable terminal siblings remain quiet');
 const opened=await viewCoordinatorTask(task.id,input);
 assert.equal(opened?.jobs.length,1);assert.equal(opened?.recovery.kind,'reconciling');assert.equal(selected,task.id);
 server={conversation:{updatedAt:'v1',messages:[{id:'first',content:'原要求'},{id:'saved',content:'保存已核对'}]},jobs:[{notionReceipt:{state:'verified'}}],recovery:{kind:'none'}};
 for(const {id} of coordinatorDetailRefreshPlan({selected,tasks:[task],notices:[],details,loadedVersions}))await load(id);
 assert.equal(details[task.id].jobs[0].notionReceipt.state,'verified');assert.equal(details[task.id].recovery.kind,'none');assert.equal(details[task.id].conversation.messages.length,2);
 await viewCoordinatorTask(null,input);
 assert.equal(selected,null);assert.equal(reads,2,'closing does not read or acknowledge again');
 assert.deepEqual(coordinatorDetailRefreshPlan({selected,tasks:[task],notices:[],details,loadedVersions}),[],'closed terminal task no longer polls');
 assert.ok(requests.every(request=>request.method==='GET'));assert.equal(requests.length,2,'no message/retry/resume/acknowledgement POST exists in viewing');
});

test('an obsolete account/workspace view does not select or deliver a late detail',async()=>{
 let current=true,selected:string|null=null,release!:(detail:{id:string})=>void;
 const read=new Promise<{id:string}>(resolve=>{release=resolve;});
 const view=viewCoordinatorTask('old-task',{isCurrent:()=>current,select:id=>{selected=id;},load:()=>read});
 assert.equal(selected,'old-task');current=false;selected=null;release({id:'private-old-task'});
 assert.equal(await view,undefined);assert.equal(selected,null);
 let reads=0;
 assert.equal(await viewCoordinatorTask('another-old-task',{isCurrent:()=>false,select:()=>assert.fail('old scope must not select'),load:async()=>{reads++;return {};}}),undefined);
 assert.equal(reads,0);
});

test('a linked task outside the list page uses refreshed details instead of its cached first message',()=>{
 const cached={id:'older-task',messages:[{id:'input',content:'原要求'}],messagesLoaded:true};
 const latest={...cached,messages:[...cached.messages,{id:'result',content:'保存已核对'}]};
 assert.equal(coordinatorTaskConversation(cached,{}),cached);
 assert.deepEqual(coordinatorTaskConversation(cached,{'older-task':{conversation:latest}}).messages,latest.messages);
 assert.equal(coordinatorTaskConversation(cached,{'foreign-task':{conversation:{...latest,id:'foreign-task'}}}),cached);
});
