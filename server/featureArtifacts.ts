import fs from 'node:fs/promises';
import path from 'node:path';
import { uid } from './security.js';
import type { Store } from './db.js';
import type { Attachment, Database } from './types.js';
import { ownedAttachment } from './attachmentService.js';
import { tableFileToCsv } from './skillTables.js';

export async function selectedFeatureFiles(store:Store,scope:{workspaceId:string;userId:string},ids:unknown):Promise<Attachment[]> {
  if(ids===undefined)return [];
  if(!Array.isArray(ids)||ids.length>5||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'))throw new Error('最多选择 5 个自己的附件');
  const db=await store.read();
  return ids.map(id=>{const file=ownedAttachment(db.attachments,scope,id);if(file.status&&file.status!=='ready')throw new Error('请等待附件处理完成');return file;});
}
export async function selectedTableCsv(store:Store,scope:{workspaceId:string;userId:string},allowedIds:string[],id:string){
  if(!allowedIds.includes(id))throw new Error('未选择此附件');
  const file=(await selectedFeatureFiles(store,scope,[id]))[0];
  if(file.size>2*1024*1024)throw new Error('表格文件超过首版 2MB 上限');
  return tableFileToCsv(await fs.readFile(file.storagePath),file.originalName);
}
export async function saveFeatureArtifact(store:Store,scope:{workspaceId:string;userId:string;conversationId:string},directory:string,name:string,bytes:Buffer,mimeType:string,kind:Attachment['kind'],verify:(db:Database)=>void){
  if(!directory||!bytes.length||bytes.length>25*1024*1024)throw new Error('成果文件存储不可用或过大');
  const id=uid('att'),extension=kind==='image'?mimeType==='image/jpeg'?'.jpg':mimeType==='image/webp'?'.webp':'.png':'.xlsx';
  const storagePath=path.join(directory,id+extension);
  await fs.writeFile(storagePath,bytes,{flag:'wx',mode:0o600});
  const file:Attachment={...scope,id,originalName:name.slice(0,160),size:bytes.length,mimeType,kind,storagePath,extractedText:'',status:'ready',createdAt:new Date().toISOString()};
  try { await store.mutate(db=>{verify(db);if(!db.conversations.some(c=>c.id===scope.conversationId&&c.workspaceId===scope.workspaceId&&c.userId===scope.userId))throw new Error('成果所属任务已变化');db.attachments.push(file);}); }
  catch(e){await fs.rm(storagePath,{force:true});throw e;}
  return {id,name:file.originalName};
}
