import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Attachment} from './types.js';
import type {TaskStep,TaskStepStore} from './taskSteps.js';
import {prepareAttachmentContext} from './attachmentRetrieval.js';
import {prepareDurableAttachmentContext,rebindAttachmentPreparationSteps,attachmentPreparationDigest,attachmentPreparationNamespace,AttachmentPreparationError,type AttachmentPreparationScope,type AttachmentPreparationResult} from './attachmentPreparation.js';

const scope:AttachmentPreparationScope={workspaceId:'w',userId:'u',conversationId:'task',operationId:'attempt'};
const file=(id:string,text:string)=>({...scope,id,originalName:`${id}.txt`,kind:'text',status:'ready',extractedText:text,textChars:text.length,storagePath:'/unused'} as unknown as Attachment);
const materials=()=>[file('one','FIRST_ONE\n'+'甲'.repeat(12000)+'\nMIDDLE_ONE\n'+'乙'.repeat(12900)+'\nTAIL_ONE'),file('two','FIRST_TWO\n'+'丙'.repeat(12000)+'\nMIDDLE_TWO\n'+'丁'.repeat(13100)+'\nTAIL_TWO')];
function fixture(files=materials()){
 const steps:TaskStep[]=[],checkpoints:TaskStepStore={namespace:attachmentPreparationNamespace,scopeId:scope.operationId,steps,save:async cp=>{const at=steps.findIndex(old=>old.key===cp.key);if(at<0)steps.push(structuredClone(cp));else steps[at]=structuredClone(cp);}};
 let calls=0;const sourceCalls:string[]=[];
 const input={files,scope,query:'分析两份材料的结构与相互关系。',maxChars:24000,coverage:'whole' as const,config:{modelId:'model',taskVersion:1,promptDigest:attachmentPreparationDigest('original prompt')},checkpoints,verify:async()=>{},summarize:async(text:string)=>{calls++;sourceCalls.push(text);return `整理_${calls}` as AttachmentPreparationResult;}};
 return {steps,checkpoints,input,sourceCalls,calls:()=>calls};
}
test('whole coverage is explicit, includes every source segment and distinguishes full text, reduced all-segment notes and excerpts',async()=>{
 const f=fixture();const result=await prepareDurableAttachmentContext(f.input);
 assert.equal(result.coverage.mode,'whole');assert.equal(result.coverage.representation,'all_segments_summary');assert.equal(result.coverage.complete,true);assert.equal(result.coverage.totalSegments,result.coverage.coveredSegments);assert.equal(result.coverage.totalTextChars,f.input.files.reduce((n,file)=>n+file.textChars!,0));
 for(const marker of ['FIRST_ONE','MIDDLE_ONE','TAIL_ONE','FIRST_TWO','MIDDLE_TWO','TAIL_TWO'])assert.ok(f.sourceCalls.join('\n').includes(marker),marker);
 assert.ok(f.calls()>=3);assert.ok(result.coverage.files.every(file=>file.segments===file.coveredSegments));
 const relevant=await prepareAttachmentContext(f.input.files,scope,f.input.query,24000,async()=>{throw Error('no summaries in relevant mode');},{coverage:'relevant'});
 assert.equal(relevant.coverage.representation,'excerpts');assert.equal(relevant.coverage.complete,false);assert.equal(relevant.truncated,true);
 const legacy=await prepareAttachmentContext(f.input.files,scope,f.input.query,24000,async()=>{throw Error('legacy analysis stays relevant');});assert.equal(legacy.coverage.mode,'relevant');
 const small=fixture([file('tiny','字'.repeat(1700))]);const complete=await prepareDurableAttachmentContext(small.input);assert.equal(small.calls(),0);assert.equal(complete.coverage.representation,'full_text');assert.equal(complete.coverage.complete,true);
});
test('completed material batches and reductions are reused only with exact source, goal and configuration proof',async()=>{
 const f=fixture();let calls=0;
 const input={...f.input,summarize:async(_text:string,batch:any)=>{calls++;return batch.kind==='map'?'map_note_'.repeat(1500):'完整归并笔记';}};
 await prepareDurableAttachmentContext(input);const paid=calls;assert.ok(f.steps.some(cp=>(cp.output as any).attachmentPreparation.batch.kind==='reduce'));
 await prepareDurableAttachmentContext(input);assert.equal(calls,paid);
 await prepareDurableAttachmentContext({...input,query:'新目标：只比较逻辑矛盾。'});assert.ok(calls>paid);const afterGoal=calls;
 await prepareDurableAttachmentContext({...input,config:{...input.config,taskVersion:2}});assert.ok(calls>afterGoal);const afterConfig=calls;
 const files=structuredClone(input.files);files[1].extractedText+='新结尾';files[1].textChars=files[1].extractedText.length;
 await prepareDurableAttachmentContext({...input,files});assert.ok(calls>afterConfig,'whole source hash changes every batch identity when a later file changes');
});
test('a second batch failure retains first-batch work and an unknown attempt is never silently repurchased',async()=>{
 const f=fixture();let calls=0;
 const input={...f.input,summarize:async()=>{calls++;if(calls===2)throw Error('injected timeout');return '已完成的首批资料';}};
 await assert.rejects(prepareDurableAttachmentContext(input),/injected/);assert.equal(calls,2);assert.equal(f.steps.filter(cp=>cp.state==='completed').length,1);assert.equal(f.steps.filter(cp=>cp.state==='started').length,1);
 await assert.rejects(prepareDurableAttachmentContext(input),e=>e instanceof AttachmentPreparationError&&e.code==='result_unknown');assert.equal(calls,2);
 assert.equal(rebindAttachmentPreparationSteps(f.steps,scope,{...scope,operationId:'next'}),undefined,'unknown second batch is not dropped by restore');
});
test('only already-authorized same-task completed checkpoints may be rebound into a material revision',async()=>{
 const f=fixture();await prepareDurableAttachmentContext(f.input);const old=structuredClone(f.steps),target={...scope,operationId:'next'};
 const rebound=rebindAttachmentPreparationSteps(f.steps,scope,target)!;assert.equal(rebound.length,f.steps.length);assert.notEqual(rebound[0].key,f.steps[0].key);assert.equal(rebound[0].scopeId,'next');assert.deepEqual(f.steps,old);
 let paid=0;const checkpoints={...f.checkpoints,scopeId:'next',steps:rebound};
 await prepareDurableAttachmentContext({...f.input,scope:target,checkpoints,summarize:async()=>{paid++;return 'must not run';}});assert.equal(paid,0);
 for(const changed of [{workspaceId:'other'},{userId:'other'},{conversationId:'other'}])assert.equal(rebindAttachmentPreparationSteps(f.steps,scope,{...target,...changed}),undefined);
 for(const kind of ['body','scope','key','duplicate','operation'] as const){
  const broken=structuredClone(f.steps);if(kind==='body')(broken[0].output as any).result.content+='forged';if(kind==='scope')(broken[0].output as any).attachmentPreparation.scope.userId='foreign';if(kind==='key')broken[0].key='wrong';if(kind==='duplicate')broken.push(structuredClone(broken[0]));if(kind==='operation')broken[0].operation!.execution='unknown';
  assert.equal(rebindAttachmentPreparationSteps(broken,scope,target),undefined,kind);
 }
});
test('authorization, cancellation and failed or incomplete model returns cannot certify complete material preparation',async()=>{
 for(const kind of ['owner','task','store','key','length','filtered','tool','empty'] as const){
  const f=fixture();let calls=0,checks=0;
  const input={...f.input,files:kind==='owner'?f.input.files.map(file=>({...file,userId:'foreign'})):kind==='task'?f.input.files.map(file=>({...file,conversationId:'other'})):f.input.files,checkpoints:kind==='store'?{...f.checkpoints,scopeId:'other'}:f.checkpoints,verify:async()=>{checks++;if(kind==='key'&&checks>=3)throw Error('key revoked');},summarize:async()=>{calls++;return kind==='length'?{content:'返回的部分笔记',finishReason:'length' as const}:kind==='filtered'?{content:'filtered',finishReason:'filtered' as const}:kind==='tool'?{content:'tool',finishReason:'stop' as const,toolCalls:[{}]}:kind==='empty'?'':'完成';}};
  await assert.rejects(prepareDurableAttachmentContext(input),()=>true,kind);assert.equal(f.steps.some(cp=>cp.state==='completed'),false,kind);if(['owner','task','store','key'].includes(kind))assert.equal(calls,0,kind);
 }
});
test('concurrent material preparation of one claimed job does not buy the same batch twice',async()=>{
 const f=fixture();await Promise.all([prepareDurableAttachmentContext(f.input),prepareDurableAttachmentContext(f.input)]);assert.equal(f.calls(),f.steps.length);assert.ok(f.steps.every(cp=>cp.state==='completed'));
});
test('a failed completion commit cannot leave an in-memory-only success that unlocks another batch',async()=>{
 const f=fixture(),save=f.checkpoints.save;let failed=false;
 f.checkpoints.save=async step=>{await save(step);if(step.state==='completed'&&!failed){failed=true;throw Error('completion commit unavailable');}};
 await assert.rejects(prepareDurableAttachmentContext(f.input),/commit unavailable/);assert.equal(f.calls(),1);assert.equal(f.steps[0].state,'started');
 await assert.rejects(prepareDurableAttachmentContext(f.input),e=>e instanceof AttachmentPreparationError&&e.code==='result_unknown');assert.equal(f.calls(),1);
});
test('a truncated or reordered sidecar is not described as complete source coverage and starts no model call',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'one-material-coverage-'));
 try{
  const storagePath=path.join(directory,'one.txt');await writeFile(storagePath+'.segments',JSON.stringify({index:0,text:'first'})+'\n');
  const attachment={...file('one',''),storagePath,extractedText:'',segmentCount:2,textChars:10};
  let calls=0;await assert.rejects(prepareAttachmentContext([attachment],scope,'分析全部资料',24000,async()=>{calls++;return 'summary';},{coverage:'whole'}),/全文暂时无法读取/);assert.equal(calls,0);
  await writeFile(storagePath+'.segments',JSON.stringify({index:1,text:'first'})+'\n');
  await assert.rejects(prepareAttachmentContext([attachment],scope,'分析全部资料',24000,async()=>{calls++;return 'summary';},{coverage:'whole'}),/全文暂时无法读取/);assert.equal(calls,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
