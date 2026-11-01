import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {localDeviceCanRequestExecution,type LocalDeviceReadiness} from './localDeviceReadiness';
import {coordinatorRestoredLocalIntent} from './coordinatorRestoredLocalIntent';
const source=readFileSync(new URL('./main.tsx',import.meta.url),'utf8');
const noAttachments={uploadingAttachments:false,pendingAttachments:[],composeMode:'chat'};
function actual(start:string,end:string,name:string,context:Record<string,unknown>){
 const code=ts.transpileModule(source.slice(source.indexOf(start),source.indexOf(end)),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 return new Function('context',`with(context){${code};return ${name};}`)(context) as (...args:any[])=>Promise<void>;
}
for(const text of ['为什么一直让我选文件夹？','刚才那篇文章做好了吗？','把这段保存成文档'])test(`local destination does not turn ${text} into an explicit local execution`,async()=>{
 const requests:unknown[]=[],executions:unknown[]=[];
 const send=actual('async function send(event: FormEvent)','async function retryFailedMessage','send',{composeMode:'chat',outputDestination:'local',coordinator:{enabled:true},restoredCoordinatorSubmission:{current:null},content:text,preview:{enabled:true},sendMessage:async(...args:unknown[])=>{requests.push(args);},executeDraft:async(...args:unknown[])=>{executions.push(args);},targetConversation:null,document:{getElementById:()=>null}});
 await send({preventDefault(){}});assert.deepEqual(requests,[[text]]);assert.deepEqual(executions,[]);
});
test('the explicit execute button still sends an intentional localExecution flag',async()=>{
 const calls:unknown[]=[],context={...noAttachments,preparingExecution:false,executionBusy:false,localDevice:{ready:true,canRequestExecution:true},executionOriginRef:{current:null},pointFromElement:()=>({x:0,y:0}),executionPreparationRef:{current:null},coordinator:{enabled:true},setTakeoverTaskId(){},setPreparingExecution(){},transitionExecutionMode(){},sendMessage:async(...args:unknown[])=>{calls.push(args);return true;},refreshExecutionTasks:async()=>{}};
 const execute=actual('async function executeDraft(','async function sendExecutionMessage','executeDraft',context);
 await execute('create this file',{});assert.deepEqual(calls,[['create this file',true]]);
});
test('an existing task with a local preference sends its explanatory follow-up to the coordinator, not directly to the computer',async()=>{
 const calls:unknown[]=[],task={id:'task',modelId:'model'};
 const continueThing=actual('async function continueThing(','useEffect(() => { if (demo.enabled)','continueThing',{demo:{enabled:false},conversations:[task],thingDestinations:{task:'local'},models:[{id:'model',kind:'chat'}],coordinator:{enabled:true,direct:async(...args:unknown[])=>{calls.push(args);}},executeDraft(){throw new Error('An explanatory follow-up must not execute locally.');}});
 await continueThing('task','为什么又让我选目录？');assert.deepEqual(calls,[['task','为什么又让我选目录？',[],'local']]);
});
test('first-time folder selection is allowed only after an explicit local action; an inaccessible old folder is blocked',async()=>{
 const base:LocalDeviceReadiness={checkedAt:new Date().toISOString(),ready:false,connected:true,folder:{state:'unselected'},executor:{state:'ready',installedVersion:'0.4.29'},reason:'folder_unselected'};
 for(const value of [base,{...base,connected:false,folder:{state:'unknown'},executor:{state:'unknown'},reason:'offline'},{...base,folder:{state:'denied'},reason:'folder_denied'},{...base,folder:{state:'unavailable'},reason:'folder_unavailable'},{...base,executor:{state:'busy'},reason:'busy'}] as LocalDeviceReadiness[]){
  const calls:unknown[]=[],canRequestExecution=localDeviceCanRequestExecution(value);
  const execute=actual('async function executeDraft(','async function sendExecutionMessage','executeDraft',{...noAttachments,preparingExecution:false,executionBusy:false,localDevice:{ready:false,canRequestExecution},executionOriginRef:{current:null},pointFromElement:()=>({x:0,y:0}),executionPreparationRef:{current:null},coordinator:{enabled:true},setTakeoverTaskId(){},setPreparingExecution(){},transitionExecutionMode(){},sendMessage:async(...args:unknown[])=>{calls.push(args);return true;},refreshExecutionTasks:async()=>{}});
  await execute('create a new document',{});assert.equal(calls.length,value===base?1:0);assert.equal(value.ready,false);
 }
});
test('the real execute button accepts ready coordinator attachments only; existing execution continuation stays restricted',()=>{
 const disabled=source.slice(source.indexOf('className="composer-execute"')).match(/disabled=\{([^}]+)\}/)![1];
 const check=(context:Record<string,unknown>)=>new Function('context',`with(context){return ${disabled};}`)({content:'处理这张图',targetLoading:false,preparingExecution:false,executionBusy:false,localDevice:{canRequestExecution:true},...noAttachments,coordinator:{enabled:true},...context});
 assert.equal(check({pendingAttachments:[{id:'image',status:'ready'}]}),false);
 assert.equal(check({pendingAttachments:[{id:'document',status:'ready'}]}),false);
 for(const status of ['queued','parsing','failed',undefined])assert.equal(check({pendingAttachments:[{id:'image',status}]}),true);
 assert.equal(check({uploadingAttachments:true,pendingAttachments:[{id:'image',status:'ready'}]}),true);
 assert.equal(check({coordinator:{enabled:false},pendingAttachments:[{id:'image',status:'ready'}]}),true);
 const continuation=source.slice(source.indexOf('id="one-studio-send"'),source.indexOf('className="composer-execute"'));
 assert.match(continuation,/composeMode === "execution"[\s\S]*pendingAttachments.length > 0/);
});
test('executeDraft defends attachment eligibility before preparation so legacy and unfinished files cannot disappear',async()=>{
 for(const change of [{uploadingAttachments:true},{pendingAttachments:[{id:'file',status:'parsing'}]},{pendingAttachments:[{id:'file',status:undefined}]},{composeMode:'execution'},{coordinator:{enabled:false}},{conversationId:'legacy-task'}]){
  const calls:unknown[]=[],executionPreparationRef={current:null};
  const context={...noAttachments,pendingAttachments:[{id:'file',status:'ready'}],preparingExecution:false,executionBusy:false,localDevice:{canRequestExecution:true},executionOriginRef:{current:null},pointFromElement:()=>null,executionPreparationRef,coordinator:{enabled:true},setTakeoverTaskId(){},setPreparingExecution(){},transitionExecutionMode(){},setError(){},sendMessage:async(...args:unknown[])=>{calls.push(args);return true;},refreshExecutionTasks:async()=>{},...change};
  await actual('async function executeDraft(','async function sendExecutionMessage','executeDraft',context)('处理文件',{},change.conversationId);
  assert.deepEqual(calls,[]);assert.equal(executionPreparationRef.current,null);
 }
});
test('ready attachments traverse the actual executeDraft and sendMessage closures with exact IDs',async()=>{
 const submissions:Record<string,unknown>[]=[],files=[{id:'owned-image',status:'ready'},{id:'owned-document',status:'ready'}],noop=()=>{};
 const context:Record<string,any>={...noAttachments,pendingAttachments:files,featurePicker:{close:noop},demo:{enabled:false},currentModel:{kind:'chat'},composeNew:false,draftAgentId:'',featureForNext:[],coordinatorFailedDraft:{current:null},executionPreparationRef:{current:null},currentDraftRef:{current:{content:'处理这两个文件'}},draftModelId:'router',canSearch:false,restoredCoordinatorSubmission:{current:null},setAwaitingExecutionOperationId:noop,setContent:noop,setPendingAttachments:noop,setFeatureForNext:noop,setError:noop,setPreviewHome:noop,setHasSubmittedChat:noop,
  coordinator:{enabled:true,state:{pending:null,boundTask:null},submit:async(input:Record<string,unknown>)=>{submissions.push(input);return input.operationId;}},preparingExecution:false,executionBusy:false,localDevice:{canRequestExecution:true},executionOriginRef:{current:null},pointFromElement:()=>null,setTakeoverTaskId:noop,setPreparingExecution:noop,transitionExecutionMode:noop,refreshExecutionTasks:async()=>{}};
 context.sendMessage=actual('async function sendMessage(','async function send(event: FormEvent)','sendMessage',context);
 await actual('async function executeDraft(','async function sendExecutionMessage','executeDraft',context)('处理这两个文件',{});
 assert.equal(submissions.length,1);assert.equal(submissions[0].localExecution,true);assert.deepEqual(submissions[0].attachmentIds,['owned-image','owned-document']);assert.equal(submissions[0].outputDestination,undefined);
});
test('only an exact user-restored local retry retains its execute intent; editing it into a question does not',async()=>{
 for(const changed of [false,true]){
  const calls:unknown[]=[],executions:unknown[]=[],original={operationId:'original-operation',text:'create the original document',localExecution:true,modelId:'model',attachmentIds:[],featureIds:[],webSearch:false};
  const context={composeMode:'chat',outputDestination:'local',coordinator:{enabled:true,state:{boundTask:null}},restoredCoordinatorSubmission:{current:original},coordinatorRestoredLocalIntent,content:changed?'Why did the previous task stop?':original.text,draftModelId:'model',pendingAttachments:[],featureForNext:[],canSearch:false,localDevice:{canRequestExecution:true},preview:{enabled:true},sendMessage:async(...args:unknown[])=>{calls.push(args);},executeDraft:async(...args:unknown[])=>{executions.push(args);},targetConversation:null,document:{getElementById:()=>null}};
  await actual('async function send(event: FormEvent)','async function retryFailedMessage','send',context)({preventDefault(){}});
  assert.equal(executions.length,changed?0:1);assert.equal(calls.length,changed?1:0);
 }
});
