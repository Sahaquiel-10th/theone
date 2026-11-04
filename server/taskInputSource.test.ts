import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskInputSource,resolveTaskInputSource,parseTaskInputSourceReference,formatTaskInputSource,taskInputContentDigest,TaskInputSourceError} from './taskInputSource.js';
import type {Database,MessageRecord} from './types.js';

const scope={workspaceId:'space-a',userId:'user-a'};
function fixture(content='首段\n'+'完整材料。'.repeat(1900)+'\n中段标记\n'+'结尾材料。'.repeat(900)+'\n最后一字🧡  '){
 const at='2026-11-04T00:00:00.000Z';
 const row=(conversationId:string,id:string):MessageRecord=>({...scope,conversationId,id,role:'user',content,attachmentIds:['current-file'],createdAt:at});
 const origin=row('main-a','origin-a'),input=row('task-a','input-a');
 const conversation=(id:string,message:MessageRecord)=>({...scope,id,title:id,modelId:'model-a',archived:false,createdAt:at,updatedAt:at,messages:[{id:message.id,role:message.role,content:message.content,attachments:[{id:'current-file',originalName:'current.txt',mimeType:'text/plain',kind:'text' as const,size:1}],createdAt:at}]});
 const db={messages:[origin,input],conversations:[conversation('main-a',origin),conversation('task-a',input)],attachments:[{...scope,id:'current-file',originalName:'current.txt',mimeType:'text/plain',kind:'text' as const,size:1,storagePath:'private',extractedText:'',status:'ready' as const,createdAt:at}]} as Pick<Database,'messages'|'conversations'|'attachments'>;
 return {db,content,binding:{taskId:'task-a',inputMessageId:'input-a',originConversationId:'main-a',originMessageId:'origin-a'}};
}

test('an exact owned source keeps every original byte and renders the material once',()=>{
 const f=fixture(),source=createTaskInputSource(f.db,scope,f.binding);
 assert.equal(source.content,f.content);assert.equal(source.reference.contentDigest,taskInputContentDigest(f.content));
 assert.deepEqual(source.reference.origin,{conversationId:'main-a',messageId:'origin-a'});
 assert.deepEqual(resolveTaskInputSource(f.db,scope,source.reference),source);
 const rendered=formatTaskInputSource(source,'分析当前完整材料；不要继续旧附件。');
 const data=JSON.parse(rendered);
 assert.equal(data.source.content,f.content);assert.equal(data.instruction,'分析当前完整材料；不要继续旧附件。');
 assert.equal(rendered.split('中段标记').length-1,1);assert.equal(rendered.split('最后一字').length-1,1);
 assert.equal(JSON.parse(formatTaskInputSource(source,f.content)).instruction,undefined,'an exact raw-text legacy handoff must not duplicate its material');
 assert.doesNotMatch(JSON.stringify(source.reference),/完整材料|storagePath|private/);
});

test('source identity is isolated by both owner dimensions and exact task/input/origin',()=>{
 const f=fixture(),source=createTaskInputSource(f.db,scope,f.binding);
 for(const changed of [{workspaceId:'space-b'},{userId:'user-b'}])assert.throws(()=>resolveTaskInputSource(f.db,{...scope,...changed},source.reference),TaskInputSourceError);
 for(const expected of [{taskId:'other-task',inputMessageId:'input-a'},{taskId:'task-a',inputMessageId:'origin-a'}])assert.throws(()=>resolveTaskInputSource(f.db,scope,source.reference,expected),TaskInputSourceError);
 for(const changed of [{taskId:'main-a'},{inputMessageId:'origin-a'},{originConversationId:'task-a'},{originMessageId:'input-a'}])assert.throws(()=>createTaskInputSource(f.db,scope,{...f.binding,...changed}),TaskInputSourceError);
 for(const key of ['workspaceId','userId'] as const){const copy=structuredClone(f.db);copy.messages.find(m=>m.id==='origin-a')![key]='foreign';assert.throws(()=>createTaskInputSource(copy,scope,f.binding),TaskInputSourceError);}
 assert.throws(()=>createTaskInputSource(f.db,scope,{...f.binding,originMessageId:undefined}),TaskInputSourceError);
});

test('changed raw text, mismatched mirrors, roles and selected attachment sets fail closed',()=>{
 const f=fixture('精确正文\n末尾  '),reference=createTaskInputSource(f.db,scope,f.binding).reference;
 for(const mutation of [
  (db:typeof f.db)=>{db.messages.find(m=>m.id==='input-a')!.content+='改';},
  (db:typeof f.db)=>{db.conversations.find(c=>c.id==='task-a')!.messages[0].content+='改';},
  (db:typeof f.db)=>{db.messages.find(m=>m.id==='origin-a')!.content+='改';db.conversations.find(c=>c.id==='main-a')!.messages[0].content+='改';},
  (db:typeof f.db)=>{db.messages.find(m=>m.id==='input-a')!.role='assistant';},
  (db:typeof f.db)=>{db.messages.find(m=>m.id==='origin-a')!.attachmentIds=[];db.conversations.find(c=>c.id==='main-a')!.messages[0].attachments=[];},
  (db:typeof f.db)=>{db.attachments[0].userId='foreign';},
  (db:typeof f.db)=>{db.attachments[0].status='failed';},
  (db:typeof f.db)=>{db.messages.push({...db.messages.find(m=>m.id==='input-a')!});},
 ]){const copy=structuredClone(f.db);mutation(copy);assert.throws(()=>resolveTaskInputSource(copy,scope,reference),TaskInputSourceError);}
 assert.notEqual(taskInputContentDigest('正文'),taskInputContentDigest('正文 '));
 assert.notEqual(taskInputContentDigest('é'),taskInputContentDigest('e\u0301'));
});

test('old task input without an origin can bind its exact local source but never claims a main source',()=>{
 const f=fixture('旧本机原话');const source=createTaskInputSource(f.db,scope,{taskId:'task-a',inputMessageId:'input-a'});
 assert.equal(source.reference.origin,undefined);assert.equal(source.content,'旧本机原话');
 assert.deepEqual(resolveTaskInputSource(f.db,scope,source.reference),source);
});
test('archiving either the task or declared origin makes its source unavailable without leaking material',()=>{
 for(const conversationId of ['task-a','main-a']){
  const f=fixture('PRIVATE_ARCHIVED_MATERIAL'),source=createTaskInputSource(f.db,scope,f.binding);
  f.db.conversations.find(conversation=>conversation.id===conversationId)!.archived=true;
  for(const read of [()=>createTaskInputSource(f.db,scope,f.binding),()=>resolveTaskInputSource(f.db,scope,source.reference)])assert.throws(read,error=>error instanceof TaskInputSourceError&&!error.message.includes('PRIVATE_ARCHIVED_MATERIAL'));
 }
});

test('reference parser rejects malformed digests, extra content, duplicated files and forged shape',()=>{
 const f=fixture(),ref=createTaskInputSource(f.db,scope,f.binding).reference;
 assert.deepEqual(parseTaskInputSourceReference(ref),ref);
 for(const bad of [null,[],{...ref,version:2},{...ref,contentDigest:'not-a-sha'},{...ref,content:'SECRET'},{...ref,attachmentIds:['current-file','current-file']},{...ref,origin:{...ref.origin,extra:true}},{...ref,origin:{conversationId:'main-a'}},{...ref,taskId:''},Object.assign(Object.create({}),ref)])assert.equal(parseTaskInputSourceReference(bad),undefined);
});
