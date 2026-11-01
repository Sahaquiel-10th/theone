import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {Database} from './types.js';
import {localExecutionMaterials} from './localExecutionMaterials.js';

const scope={workspaceId:'w',userId:'u',conversationId:'task',sourceMessageId:'focus'};
function fixture(){return {conversations:[{...scope,id:'task'}],messages:[{...scope,id:'focus',role:'user',createdAt:'1',attachmentIds:['current']}],attachments:[]} as unknown as Database;}
test('current template image enters compiler vision input, not a private URL or launcher path',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'one-material-'));
 try{
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHcQAAAAASUVORK5CYII=','base64'),file=path.join(dir,'private.png');await writeFile(file,png);
  const db=fixture();db.attachments=[{...scope,id:'current',originalName:'合成模板.png',mimeType:'image/png',kind:'image',status:'ready',size:png.length,storagePath:file,extractedText:''}] as any;
  const result=await localExecutionMaterials(db,scope);
  assert.equal(result?.inputImageDataUrls?.[0],`data:image/png;base64,${png.toString('base64')}`);
  assert.match(result!.content,/实际看.*图片/);assert.doesNotMatch(result!.content,/\/api\/attachments|private\.png/);
  db.attachments[0].userId='other';await assert.rejects(()=>localExecutionMaterials(db,scope),/无权/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('modern parsed sidecar text and exact shared-task handoff are usable',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'one-material-'));
 try{
  const file=path.join(dir,'sheet.xlsx');await writeFile(`${file}.segments`,JSON.stringify({index:0,text:'公司\t金额\n合成公司\t3000'})+'\n');
  const db=fixture();db.attachments=[{workspaceId:'w',userId:'u',conversationId:'main',sharedConversationIds:['task'],id:'current',originalName:'模板.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',kind:'spreadsheet',status:'ready',size:99,storagePath:file,extractedText:'',segmentCount:1,textChars:'公司\t金额\n合成公司\t3000'.length}] as any;
  const result=await localExecutionMaterials(db,scope);assert.match(result!.content,/合成公司\t3000/);assert.equal(result?.inputImageDataUrls,undefined);
  db.attachments[0].textChars!++;await assert.rejects(()=>localExecutionMaterials(db,scope),/片段不完整/);db.attachments[0].textChars!--;
  db.attachments[0].sharedConversationIds=[];await assert.rejects(()=>localExecutionMaterials(db,scope),/其他对话/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('old unrelated attachments and foreign source records never enter execution materials',async()=>{
 const db=fixture();db.messages[0].attachmentIds=[];db.messages.push({...scope,id:'old',role:'user',content:'旧消息',createdAt:'0',attachmentIds:['old']});
 db.attachments=[{...scope,id:'old',kind:'image',storagePath:'/must/not/open',status:'ready'}] as any;
 assert.equal(await localExecutionMaterials(db,scope),undefined);
 await assert.rejects(()=>localExecutionMaterials(db,{...scope,userId:'foreign'}),/无权/);
});
test('oversized sidecar material stops before compilation rather than silently losing fields',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'one-material-'));
 try{
  const file=path.join(dir,'large.txt');await writeFile(`${file}.segments`,JSON.stringify({index:0,text:'长'.repeat(30001)})+'\n');
  const db=fixture();db.attachments=[{...scope,id:'current',originalName:'large.txt',kind:'text',status:'ready',storagePath:file,extractedText:'',segmentCount:1}] as any;
  await assert.rejects(()=>localExecutionMaterials(db,scope),/超过本机交接/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
