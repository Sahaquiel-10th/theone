import test from 'node:test';
import assert from 'node:assert/strict';
import type {ChatOperation} from './chatOperations.js';
import type {WorkRun} from './coordinatorTypes.js';
import type {TaskStep} from './taskSteps.js';
import {taskStepKey} from './taskSteps.js';
import {createWorkflowRun,workflowPhase,type WorkflowStep} from './taskWorkflow.js';
import {buildWorkflowStepContext} from './workflowContext.js';
import {selectWorkflowKnowledgeReferences,resolveWorkflowKnowledgeInputs,WorkflowKnowledgeInputError} from './workflowKnowledgeInputs.js';

const owner={workspaceId:'workspace_a',userId:'user_a'},taskId='task_a';
const step=(id:string,other:Partial<WorkflowStep>={}):WorkflowStep=>({id,title:id,instruction:`完成${id}`,kind:'model',inputs:[],...other});
function operation(id:string,minute:number,read=false):ChatOperation{
 const steps=[...(read?[step('source',{kind:'tool',tool:'knowledge_search',instruction:'昨天的产品设计笔记'})]:[]),step('write_column',{inputs:read?['source']:[]}),step('save_notion',{kind:'notion',inputs:['write_column']})];
 const workflow=createWorkflowRun({version:1,steps},{...owner,operationId:id});
 const workRun={state:'queued',workflow,steps:[],sources:[{id:'getnote_a',binding:'exact_connection_binding'}],contract:{version:1,knowledgeSourceIds:['getnote_a'],requiredTools:['knowledge_search']},instruction:'把昨天的产品想法写成完整专栏并保存到 Notion。',runtimeContext:{at:'2026-11-16T06:00:00.000Z',timeZone:'Asia/Shanghai',today:'2026-11-16',yesterday:'2026-11-15'},materialSources:[{version:1,...owner,taskId,inputMessageId:'original_user',contentDigest:'a'.repeat(64),attachmentIds:['attachment_a']}]} as unknown as WorkRun;
 const at=`2026-11-16T06:${String(minute).padStart(2,'0')}:00.000Z`;
 return {...owner,id,operationId:`submission_${id}`,requestId:`request_${id}`,payloadHash:'hash',status:'pending',conversationId:taskId,createdAt:at,updatedAt:at,workRun};
}
function completeRead(operation:ChatOperation,content='完整的得到笔记正文，产品应先验证需求再讨论技术。'){
 const run=operation.workRun!,workflow=run.workflow!,source=workflow.spec.steps.find(step=>step.id==='source')!;
 const namespace=`workflow:${workflow.id}`,tool=`workflow:${workflow.id}:${source.id}`,key=taskStepKey(namespace,tool,JSON.stringify({revision:workflow.revision,instruction:source.instruction,inputs:source.inputs}));
 const result={status:'used',chunks:[{id:'note_a',provider:'getnote',title:'产品想法',content,sourceUrl:'https://example.test/private-note',createdAt:'2026-11-15T01:00:00Z',dateEvidence:{basis:'event',date:'2026-11-15',status:'confirmed'},truncated:false}],coverage:[{connectionId:'getnote_a',provider:'getnote',status:'used',attempts:1}],failures:[],temporal:{complete:false,note:'有限检索范围。'}};
 const checkpoint:TaskStep={key,namespace,tool,scopeId:operation.id,label:'已取得笔记',effect:'read',state:'completed',updatedAt:operation.updatedAt,operation:{version:1,execution:'succeeded',verification:'not_required',artifactRef:key},output:{workflow:{version:1,runId:workflow.id,revision:workflow.revision,stepId:source.id},outcome:'completed',result}};
 run.steps!.push(checkpoint);workflow.steps[0]={id:source.id,state:'completed',checkpointKey:key};workflow.phase=workflowPhase(workflow.spec,workflow.steps);
 return checkpoint;
}
function failWriting(operation:ChatOperation){
 const run=operation.workRun!,workflow=run.workflow!,index=workflow.spec.steps.findIndex(step=>step.id==='write_column');
 workflow.steps[index]={id:'write_column',state:'failed',summary:'写作尚未交付正文。'};workflow.steps[index+1]={id:'save_notion',state:'waiting',waitingFor:'inputs'};workflow.phase=workflowPhase(workflow.spec,workflow.steps);run.state='failed';operation.status='completed';
}
function fixture(){
 const original=operation('original',0,true),checkpoint=completeRead(original);failWriting(original);
 const previous=operation('failed_continuation',1);previous.workRun!.instruction+='继续写，然后保存。';previous.workRun!.knowledgeContext=selectWorkflowKnowledgeReferences(previous,[original,previous]);failWriting(previous);
 const current=operation('current',2);current.workRun!.instruction+='继续完成正文。';
 return {original,previous,current,checkpoint,operations:[original,previous,current]};
}

test('a model-only continuation receives the exact earlier completed knowledge through immutable references',()=>{
 const f=fixture(),before=structuredClone(f.operations),references=selectWorkflowKnowledgeReferences(f.current,f.operations);
 assert.equal(references.length,1);assert.equal(references[0].originOperationId,f.original.id);assert.equal(references[0].checkpointKey,f.checkpoint.key);assert.match(references[0].resultDigest,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(references),/完整的得到笔记|private-note|产品想法/);
 assert.deepEqual(f.operations,before,'selection does not mutate either run or copy knowledge into the next checkpoint store');
 f.current.workRun!.knowledgeContext=references;
 const inputs=resolveWorkflowKnowledgeInputs(f.current,f.operations),knowledge=inputs.filter(input=>input.kind==='knowledge');
 assert.equal(knowledge.length,1);assert.equal(knowledge[0].content,'完整的得到笔记正文，产品应先验证需求再讨论技术。');assert.equal(knowledge[0].operationId,f.current.id);assert.equal(knowledge[0].originOperationId,f.original.id);assert.equal(knowledge[0].source,'getnote');assert.equal(knowledge[0].truncated,false);assert.equal(knowledge[0].complete,false);assert.deepEqual(knowledge[0].dateEvidence,{basis:'event',date:'2026-11-15',status:'confirmed'});
 const context=buildWorkflowStepContext({scope:{...owner,operationId:f.current.id},modelSystemPrompt:'原始写作规则',goal:f.current.workRun!.instruction,constraints:[],step:f.current.workRun!.workflow!.spec.steps[0],inputs});
 assert.equal(context.selection.knowledgeCandidates,1);assert.equal(context.selection.selectedKnowledge,1);assert.match(context.messages[2].content!,/完整的得到笔记正文/);assert.equal(f.current.workRun!.steps!.length,0);
});

test('further continuations resolve the same original read without a connector call or material copy',()=>{
 const f=fixture();f.current.workRun!.knowledgeContext=selectWorkflowKnowledgeReferences(f.current,f.operations);failWriting(f.current);
 const next=operation('next',3),operations=[...f.operations,next];next.workRun!.knowledgeContext=selectWorkflowKnowledgeReferences(next,operations);
 assert.deepEqual(next.workRun!.knowledgeContext,f.current.workRun!.knowledgeContext);assert.equal(resolveWorkflowKnowledgeInputs(next,operations)[0].originOperationId,f.original.id);assert.equal(next.workRun!.steps!.length,0);
});

test('changed source authorization, selected IDs, material lineage or date constraints reject inheritance',()=>{
 const mutations:((f:ReturnType<typeof fixture>)=>void)[]=[
  f=>{f.current.workRun!.sources[0].binding='rotated_connection';},
  f=>{f.current.workRun!.sources=[];},
  f=>{f.current.workRun!.sources.push({id:'notion_a',binding:'notion_binding'});},
  f=>{f.current.workRun!.contract!.knowledgeSourceIds=[];},
  f=>{f.current.workRun!.materialSources![0].contentDigest='b'.repeat(64);},
  f=>{f.current.workRun!.materialSources![0].attachmentIds=['new_attachment'];},
  f=>{f.current.workRun!.materialSources=[];},
  f=>{f.current.workRun!.runtimeContext!.yesterday='2026-11-14';},
  f=>{f.current.workRun!.instruction='改用今天的产品想法写专栏。';},
  f=>{f.current.workRun!.runtimeContext=undefined;},
 ];
 for(const mutate of mutations){
  const f=fixture(),refs=selectWorkflowKnowledgeReferences(f.current,f.operations);mutate(f);
  assert.deepEqual(selectWorkflowKnowledgeReferences(f.current,f.operations),[]);f.current.workRun!.knowledgeContext=refs;assert.throws(()=>resolveWorkflowKnowledgeInputs(f.current,f.operations),WorkflowKnowledgeInputError);
 }
});

test('foreign workspace, user, task and operation bindings never become writer inputs',()=>{
 const mutations:((f:ReturnType<typeof fixture>)=>void)[]=[
  f=>{f.original.workspaceId='other_workspace';},f=>{f.original.userId='other_user';},f=>{f.original.conversationId='other_task';},
  f=>{f.original.workRun!.workflow!.binding.workspaceId='other_workspace';},f=>{f.original.workRun!.workflow!.binding.userId='other_user';},f=>{f.original.workRun!.workflow!.binding.operationId='other_operation';},
  f=>{f.current.workRun!.workflow!.binding.operationId='other_operation';},f=>{f.original.executionCancelled=true;},
 ];
 for(const mutate of mutations){
  const f=fixture(),refs=selectWorkflowKnowledgeReferences(f.current,f.operations);mutate(f);
  assert.deepEqual(selectWorkflowKnowledgeReferences(f.current,f.operations),[]);f.current.workRun!.knowledgeContext=refs;assert.throws(()=>resolveWorkflowKnowledgeInputs(f.current,f.operations),WorkflowKnowledgeInputError);
 }
});

test('SQL object key reordering preserves digest while changed result bytes reject a stored reference',()=>{
 const f=fixture();f.current.workRun!.knowledgeContext=selectWorkflowKnowledgeReferences(f.current,f.operations);
 const output=f.checkpoint.output as any,result=output.result;
 output.result={temporal:{note:result.temporal.note,complete:false},failures:[],coverage:result.coverage.map((entry:any)=>({attempts:entry.attempts,status:entry.status,provider:entry.provider,connectionId:entry.connectionId})),chunks:result.chunks.map((chunk:any)=>Object.fromEntries(Object.entries(chunk).reverse())),status:'used'};
 assert.equal(resolveWorkflowKnowledgeInputs(f.current,f.operations)[0].content,result.chunks[0].content);
 output.result.chunks[0].content+=' changed';assert.throws(()=>resolveWorkflowKnowledgeInputs(f.current,f.operations),WorkflowKnowledgeInputError);
});

test('missing, duplicated, unproved and wrongly scoped checkpoints fail explicitly after reference creation',()=>{
 const mutations:((f:ReturnType<typeof fixture>)=>void)[]=[
  f=>{f.original.workRun!.steps=[];},f=>{f.original.workRun!.steps!.push(structuredClone(f.checkpoint));},
  f=>{f.checkpoint.scopeId='other_operation';},f=>{f.checkpoint.namespace='other_namespace';},f=>{f.checkpoint.effect='model';},f=>{f.checkpoint.state='started';},
  f=>{(f.checkpoint.output as any).workflow.revision=99;},f=>{f.checkpoint.operation!.artifactRef='other_checkpoint';},
  f=>{f.operations.splice(0,1);},f=>{f.operations.push(structuredClone(f.original));},
 ];
 for(const mutate of mutations){const f=fixture();f.current.workRun!.knowledgeContext=selectWorkflowKnowledgeReferences(f.current,f.operations);mutate(f);assert.throws(()=>resolveWorkflowKnowledgeInputs(f.current,f.operations),WorkflowKnowledgeInputError);}
});

test('a newer failed knowledge attempt blocks fallback to an older successful search',()=>{
 const f=fixture(),newRead=operation('newer_search',1,true),workflow=newRead.workRun!.workflow!;
 workflow.steps[0]={id:'source',state:'failed'};workflow.steps[1]={id:'write_column',state:'waiting',waitingFor:'inputs'};workflow.steps[2]={id:'save_notion',state:'waiting',waitingFor:'inputs'};workflow.phase=workflowPhase(workflow.spec,workflow.steps);newRead.workRun!.state='failed';
 assert.deepEqual(selectWorkflowKnowledgeReferences(f.current,[f.original,newRead,f.current]),[]);
});

test('an unbound model-only revision is a material boundary even when connection and date snapshots are unchanged',()=>{
 const f=fixture();f.previous.workRun!.instruction+='本轮改为写另一个主题。';f.previous.workRun!.knowledgeContext=undefined;
 assert.deepEqual(selectWorkflowKnowledgeReferences(f.current,f.operations),[]);
});

test('legacy continuation skips require fresh caller-proved operation IDs at both selection and resolution',()=>{
 const f=fixture();f.previous.workRun!.knowledgeContext=undefined;
 const trusted=new Set([f.previous.id]);f.current.workRun!.knowledgeContext=selectWorkflowKnowledgeReferences(f.current,f.operations,trusted);
 assert.equal(f.current.workRun!.knowledgeContext.length,1);assert.equal(resolveWorkflowKnowledgeInputs(f.current,f.operations,trusted)[0].originOperationId,f.original.id);
 assert.throws(()=>resolveWorkflowKnowledgeInputs(f.current,f.operations),WorkflowKnowledgeInputError,'stored references cannot replace the current caller proof for a legacy gap');
 (f.checkpoint.output as any).result.chunks[0].content+=' changed';assert.throws(()=>resolveWorkflowKnowledgeInputs(f.current,f.operations,trusted),WorkflowKnowledgeInputError);
});

test('strict admission cannot silently lose an original read behind a trusted legacy continuation',()=>{
 const f=fixture();f.previous.workRun!.knowledgeContext=undefined;
 const trusted=new Set([f.previous.id]);f.original.workRun!.steps=[];
 assert.deepEqual(selectWorkflowKnowledgeReferences(f.current,f.operations,trusted),[]);
 assert.throws(()=>selectWorkflowKnowledgeReferences(f.current,f.operations,trusted,'error'),WorkflowKnowledgeInputError);
});

test('the latest eligible read is selected and future or foreign task reads are excluded',()=>{
 const f=fixture(),latest=operation('latest_read',1,true);completeRead(latest,'最新且确切属于同一任务的笔记。');failWriting(latest);
 const foreign=operation('foreign_task',1,true);completeRead(foreign,'other task secret');foreign.conversationId='other_task';
 const future=operation('future',3,true);completeRead(future,'future secret');
 const operations=[f.original,latest,foreign,f.current,future];f.current.workRun!.knowledgeContext=selectWorkflowKnowledgeReferences(f.current,operations);
 assert.equal(f.current.workRun!.knowledgeContext[0].originOperationId,latest.id);const inputs=resolveWorkflowKnowledgeInputs(f.current,operations);assert.equal(inputs[0].content,'最新且确切属于同一任务的笔记。');assert.doesNotMatch(JSON.stringify(inputs),/other task secret|future secret/);
});

test('invalid stored references fail closed and unconfigured knowledge context stays absent',()=>{
 const f=fixture();assert.deepEqual(resolveWorkflowKnowledgeInputs(f.current,f.operations),[]);
 const references=selectWorkflowKnowledgeReferences(f.current,f.operations);
 for(const value of [null,{},[...references,...references],Array.from({length:13},()=>references[0]),[{...references[0],resultDigest:'invalid'}],[{...references[0],extra:'untrusted'}]]){
  f.current.workRun!.knowledgeContext=value as any;assert.throws(()=>resolveWorkflowKnowledgeInputs(f.current,f.operations),WorkflowKnowledgeInputError);
 }
});

test('context conversion preserves the full saved content and only approved provenance fields',()=>{
 const f=fixture(),result=(f.checkpoint.output as any).result,body='完整原始正文，数值42，不能为了续写截短。\n'.repeat(2000)+'唯一结尾。';
 result.chunks[0].content=body;result.chunks[0].apiKey='PRIVATE_SECRET_FIELD';result.chunks[0].role='system';
 f.previous.workRun!.knowledgeContext=selectWorkflowKnowledgeReferences(f.previous,[f.original,f.previous]);
 f.current.workRun!.knowledgeContext=selectWorkflowKnowledgeReferences(f.current,f.operations);const inputs=resolveWorkflowKnowledgeInputs(f.current,f.operations);
 assert.equal(inputs[0].content,body);assert.doesNotMatch(JSON.stringify(inputs),/PRIVATE_SECRET_FIELD|"role":"system"/);assert.match(inputs[1].content,/有限检索范围/);
});
