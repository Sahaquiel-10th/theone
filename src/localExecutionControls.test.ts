import test from 'node:test';
import assert from 'node:assert/strict';
import React,{createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {ExecutionReconcileStop} from './ExecutionReconcileStop';
import {executionRecovery,executionCancellationRequest} from './executionRecovery';

const source=readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
function actual(start:string,end:string,name:string,context:Record<string,unknown>){
 const code=ts.transpileModule(source.slice(source.indexOf(start),source.indexOf(end)),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.React}}).outputText;
 return new Function('context',`with(context){${code};return ${name};}`)(context) as (...args:any[])=>any;
}
const held={id:'old-exact',conversationId:'conversation',status:'cancelled',reportRound:2,updatedAt:'2026-11-01T00:00:00.000Z',requiresExecutionCheck:true};
test('a held-busy device cannot start more work but the actual old-round recovery controls remain usable',()=>{
 const Icon=()=>null;
 const Disclosure=actual('function ExecutionDisclosure(','type TaskNotice','ExecutionDisclosure',{React,useState:()=>['',()=>{}],useContext:()=>{},PrivateApiContext:{},friendlyExecutionProgress:()=>'',executionNeedsReview:()=>false,executionStatusLabel:()=>'',isExecutionRunning:()=>false,executionRecovery,Check:Icon,ChevronDown:Icon,Square:Icon,ExecutionReconcileStop,MessageMarkdown:()=>null,StaticPreviewPanel:()=>null});
 const html=renderToStaticMarkup(createElement(Disclosure,{task:held,events:[],preparing:false,expanded:true,onToggle(){},onStop(){},actorRole:'admin',continuationDisabled:true}));
 assert.match(html,/再次请求停止原操作/);assert.match(html,/人工核对并结束旧占用/);
 assert.doesNotMatch(html,/<button[^>]*disabled[^>]*>[^<]*(?:再次请求停止|人工核对)/);
 assert.doesNotMatch(html,/<button[^>]*disabled[^>]*class="execution-stop"|<button[^>]*class="execution-stop"[^>]*disabled/);
});
test('a requires-check cancelled task sends stop to the exact original round instead of silently ignoring it',async()=>{
 const writes:unknown[]=[],stopped=new Set<string>();
 const cancel=actual('async function cancelExecution(','const visibleReceipt =','cancelExecution',{executionPreparationRef:{current:null},preparingExecution:false,awaitingExecutionOperationId:'',executionTask:held,isExecutionRunning:()=>false,executionCancellationRequest,stoppedExecutionIdsRef:{current:stopped},takeoverTaskId:'old-exact',runningExecutions:[],transitionExecutionMode(){},executionOriginRef:{current:null},api:async(...args:unknown[])=>{writes.push(args);},refreshExecutionTasks:async()=>{},setError(){}});
 await cancel(null,held);assert.deepEqual(writes,[['/api/executions/old-exact/cancel',{method:'POST',body:JSON.stringify({expectedRound:2})}]]);
});
test('execution material has its own lifecycle and does not change the execution lock',()=>{
 assert.match(source,/const activeExecutionMode = executionAppearance\.active;/);
 assert.match(source,/const executionBusy = runningExecutions\.length > 0;/);
 assert.match(source,/const runningExecutions = executionTasks\.filter\(isExecutionRunning\);/);
 assert.match(source,/executionActive=\{activeExecutionMode\}/);
 assert.match(source,/activeExecutionMode \? "execution-shell"/);
});
test('stopping an explicit old target cannot cancel an unrelated new preparation',async()=>{
 const writes:unknown[]=[],preparation={operationId:'new-preparation',coordinator:true,cancelled:false};
 const cancel=actual('async function cancelExecution(','const visibleReceipt =','cancelExecution',{executionPreparationRef:{current:preparation},preparingExecution:true,awaitingExecutionOperationId:'new-preparation',isExecutionRunning:()=>false,executionCancellationRequest,stoppedExecutionIdsRef:{current:new Set()},takeoverTaskId:'old-exact',runningExecutions:[],transitionExecutionMode(){},executionOriginRef:{current:null},api:async(...args:unknown[])=>{writes.push(args);},refreshExecutionTasks:async()=>{},setError(){}});
 await cancel(null,held);assert.equal(preparation.cancelled,false);assert.deepEqual(writes,[['/api/executions/old-exact/cancel',{method:'POST',body:JSON.stringify({expectedRound:2})}]]);
});
test('a preparation stop without a target only stops its exact pending operation',async()=>{
 const writes:unknown[]=[],preparation={operationId:'new-preparation',coordinator:true,cancelled:false},stopped=new Set();
 const cancel=actual('async function cancelExecution(','const visibleReceipt =','cancelExecution',{executionPreparationRef:{current:preparation},preparingExecution:true,awaitingExecutionOperationId:'new-preparation',stoppedPreparationIdsRef:{current:stopped},setAwaitingExecutionOperationId(){},transitionExecutionMode(){},pointFromElement:()=>null,api:async(...args:unknown[])=>{writes.push(args);},setNotice(){},setError(){}});
 await cancel(null,null);assert.equal(preparation.cancelled,true);assert.equal(stopped.has('local_new-preparation'),true);assert.deepEqual(writes,[['/api/coordinator/messages/new-preparation/stop',{method:'POST'}]]);
});
test('a confirmed successful conversation deletion clears only its local appearance and selected executions',async()=>{
 const local={id:'local-a',conversationId:'thing-a'},other={id:'local-b',conversationId:'thing-b'};
 let tasks=[local,other],selected='local-a',takeover='local-b';const forgotten:string[]=[],writes:unknown[]=[];
 const remove=actual('async function deleteConversation(','async function moveConversation','deleteConversation',{
  confirm:()=>true,api:async(...args:unknown[])=>{writes.push(args);},executionAppearance:{forgetConversation:(id:string)=>forgotten.push(id)},executionTasks:tasks,
  setExecutionTasks:(update:(items:typeof tasks)=>typeof tasks)=>{tasks=update(tasks);},setSelectedExecutionId:(update:(id:string)=>string)=>{selected=update(selected);},setTakeoverTaskId:(update:(id:string)=>string)=>{takeover=update(takeover);},setConversations(){},activeId:'other',setActiveId(){}
 });
 await remove({id:'thing-a',title:'Test'});assert.deepEqual(writes,[['/api/conversations/thing-a',{method:'DELETE'}]]);assert.deepEqual(forgotten,['thing-a']);assert.deepEqual(tasks,[other]);assert.equal(selected,'');assert.equal(takeover,'local-b');
});
test('declined or failed conversation deletion never clears a live appearance',async()=>{
 for(const confirmed of [false,true]){
  const forgotten:string[]=[],writes:unknown[]=[];
  const remove=actual('async function deleteConversation(','async function moveConversation','deleteConversation',{
   confirm:()=>confirmed,api:async(...args:unknown[])=>{writes.push(args);throw Error('not deleted');},executionAppearance:{forgetConversation:(id:string)=>forgotten.push(id)}
  });
  if(confirmed)await assert.rejects(remove({id:'thing-a',title:'Test'}),/not deleted/);else await remove({id:'thing-a',title:'Test'});
  assert.deepEqual(forgotten,[]);assert.equal(writes.length,Number(confirmed));
 }
});
