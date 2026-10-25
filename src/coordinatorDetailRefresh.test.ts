import test from 'node:test';
import assert from 'node:assert/strict';
import {coordinatorDetailReadIsCurrent,coordinatorDetailRefreshPlan,coordinatorDetailVersion,type CoordinatorDetailVersion} from './coordinatorDetailRefresh';

const task={id:'task',updatedAt:'v1',running:false,queued:0};
const receipt={id:'receipt',taskId:'task',state:'completed',updatedAt:'v1',resultMessageId:'answer'};
const detail={conversation:{updatedAt:'v1'}};
const ids=(plan:ReturnType<typeof coordinatorDetailRefreshPlan>)=>plan.map(item=>item.id);

test('a new terminal notice is read once and stable unread/reported notices no longer fan out every three seconds',()=>{
 const input={selected:null,tasks:[task],notices:[receipt],details:{},loadedVersions:new Map<string,CoordinatorDetailVersion>()};
 assert.deepEqual(ids(coordinatorDetailRefreshPlan(input)),['task']);
 const version=coordinatorDetailVersion('task',input.tasks,input.notices);
 const loaded={...input,details:{task:detail},loadedVersions:new Map([['task',version]])};
 for(let i=0;i<50;i++)assert.deepEqual(coordinatorDetailRefreshPlan({...loaded,notices:[{...receipt,reported:i%2===0,read:false}]}),[]);
 assert.deepEqual(ids(coordinatorDetailRefreshPlan({...loaded,details:{}})),['task'],'a missing/failed detail must not be suppressed by an earlier cached observation');
});

test('new receipt identity, changed result version and changed task metadata request fresh details',()=>{
 const input={selected:null,tasks:[task],notices:[receipt],details:{task:detail},loadedVersions:new Map([['task',coordinatorDetailVersion('task',[task],[receipt])]])};
 for(const notice of [{...receipt,id:'next-receipt'},{...receipt,updatedAt:'v2'},{...receipt,resultMessageId:'new-answer'},{...receipt,outcome:'partial'},{...receipt,notionReceipt:{state:'verified',url:'https://www.notion.so/verified'}}])assert.deepEqual(ids(coordinatorDetailRefreshPlan({...input,notices:[notice]})),['task']);
 assert.deepEqual(ids(coordinatorDetailRefreshPlan({...input,tasks:[{...task,updatedAt:'v2'}]})),['task']);
 assert.deepEqual(coordinatorDetailRefreshPlan({...input,notices:[receipt,{...receipt,taskId:'other',id:'other-result'}]}).map(p=>p.id),['other']);
});

test('selected and active work stays fresh while unchanged terminal siblings remain quiet',()=>{
 const tasks=[task,{...task,id:'active',running:true},{...task,id:'queued',queued:1},{...task,id:'selected'}];
 const loadedVersions=new Map(tasks.map(meta=>[meta.id,coordinatorDetailVersion(meta.id,tasks,[receipt])]));
 assert.deepEqual(ids(coordinatorDetailRefreshPlan({selected:'selected',tasks,notices:[receipt],details:{task:detail,active:detail,queued:detail,selected:detail},loadedVersions})),['selected','active','queued']);
});

test('receipt ordering and read flags do not change a version, and new scope caches start empty',()=>{
 const notices=[receipt,{...receipt,id:'r2',updatedAt:'v2'}];
 assert.deepEqual(coordinatorDetailVersion('task',[task],notices),coordinatorDetailVersion('task',[task],[...notices].reverse()));
 assert.deepEqual(ids(coordinatorDetailRefreshPlan({selected:null,tasks:[task],notices:[receipt],details:{},loadedVersions:new Map()})),['task']);
});

test('an older in-flight read cannot overwrite a completed force read after the promise map was cleared',()=>{
 const revisions=new Map([['task',1]]);assert.equal(coordinatorDetailReadIsCurrent(revisions,'task',1),true);
 revisions.set('task',2);
 assert.equal(coordinatorDetailReadIsCurrent(revisions,'task',2),true);
 assert.equal(coordinatorDetailReadIsCurrent(revisions,'task',1),false);
 assert.equal(coordinatorDetailReadIsCurrent(revisions,'other',1),false);
});
