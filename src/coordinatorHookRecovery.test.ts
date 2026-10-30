import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';
import {ApiError} from './oneApi';
import {coordinatorRecoveryCopy,parseCoordinatorFailure} from './coordinatorRecovery';
import {coordinatorRequest,forgetStoredCoordinatorOperation} from './coordinatorTransport';
import {mergeCoordinatorReceipt,seedCoordinatorReceipt,isCoordinatorReceipt,coordinatorReceiptFailure,type CoordinatorReceipt} from './coordinatorHistory';
import {invalidCoordinatorReceipt,recoverCoordinatorSubmission} from './coordinatorSubmissionRecovery';
import {chatSubmission,forgetChatSubmission,pendingChatSubmissions} from './chatSubmission';
import {coordinatorDrafts,coordinatorSubmissionPayload,saveCoordinatorDraft,forgetCoordinatorDraft,markCoordinatorDraft} from './coordinatorDrafts';
import type {CoordinatorSubmission} from './useCoordinator';

// Execute the hook's actual closure functions with synchronous state setters.
// This retains its refs, storage, transport and receipt/draft integrations;
// it needs neither DOM timing nor assertions about implementation text.
const source=readFileSync(new URL('./useCoordinator.ts',import.meta.url),'utf8');
function closure(name:string,end:string,exported:string){
  const code=ts.transpileModule(source.slice(source.indexOf(name),source.indexOf(end)),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  return new Function('context',`with(context){${code};return ${exported};}`) as (context:Record<string,unknown>)=>any;
}
const makeAccept=closure('const acceptReceipt=','const readReceipt=','acceptReceipt');
const makeSubmit=closure('async function submit','async function direct','submit');
function fixture(t:TestContext){
  const stored=new Map<string,string>(),storage={getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>{stored.set(key,value);},removeItem:(key:string)=>{stored.delete(key);}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:storage});
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else Reflect.deleteProperty(globalThis,'sessionStorage');});
  const userId=randomUUID(),workspaceId='workspace';const state:Record<string,any>={outgoing:null,progress:null,failure:null,settlement:null,snapshot:null};
  const setter=(key:string)=>(action:any)=>{state[key]=typeof action==='function'?action(state[key]):action;if(key==='snapshot')context.snapshotRef.current=state[key];};
  let postResult:unknown=new TypeError('Failed to fetch'),readResult:unknown=new TypeError('Failed to fetch'),postCount=0,readCount=0;let afterRefresh:(()=>void)|undefined;
  const context:Record<string,any>={ApiError,coordinatorRecoveryCopy,parseCoordinatorFailure,coordinatorRequest,forgetStoredCoordinatorOperation,mergeCoordinatorReceipt,seedCoordinatorReceipt,isCoordinatorReceipt,coordinatorReceiptFailure,invalidCoordinatorReceipt,recoverCoordinatorSubmission,chatSubmission,forgetChatSubmission,coordinatorSubmissionPayload,saveCoordinatorDraft,forgetCoordinatorDraft,markCoordinatorDraft,
    userId,workspaceId,submissionScope:`coordinator:${userId}:workspace`,scope:{},sending:{current:null},pendingRef:{current:null},snapshotRef:{current:null},submissionError:{current:''},settledReceipts:new Map(),receivedReceipts:new Map(),missingReceipts:new Set(),localStorage:storage,pendingKey:()=>`pending:${userId}`,isCurrent:()=>true,useCallback:(fn:unknown)=>fn,
    setOutgoing:setter('outgoing'),setProgress:setter('progress'),setFailureReply:setter('failure'),setSettlement:setter('settlement'),setSnapshot:setter('snapshot'),setError:setter('error'),setCurrentPending:(value:string|null)=>{context.pendingRef.current=value;},
    refresh:async()=>{afterRefresh?.();},api:async(_path:string,options?:RequestInit)=>{const result=options?.method==='POST'?(postCount++,postResult):(readCount++,readResult);if(result instanceof Error)throw result;return result;},
  };
  context.acceptReceipt=makeAccept(context);const submit=makeSubmit(context) as (input:CoordinatorSubmission)=>Promise<string>;
  const input:CoordinatorSubmission={operationId:randomUUID(),text:'original request',attachmentIds:['attachment'],featureIds:['feature'],localExecution:false};
  const reply={id:'reply',role:'assistant' as const,content:'saved reply',createdAt:new Date().toISOString()};
  const completed=(failure?:CoordinatorReceipt['failure']):CoordinatorReceipt=>({status:'completed',failure,message:reply,conversation:{id:'main',userId,workspaceId,title:'ONE',modelId:'model',archived:false,createdAt:reply.createdAt,updatedAt:reply.createdAt,messages:[reply]}});
  return{state,context,submit,input,completed,set post(value:unknown){postResult=value;},set read(value:unknown){readResult=value;},set refresh(value:()=>void){afterRefresh=value;},get writes(){return postCount;},get reads(){return readCount;}};
}
test('the actual submit closure keeps a completion found during refresh and never adds transport fallback',async t=>{
  const f=fixture(t);f.refresh=()=>f.context.acceptReceipt(f.context.pendingRef.current,f.completed());
  await f.submit(f.input);assert.equal(f.state.settlement.status,'completed');assert.equal(f.state.failure,null);assert.equal(f.context.pendingRef.current,null);assert.equal(f.reads,0);assert.equal(f.writes,1);
});
for(const localExecution of [false,true])test(`actual ${localExecution?'local':'cloud'} handoff with a confirmed pending receipt keeps waiting`,async t=>{
  const f=fixture(t);f.read={status:'pending'};await f.submit({...f.input,localExecution});
  assert.ok(f.context.pendingRef.current);assert.equal(f.state.failure,null);assert.equal(f.state.settlement,null);assert.equal(f.writes,1);
  assert.equal(f.state.progress.phase,'正在等待处理结果');
  assert.equal(coordinatorDrafts(f.context.userId,f.context.workspaceId)[0].state,'pending');
});
test('an actual failed receipt retains its own feedback and resolves only its original ID',async t=>{
  const f=fixture(t);f.read={status:'failed',failure:{code:'notion_authorization',stage:'tool',outcome:'not_started'}};
  const operation=await f.submit(f.input);
  assert.match(f.state.failure.text,/Notion/);assert.doesNotMatch(f.state.failure.text,/提交编号/);assert.equal(f.state.settlement.status,'failed');assert.equal(f.context.pendingRef.current,null);
  assert.equal(pendingChatSubmissions(f.context.submissionScope).length,0);assert.equal(coordinatorDrafts(f.context.userId,f.context.workspaceId)[0].operationId,operation);
  assert.notEqual(await chatSubmission(f.context.submissionScope,coordinatorSubmissionPayload(f.input)),operation);
});
test('an old interrupted receipt without failure metadata keeps the explicit stopped feedback',async t=>{
  const f=fixture(t);f.read={status:'interrupted'};await f.submit(f.input);
  assert.equal(f.state.failure.text,coordinatorRecoveryCopy('',true));assert.equal(f.context.pendingRef.current,null);assert.equal(f.writes,1);
});
test('actual invalid 2xx payload retains the same ID until a subsequent valid read completes',async t=>{
  const f=fixture(t);f.post={};f.read={status:'queued'};
  const operation=await f.submit(f.input);assert.equal(f.state.settlement,null);assert.match(f.state.failure.text,/提交编号/);assert.equal(f.context.pendingRef.current,operation);assert.equal(f.writes,1);
  assert.equal(pendingChatSubmissions(f.context.submissionScope)[0].operationId,operation);
  f.context.acceptReceipt(operation,f.completed());assert.equal(f.state.failure,null);assert.equal(f.context.pendingRef.current,null);assert.equal(coordinatorDrafts(f.context.userId,f.context.workspaceId).length,0);
});
test('completed business failure keeps original references but review-only outcomes cannot restore a whole task',async t=>{
  const f=fixture(t);f.post=f.completed({code:'tool_incomplete',stage:'tool',outcome:'partial'});
  const operation=await f.submit(f.input);assert.equal(f.state.failure,null);assert.equal(f.state.outgoing.failed,false);assert.equal(coordinatorDrafts(f.context.userId,f.context.workspaceId)[0].state,'review');
  assert.notEqual(await chatSubmission(f.context.submissionScope,coordinatorSubmissionPayload(f.input)),operation);
});
test('a restart-interrupted receipt retains transport uncertainty rather than claiming a user stop',async t=>{
  const f=fixture(t);f.read={status:'interrupted',failure:{code:'transport_unknown',stage:'receipt',outcome:'unknown'}};
  await f.submit(f.input);assert.equal(f.state.settlement.status,'interrupted');assert.doesNotMatch(f.state.failure.text,/嗯，回复停下来了/);assert.equal(coordinatorDrafts(f.context.userId,f.context.workspaceId)[0].state,'review');
});
