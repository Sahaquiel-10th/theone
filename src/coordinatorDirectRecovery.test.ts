import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {ApiError} from './oneApi';
import {coordinatorRecoveryCopy,parseCoordinatorFailure,type CoordinatorFailure} from './coordinatorRecovery';
import {coordinatorRequest} from './coordinatorTransport';
const source=readFileSync(new URL('./useCoordinator.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source.slice(source.indexOf('async function direct('),source.indexOf('async function acknowledge(')),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const actual=new Function('context',`with(context){${code};return direct;}`);
function fixture(response:unknown){
 const values=new Map<string,string>(),storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
 let writes=0,error='',reads=0;const context={ApiError,parseCoordinatorFailure,coordinatorRecoveryCopy,coordinatorRequest,submissionError:{current:''},setError:(value:string)=>{error=value;},userId:'user',workspaceId:'workspace',boundedApi:async()=>[],approveFeaturePrices:async()=>[],isCurrent:()=>true,directReceipts:{current:new Map<string,string>()},localStorage:storage,api:async()=>{writes++;if(response instanceof Error)throw response;return response;},load:async()=>{reads++;return{jobs:[]};},refresh:async()=>{}};
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
