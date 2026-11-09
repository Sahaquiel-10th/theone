import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {ApiError} from './oneApi';
import {coordinatorRequest} from './coordinatorTransport';
import {coordinatorDetailReadIsCurrent} from './coordinatorDetailRefresh';
import {viewCoordinatorTask} from './coordinatorTaskView';
import {coordinatorReadFeedback,coordinatorReadIssue,type CoordinatorReadIssues} from './coordinatorReadFeedback';

// Run the actual hook closures with their shared refs and synchronous setters.
const source=readFileSync(new URL('./useCoordinator.ts',import.meta.url),'utf8');
function closure(start:string,end:string,name:string) {
  const body=ts.transpileModule(source.slice(source.indexOf(start),source.indexOf(end)),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return new Function('context',`with(context){${body};return ${name};}`);
}
const makeRecord=closure('const recordReadResult=','const setCurrentPending=','recordReadResult');
const makeLoad=closure('const load = useCallback','const viewTask=','load');
const makeView=closure('const viewTask=','const acceptReceipt=','viewTask');
const makeRead=closure('const readReceipt=','const performRefresh =','readReceipt');
const makeRefresh=closure('const performRefresh =','const refreshQueue=','performRefresh');
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>() {
  let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;
  const promise=new Promise<T>((ok,fail)=>{resolve=ok;reject=fail;});
  return {promise,resolve,reject};
}
function fixture() {
  let current=true;
  const state={error:'',issues:{} as CoordinatorReadIssues,snapshot:null as any,details:{} as Record<string,unknown>,failureReply:'saved business failure',writes:0};
  const context:Record<string,any>={
    ApiError,coordinatorRequest,coordinatorReadIssue,coordinatorDetailReadIsCurrent,viewCoordinatorTask,
    useCallback:(fn:unknown)=>fn,isCurrent:()=>current,enabled:true,userId:'user',workspaceId:'workspace',
    localStorage:{getItem:()=>null},pendingKey:()=> 'pending',pendingRef:{current:null},snapshotRef:{current:null},
    selectedRef:{current:null},viewedTask:{current:null},pageRef:{current:1},refreshRevision:{current:0},
    detailReads:new Map(),detailVersions:new Map(),detailReadRevisions:new Map(),detailsRef:{current:{}},
    receiptReads:new Map(),settledReceipts:new Map(),receivedReceipts:new Map(),missingReceipts:new Set(),submissionError:{current:''},
    resumeKey:{current:''},resumeAt:{current:0},
    coordinatorDetailVersion:()=>({updatedAt:'v1',receipts:'[]'}),coordinatorDetailRefreshPlan:()=>[],
    setReady:()=>{},setPage:()=>{},setProgress:()=>{},setOutgoing:()=>{},setFailureReply:()=>{},setCurrentPending:()=>{},setError:(value:string)=>{state.error=value;},
    setReadIssues:(update:any)=>{state.issues=update(state.issues);},
    setSnapshot:(update:any)=>{state.snapshot=update(state.snapshot);context.snapshotRef.current=state.snapshot;},
    setDetails:(update:any)=>{state.details=update(state.details);context.detailsRef.current=state.details;},
    api:async(_path:string,options?:RequestInit)=>{
      if(options?.method&&options.method!=='GET')state.writes++;
      return{enabled:true,conversation:null,tasks:[],notices:[],total:0};
    },
  };
  context.recordReadResult=makeRecord(context);
  context.acceptReceipt=(operation:string)=>context.recordReadResult(`receipt:${operation}`);
  context.readReceipt=makeRead(context);
  context.load=makeLoad(context);
  context.viewTask=makeView(context);
  const refresh=makeRefresh(context) as ()=>Promise<void>;
  return {state,context,refresh,set current(value:boolean){current=value;}};
}

test('temporary GET failures use connection feedback while authorization stays explicit',()=>{
  for(const error of [new TypeError('Failed to fetch'),new ApiError('timeout',undefined,undefined,'COORDINATOR_READ_TIMEOUT'),new ApiError('upstream',undefined,503),new ApiError('throttled',undefined,429)]) {
    const issue=coordinatorReadIssue('snapshot',error);
    assert.equal(issue.connection,true);assert.match(issue.message,/恢复连接/);
    assert.equal(coordinatorReadFeedback({snapshot:issue}).error,'');
  }
  for(const status of [401,403,428]) {
    const issue=coordinatorReadIssue('snapshot',new ApiError('请恢复原连接授权',undefined,status));
    assert.equal(issue.connection,false);assert.equal(coordinatorReadFeedback({snapshot:issue}).error,'请恢复原连接授权');
  }
});

test('an actual background refresh failure never becomes a task execution error and clears on its own successful read',async()=>{
  const f=fixture();let offline=true;
  f.context.api=async()=>{if(offline)throw new ApiError('service temporarily unavailable',undefined,503);return{enabled:true,conversation:null,tasks:[],notices:[],total:0};};
  await f.refresh();assert.match(coordinatorReadFeedback(f.state.issues).notice,/恢复连接/);assert.equal(f.state.error,'');
  assert.equal(f.state.failureReply,'saved business failure');assert.equal(f.state.writes,0);
  offline=false;await f.refresh();assert.deepEqual(f.state.issues,{});assert.equal(f.state.failureReply,'saved business failure');
});

test('an unusable snapshot retains the prior view and exposes only its read connection problem',async()=>{
  const f=fixture();f.state.snapshot={clientScope:'user',tasks:[],notices:[],total:0,conversation:null};
  const prior=f.state.snapshot;f.context.snapshotRef.current=prior;f.context.api=async()=>({});
  await f.refresh();assert.equal(f.state.snapshot,prior);assert.equal(f.state.error,'');
  assert.match(coordinatorReadFeedback(f.state.issues).notice,/恢复连接/);
});

test('snapshot success retains both an actual task-detail read failure and an explicit submission failure',async()=>{
  const f=fixture();let offline=true;
  f.state.error='原提交需要补充资料';f.context.submissionError.current=f.state.error;
  f.context.api=async(path:string)=>{
    if(path.includes('/tasks/')){if(offline)throw new TypeError('Failed to fetch');return{conversation:{id:'task',updatedAt:'v1'},jobs:[]};}
    return{enabled:true,conversation:null,tasks:[],notices:[],total:0};
  };
  await assert.rejects(f.context.load('task'),TypeError);
  await f.refresh();
  assert.ok(f.state.issues['detail:task']);assert.match(coordinatorReadFeedback(f.state.issues).notice,/详细进度/);
  assert.equal(f.state.error,'原提交需要补充资料');assert.equal(f.state.failureReply,'saved business failure');
  offline=false;await f.context.load('task',true);
  assert.equal(f.state.issues['detail:task'],undefined);assert.equal(f.state.error,'原提交需要补充资料');
});

test('a successful snapshot cannot clear a still-failing receipt or briefly clear its authorization error',async()=>{
  const f=fixture();let failure:Error|undefined=new ApiError('请连接 ONE Key',undefined,428);
  f.context.pendingRef.current='original';
  f.context.api=async(path:string)=>{
    if(path.includes('/messages/')){if(failure)throw failure;return{status:'pending'};}
    return{enabled:true,conversation:null,tasks:[],notices:[],total:0,pendingOperationId:'original'};
  };
  await f.refresh();assert.equal(coordinatorReadFeedback(f.state.issues).error,'请连接 ONE Key');
  await f.refresh();assert.equal(coordinatorReadFeedback(f.state.issues).error,'请连接 ONE Key');
  failure=undefined;await f.refresh();assert.deepEqual(f.state.issues,{});assert.equal(f.state.writes,0);
});

test('recovering one task detail does not clear another task detail failure',async()=>{
  const f=fixture();let recovered=false;
  f.context.api=async(path:string)=>{if(!recovered||path.endsWith('/other'))throw new ApiError('detail unavailable',undefined,503);return{conversation:{id:'task',updatedAt:'v2'},jobs:[]};};
  await assert.rejects(f.context.load('task'));await assert.rejects(f.context.load('other'));
  recovered=true;await f.context.load('task',true);
  assert.equal(f.state.issues['detail:task'],undefined);assert.ok(f.state.issues['detail:other']);
});

test('the actual view-only entry uses the tracked read feedback instead of throwing a second global error',async()=>{
  const f=fixture();let failure:Error|undefined=new TypeError('Failed to fetch');
  f.context.api=async()=>{if(failure)throw failure;return{conversation:{id:'task',updatedAt:'v2'},jobs:[]};};
  assert.equal(await f.context.viewTask('task'),undefined);
  assert.match(coordinatorReadFeedback(f.state.issues).notice,/详细进度/);assert.equal(f.state.error,'');
  failure=new ApiError('请恢复 Notion 原连接',undefined,403);
  assert.equal(await f.context.viewTask('task'),undefined);
  assert.equal(coordinatorReadFeedback(f.state.issues).error,'请恢复 Notion 原连接');
  failure=undefined;assert.equal((await f.context.viewTask('task')).conversation.id,'task');
  assert.deepEqual(f.state.issues,{});assert.equal(f.state.writes,0);
});

test('an older detail failure cannot replace the success of a forced current read',async()=>{
  const f=fixture(),first=deferred<unknown>();let calls=0;
  f.context.api=async()=>++calls===1?first.promise:{conversation:{id:'task',updatedAt:'v2'},jobs:[]};
  const old=f.context.load('task');const rejected=assert.rejects(old,/offline/);await tick();
  await f.context.load('task',true);first.reject(new TypeError('offline'));await rejected;
  assert.deepEqual(f.state.issues,{});assert.equal((f.state.details.task as any).conversation.updatedAt,'v2');
});

test('a late read from the old account cannot add a warning to the current account',async()=>{
  const f=fixture(),result=deferred<unknown>();f.context.api=async()=>result.promise;
  const pending=f.refresh();f.current=false;result.reject(new TypeError('offline'));await pending;
  assert.deepEqual(f.state.issues,{});assert.equal(f.state.error,'');
});
