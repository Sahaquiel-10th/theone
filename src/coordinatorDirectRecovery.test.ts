import {assertCoordinatorInput,CoordinatorInputTooLongError} from './coordinatorInput';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {ApiError} from './oneApi';
import {coordinatorRecoveryCopy,parseCoordinatorFailure,type CoordinatorFailure} from './coordinatorRecovery';
import {coordinatorRequest} from './coordinatorTransport';
import {coordinatorDirectSubmissionAccepted} from './coordinatorDirectRecovery';
import {unacceptedCoordinatorFailure} from './coordinatorSubmissionRecovery';
const source=readFileSync(new URL('./useCoordinator.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('async function direct('),source.indexOf('async function acknowledge(')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const actual=new Function('context',`with(context){${code};return direct;}`);
function fixture(response:unknown){
 const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 let writes=0,error='',reads=0;const context={assertCoordinatorInput,ApiError,parseCoordinatorFailure,coordinatorRecoveryCopy,coordinatorRequest,coordinatorDirectSubmissionAccepted,unacceptedCoordinatorFailure,submissionError:{current:''},setError:(value:string)=>{error=value;},userId:'user',workspaceId:'workspace',boundedApi:async()=>[],approveFeaturePrices:async()=>[],isCurrent:()=>true,directReceipts:{current:new Map<string,string>()},localStorage:storage,api:async()=>{writes++;if(response instanceof Error)throw response;return response;},load:async()=>{reads++;return{conversation:{id:'task',userId:'user',workspaceId:'workspace'},jobs:[] as {operationId:string;submissionOperationId?:string}[]};},refresh:async()=>{}};
 return{context,call:actual(context) as (id:string,text:string,files:string[],destination:string)=>Promise<void>,values,get writes(){return writes;},get error(){return error;},get reads(){return reads;}};
}
test('a saved direct handoff failure is not swallowed as a successful 202 or replaced by the old task',async()=>{
 const failure:CoordinatorFailure={code:'dispatch_not_started',stage:'planning',outcome:'not_started'};
 const f=fixture({taskId:'old-task',status:'failed',failure,message:{content:'这次停在安排任务，电脑和工作文件夹都不用重新配置。'}});
 await assert.rejects(f.call('old-task','save original article',[],'local'),error=>error instanceof ApiError&&error.failure?.code==='dispatch_not_started');
 assert.match(f.error,/停在安排任务.*不用重新配置/);assert.equal(f.writes,1);assert.equal(f.context.directReceipts.current.size,0);assert.equal(f.values.size,0);
 assert.equal(f.context.submissionError.current,f.error);
});
test('partial and uncertain direct failures retain the exact original ID and never create a second request automatically',async()=>{
 for(const outcome of ['partial','unknown'] as const){
  const failure:CoordinatorFailure={code:'model_unavailable',stage:'model',outcome},f=fixture({taskId:'original-task',status:'failed',failure,message:{content:'已有子任务，先核对原结果，不重做。'}});
  await assert.rejects(f.call('original-task','continue',[],'local'));assert.equal(f.writes,1);assert.equal(f.context.directReceipts.current.size,1);assert.equal(f.values.size,1);assert.match(f.error,/已有子任务/);
 }
});
test('a structured pre-acceptance direct rejection keeps its precise cause without a generic unknown receipt',async()=>{
 const failure:CoordinatorFailure={code:'local_folder_denied',stage:'accepting',outcome:'not_started'},f=fixture(new ApiError('原文件夹的访问未获允许。',undefined,428,'FOLDER_DENIED',false,failure,false));
 await assert.rejects(f.call('task','save original',[],'local'));assert.equal(f.error,'原文件夹的访问未获允许。');assert.equal(f.context.directReceipts.current.size,0);assert.doesNotMatch(f.error,/是否收到还没确认/);
});
test('unknown transport on direct continuation retains its ID for read-only reconciliation',async()=>{
 const f=fixture(new TypeError('Failed to fetch'));await assert.rejects(f.call('task','continue',[],'local'),error=>error instanceof ApiError&&error.code==='COORDINATOR_DIRECT_UNCONFIRMED');
 assert.equal(f.writes,1);assert.equal(f.context.directReceipts.current.size,1);assert.match(f.error,/先查看任务进展/);
});

test('an oversized direct supplement never requests approval, stores an operation or clears the original text',async()=>{
 const f=fixture({}),text='首'+'中'.repeat(32000)+'尾',files=['owned-file'];let approvals=0;
 f.context.approveFeaturePrices=async()=>{approvals++;return[];};
 await assert.rejects(f.call('task',text,files,'chat'),CoordinatorInputTooLongError);
 assert.equal(approvals,0);assert.equal(f.writes,0);assert.equal(f.reads,0);assert.equal(f.values.size,0);assert.equal(f.context.directReceipts.current.size,0);
 assert.equal(text.length,32002);assert.deepEqual(files,['owned-file']);
});

const ownDetail=(jobs:unknown[])=>({conversation:{id:'task',userId:'user',workspaceId:'workspace'},jobs});
const expected={userId:'user',workspaceId:'workspace',taskId:'task',operationId:'submission-original'};
test('direct acceptance recognizes only exact IDs in the authenticated owner and task detail',()=>{
 for(const job of [{operationId:expected.operationId},{operationId:'child-exact',submissionOperationId:expected.operationId,state:'queued'},{operationId:'child-failed',submissionOperationId:expected.operationId,state:'failed'}]){
  assert.equal(coordinatorDirectSubmissionAccepted(ownDetail([job]),expected),true,'acceptance is not a claim that the job completed');
 }
 for(const job of [{operationId:expected.operationId+'_child'},{operationId:'child',submissionOperationId:expected.operationId+'_other'},{operationId:expected.operationId.slice(0,-1)},{operationId:'child',submissionOperationId:expected.operationId.toUpperCase()},null,{}]){
  assert.equal(coordinatorDirectSubmissionAccepted(ownDetail([job]),expected),false,'similar IDs and prefixes do not prove this submission was accepted');
 }
 for(const conversation of [{id:'other-task',userId:'user',workspaceId:'workspace'},{id:'task',userId:'other-user',workspaceId:'workspace'},{id:'task',userId:'user',workspaceId:'other-workspace'}]){
  assert.equal(coordinatorDirectSubmissionAccepted({conversation,jobs:[{operationId:expected.operationId}]},expected),false);
 }
 for(const detail of [undefined,null,{},[],{jobs:[{operationId:expected.operationId}]},{conversation:ownDetail([]).conversation,jobs:{operationId:expected.operationId}}])assert.equal(coordinatorDirectSubmissionAccepted(detail,expected),false);
 assert.equal(coordinatorDirectSubmissionAccepted(ownDetail([{operationId:expected.operationId}]),{...expected,workspaceId:''}),false,'unknown workspace cannot confirm another scope');
});

for(const error of [new TypeError('Failed to fetch'),new ApiError('ack timed out',undefined,undefined,'COORDINATOR_READ_TIMEOUT',false,{code:'transport_unknown',stage:'receipt',outcome:'unknown'}),new ApiError('bad JSON ack',undefined,200,'INVALID_RESPONSE',false,{code:'invalid_receipt',stage:'receipt',outcome:'unknown'})])test(`a lost direct acknowledgement finds its exact accepted child without another POST: ${error.message}`,async()=>{
 const f=fixture(error);let submitted='';
 f.context.load=async()=>{
  submitted=[...f.context.directReceipts.current.values()][0];
  return ownDetail([{operationId:'unrelated-old-job'},{operationId:'server-generated-child',submissionOperationId:submitted}]) as Awaited<ReturnType<typeof f.context.load>>;
 };
 await f.call('task','use this current material',[],'chat');
 assert.ok(submitted);assert.equal(f.writes,1);assert.equal(f.error,'');assert.equal(f.context.submissionError.current,'');
 assert.equal(f.context.directReceipts.current.size,0);assert.equal(f.values.size,0,'only proved acceptance clears the stored submission');
});

test('a prefix-like old job leaves a lost direct acknowledgement unknown with its exact ID retained',async()=>{
 const f=fixture(new ApiError('ack timed out',undefined,undefined,'COORDINATOR_READ_TIMEOUT',false,{code:'transport_unknown',stage:'receipt',outcome:'unknown'}));let submitted='';
 f.context.load=async()=>{submitted=[...f.context.directReceipts.current.values()][0];return ownDetail([{operationId:submitted+'_child'}]) as Awaited<ReturnType<typeof f.context.load>>;};
 await assert.rejects(f.call('task','use this current material',[],'chat'),error=>error instanceof ApiError&&error.code==='COORDINATOR_DIRECT_UNCONFIRMED');
 assert.equal(f.writes,1);assert.equal([...f.context.directReceipts.current.values()][0],submitted);assert.equal(f.values.size,1);assert.match(f.error,/是否收到还没确认/);
});

test('a saved failed direct reply remains a failure even when its exact child is visible',async()=>{
 const failure:CoordinatorFailure={code:'invalid_receipt',stage:'receipt',outcome:'unknown'},f=fixture({status:'failed',failure,message:{content:'原操作的结果还没确认，先保留已有成果。'}});
 f.context.load=async()=>{
  const submitted=[...f.context.directReceipts.current.values()][0];
  return ownDetail([{operationId:'child',submissionOperationId:submitted}]) as Awaited<ReturnType<typeof f.context.load>>;
 };
 await assert.rejects(f.call('task','continue current work',[],'chat'),error=>error instanceof ApiError&&error.code==='COORDINATOR_DIRECT_FAILED');
 assert.equal(f.writes,1);assert.equal(f.context.directReceipts.current.size,1);assert.equal(f.values.size,1);assert.match(f.error,/原操作的结果还没确认/);
});

test('an account switch during accepted-child readback does not settle or clear the old submission',async()=>{
 const original=new TypeError('Failed to fetch'),f=fixture(original);
 f.context.load=async()=>{
  const submitted=[...f.context.directReceipts.current.values()][0];f.context.isCurrent=()=>false;
  return ownDetail([{operationId:'child',submissionOperationId:submitted}]) as Awaited<ReturnType<typeof f.context.load>>;
 };
 await assert.rejects(f.call('task','continue current work',[],'chat'),error=>error===original);
 assert.equal(f.writes,1);assert.equal(f.context.directReceipts.current.size,1);assert.equal(f.values.size,1);assert.equal(f.error,'');
});

test('a confirmed direct acknowledgement does not wait for a slow detail refresh', {timeout:500},async()=>{
 const f=fixture({status:'accepted'});f.context.load=async()=>new Promise(()=>{});
 await f.call('task','continue current work',[],'chat');
 assert.equal(f.writes,1);assert.equal(f.context.directReceipts.current.size,0);assert.equal(f.values.size,0);assert.equal(f.error,'');
});
