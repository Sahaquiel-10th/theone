import fs from 'node:fs/promises';
import path from 'node:path';
import type { Store } from './db.js';
import type { PublicRun } from './publicSharingTypes.js';
import { checkRunBudget, SharingError } from './publicSharing.js';
import { uid } from './security.js';

const formats:Record<string,string>={
  'text/html':'.html','image/svg+xml':'.svg',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx'
};

export type PublicAvatarFile={name:string;bytes:Buffer;mimeType:string;kind:'spreadsheet'|'document'};

/** Same private attachment storage, but never an owner conversation or a public URL. */
export async function savePublicAvatarArtifact(store:Store,run:PublicRun,directory:string,file:PublicAvatarFile){
  const extension=formats[file.mimeType];
  if(!directory||!extension||!Buffer.isBuffer(file.bytes)||!file.bytes.length||file.bytes.length>20*1024**2)throw new SharingError('成果文件暂时不能保存，请稍后再试');
  const verify=async()=>{const db=await store.read();checkRunBudget(db,run.id,0);const current=db.publicRuns!.find(r=>r.id===run.id&&r.workspaceId===run.workspaceId&&r.userId===run.userId&&r.sessionId===run.sessionId);if(!current)throw new SharingError('成果所属会话已变化',403);};
  await verify();
  const id=uid('att'),storagePath=path.join(directory,id+extension);
  const name=file.name.replace(/[\\/\u0000-\u001f\u007f]/g,'').slice(0,140)||`成果${extension}`;
  await fs.writeFile(storagePath,file.bytes,{flag:'wx',mode:0o600});
  try{await store.mutate(db=>{
    checkRunBudget(db,run.id,0);
    const current=db.publicRuns!.find(r=>r.id===run.id&&r.workspaceId===run.workspaceId&&r.userId===run.userId&&r.sessionId===run.sessionId);
    if(!current)throw new SharingError('成果所属会话已变化',403);
    if((current.artifacts?.length??0)>=8||(current.artifacts??[]).reduce((n,f)=>n+f.size,0)+file.bytes.length>40*1024**2)throw new SharingError('这次成果较多，请先查看已生成的文件');
    const receipt={id,name,mimeType:file.mimeType,size:file.bytes.length};
    db.attachments.push({id,workspaceId:run.workspaceId,userId:run.userId,conversationId:run.sessionId,originalName:name,size:file.bytes.length,mimeType:file.mimeType,kind:file.kind,storagePath,extractedText:'',status:'ready',createdAt:new Date().toISOString()});
    (current.artifacts??=[]).push(receipt);
  });}catch(e){await fs.rm(storagePath,{force:true});throw e;}
  return {id,name};
}
