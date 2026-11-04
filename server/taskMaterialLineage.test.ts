import test from 'node:test';
import assert from 'node:assert/strict';
import type {Database} from './types.js';
import type {WorkRun} from './coordinatorTypes.js';
import {createTaskInputSource,TaskInputSourceError} from './taskInputSource.js';
import {nextTaskMaterialLineage,resolveTaskMaterialLineage,TaskMaterialLimitError} from './taskMaterialLineage.js';

const scope={workspaceId:'lineage-workspace',userId:'lineage-user'},taskId='lineage-task';
function fixture(){
 const db={messages:[],conversations:[{...scope,id:taskId,archived:false,messages:[]}],attachments:[],chatOperations:[]} as unknown as Database;
 let index=0;
 const add=(content:string,mode:'material'|'brief'='material',files:string[]=[])=>{
  const id=`input-${++index}`,at='2026-11-05T00:00:00.000Z';
  for(const file of files)if(!db.attachments.some(value=>value.id===file))db.attachments.push({...scope,id:file,status:'ready',conversationId:taskId,createdAt:at} as Database['attachments'][number]);
  db.messages.push({...scope,id,conversationId:taskId,role:'user',content,attachmentIds:files,createdAt:at});
  db.conversations[0].messages.push({id,role:'user',content,attachments:files.map(id=>({id})) as Database['conversations'][number]['messages'][number]['attachments'],createdAt:at});
  const source=createTaskInputSource(db,scope,{taskId,inputMessageId:id});
  const run={inputMessageId:id,inputSource:source.reference,inputContentMode:mode,materialScope:'conversation',state:'completed'} as WorkRun;
  db.chatOperations!.push({...scope,id:`operation-${index}`,operationId:`submission-${index}`,conversationId:taskId,workRun:run} as Database['chatOperations'] extends (infer T)[]|undefined?T:never);
  return {source,run};
 };
 return{db,add};
}

test('three exact originals survive appends and many brief controls without consuming extra slots',()=>{
 const {db,add}=fixture(),a=add('A original'),b=add('B original'),c=add('C original');
 a.run.materialSources=nextTaskMaterialLineage(db,scope,{taskId,current:a.source.reference,contributes:true,replace:true});
 b.run.materialSources=nextTaskMaterialLineage(db,scope,{taskId,previous:a.run,current:b.source.reference,contributes:true,replace:false});
 c.run.materialSources=nextTaskMaterialLineage(db,scope,{taskId,previous:b.run,current:c.source.reference,contributes:true,replace:false});
 let previous=c.run;
 for(let n=0;n<12;n++){const brief=add('继续，写得口语一点。');brief.run.materialSources=nextTaskMaterialLineage(db,scope,{taskId,previous,current:brief.source.reference,contributes:false,replace:false});previous=brief.run;}
 assert.deepEqual(resolveTaskMaterialLineage(db,scope,taskId,previous)?.map(source=>source.content),['A original','B original','C original']);
 assert.equal(previous.materialSources?.length,3);
});

test('a replacement clears every old source and does not reread a revoked prior original',()=>{
 const {db,add}=fixture(),old=add('OLD original', 'material',['old-file']);
 old.run.materialSources=[old.source.reference];db.messages=[];
 const current=add('NEW original','material',['new-file']);
 current.run.materialSources=nextTaskMaterialLineage(db,scope,{taskId,previous:old.run,current:current.source.reference,contributes:true,replace:true});
 const selected=resolveTaskMaterialLineage(db,scope,taskId,current.run)!;
 assert.deepEqual(selected.map(source=>source.content),['NEW original']);assert.deepEqual(selected.flatMap(source=>source.reference.attachmentIds),['new-file']);
});

test('explicit lineage validates every original and refuses foreign, stale, malformed, duplicate, brief and sibling references',()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>,run:WorkRun)=>{run.materialSources![0].userId='foreign';},
  (f:ReturnType<typeof fixture>,run:WorkRun)=>{run.materialSources![0].workspaceId='foreign';},
  (f:ReturnType<typeof fixture>,run:WorkRun)=>{run.materialSources![0].taskId='other-task';},
  (f:ReturnType<typeof fixture>)=>{f.db.messages=[];},
  (f:ReturnType<typeof fixture>)=>{f.db.messages[0].content+='changed';},
  (f:ReturnType<typeof fixture>)=>{f.db.attachments[0].status='failed';},
  (f:ReturnType<typeof fixture>,run:WorkRun)=>{run.materialSources=[...run.materialSources!,run.materialSources![0]];},
  (f:ReturnType<typeof fixture>,run:WorkRun)=>{run.materialSources=null as never;},
  (f:ReturnType<typeof fixture>,run:WorkRun)=>{run.inputContentMode='brief';},
  (f:ReturnType<typeof fixture>,run:WorkRun)=>{run.parentOperationId='batch';f.db.chatOperations!.push({...f.db.chatOperations![0],id:'other',workRun:{...run,inputMessageId:'other-message'}});},
 ]){
  const f=fixture(),{run,source}=f.add('PRIVATE RAW ORIGINAL','material',['ready-file']);run.materialSources=[structuredClone(source.reference)];mutate(f,run);
  assert.throws(()=>resolveTaskMaterialLineage(f.db,scope,taskId,run),error=>error instanceof TaskInputSourceError&&!error.message.includes('PRIVATE'));
 }
});

test('bounds stop before a ninth original or excess total body without clipping existing sources',()=>{
 const {db,add}=fixture();let previous:WorkRun|undefined;
 for(let n=0;n<8;n++){const value=add(`original-${n}`);value.run.materialSources=nextTaskMaterialLineage(db,scope,{taskId,previous,current:value.source.reference,contributes:true,replace:false});previous=value.run;}
 const ninth=add('ninth');assert.throws(()=>nextTaskMaterialLineage(db,scope,{taskId,previous,current:ninth.source.reference,contributes:true,replace:false}),TaskMaterialLimitError);
 assert.equal(resolveTaskMaterialLineage(db,scope,taskId,previous!)?.length,8);
 const huge=add('x'.repeat(256001));assert.throws(()=>nextTaskMaterialLineage(db,scope,{taskId,current:huge.source.reference,contributes:true,replace:true}),TaskMaterialLimitError);
});

test('legacy current provenance upgrades only an eligible source; retry preserves the selected set and rebinds the repeated current original once',()=>{
 const {db,add}=fixture(),a=add('original'),retry=add('original');a.run.materialScope='current';a.run.materialSource=a.source.reference;
 assert.equal(resolveTaskMaterialLineage(db,scope,taskId,a.run)?.length,1);
 retry.run.materialSources=nextTaskMaterialLineage(db,scope,{taskId,previous:a.run,current:retry.source.reference,contributes:true,replace:false,retry:true});
 assert.deepEqual(retry.run.materialSources?.map(source=>source.inputMessageId),[retry.source.reference.inputMessageId]);
 assert.deepEqual(resolveTaskMaterialLineage(db,scope,taskId,retry.run)?.map(source=>source.content),['original']);
 a.run.inputContentMode='brief';assert.equal(resolveTaskMaterialLineage(db,scope,taskId,a.run),undefined);
 a.run.inputContentMode='material';a.run.materialScope='conversation';assert.equal(resolveTaskMaterialLineage(db,scope,taskId,a.run),undefined,'legacy conversation history is never a source whitelist');
});
