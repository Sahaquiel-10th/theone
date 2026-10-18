import fs from 'node:fs/promises';
import path from 'node:path';
import { uid } from './security.js';
import type { Store } from './db.js';
import type { Attachment, Database } from './types.js';
import { ownedAttachment } from './attachmentService.js';
import { tableFileToCsv } from './skillTables.js';
import {createVisualArtifact,type SaveVisual} from './visualTools.js';
import type {OfficeContext} from './officeTools.js';
import {validateDeck} from './officeSlides.js';
import {resolveWorkDependency} from './workDependencies.js';

export function officeArtifactContext(store:Store,scope:{workspaceId:string;userId:string;conversationId:string},directory:string|undefined,verify:(db:Database)=>void,allowedIds:string[],onSaved?:(id:string)=>void):OfficeContext {
 return {
  readTable:async id=>{const d=await store.read();verify(d);return selectedTableCsv(store,scope,allowedIds,id);},
  readOffice:async id=>{const d=await store.read();verify(d);if(!allowedIds.includes(id))throw new Error('未选择此模板');const file=ownedAttachment(d.attachments,scope,id);if(file.status!=='ready'||!/\.xlsx$/i.test(file.originalName)||file.size>2*1024*1024)throw new Error('模板需要已就绪且不超过2MB的XLSX');const bytes=await fs.readFile(file.storagePath);if(bytes.length!==file.size)throw new Error('模板文件已变化');verify(await store.read());return bytes;},
  readSlides:async id=>{const d=await store.read();verify(d);if(!allowedIds.includes(id))throw new Error('未选择上一版演示稿');const file=ownedAttachment(d.attachments,scope,id);if(file.officeArtifact!=='slides'||file.status!=='ready'||file.size>25*1024*1024)throw new Error('上一版演示稿不可用');const html=await fs.readFile(file.storagePath,'utf8'),content=/<script id="deckData" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];verify(await store.read());if(!content)throw new Error('上一版演示稿缺少完整页面内容');return validateDeck(JSON.parse(content));},
  ...(directory?{saveOffice:async file=>{const kind=file.mime.endsWith('spreadsheetml.sheet')?'spreadsheet' as const:'document' as const;const saved=await saveFeatureArtifact(store,scope,directory,file.name,file.bytes,file.mime,kind,verify);await store.mutate(db=>{verify(db);ownedAttachment(db.attachments,scope,saved.id).officeArtifact=file.mime==='text/html'?'slides':'file';});onSaved?.(saved.id);return saved;}}:{})
 };
}

export function visualArtifactSaver(store:Store,scope:{workspaceId:string;userId:string;conversationId:string},directory:string|undefined,verify:(db:Database)=>void,onSaved?:(id:string)=>void,welcomeImageId?:string,dependencyOperationIds:string[]=[]):SaveVisual|undefined {
  if(!directory)return;
  return async(doc,format)=>{
    let assets:Parameters<typeof createVisualArtifact>[3];
    if(welcomeImageId&&format==='html'){
      const db=await store.read();verify(db);const image=ownedAttachment(db.attachments,scope,welcomeImageId);
      if(image.conversationId!==scope.conversationId||image.kind!=='image'||image.status!=='ready'||!image.welcomeGuide||!/^image\/(png|jpeg|webp)$/.test(image.mimeType)||image.size>25*1024*1024)throw new Error('说明配图暂时不可用');
      const bytes=await fs.readFile(image.storagePath);if(bytes.length!==image.size)throw new Error('说明配图尚未就绪');
      assets={image:`data:${image.mimeType};base64,${bytes.toString('base64')}`,context:image.welcomeGuide};
    }else if(format==='html'&&dependencyOperationIds.length){
      const db=await store.read();verify(db);
      // Only server-recorded prerequisite receipts may supply an illustration.
      // Never accept an arbitrary model URL, file ID, sibling or workspace.
      for(const operationId of dependencyOperationIds){
        const parent=resolveWorkDependency(db,scope,operationId);
        if(parent?.workRun?.state!=='completed')throw new Error('前面的结果还不能使用，请先核对原任务');
        const message=db.conversations.find(c=>c.id===parent.conversationId&&c.workspaceId===scope.workspaceId&&c.userId===scope.userId)?.messages.find(m=>m.id===parent.workRun!.resultMessageId);
        const image=db.attachments.find(a=>a.workspaceId===scope.workspaceId&&a.userId===scope.userId&&a.conversationId===parent.conversationId&&a.kind==='image'&&(message?.imageUrl===`/api/attachments/${a.id}/content`||message?.attachments?.some(file=>file.id===a.id)));
        if(!image){if(parent.workRun.kind==='image'||parent.workRun.expectedOutput==='image')throw new Error('前面的图片暂时找不到，先核对原结果；不会重新画图');continue;}
        if(image.status!=='ready'||!/^image\/(png|jpeg|webp)$/.test(image.mimeType)||image.size>25*1024*1024)throw new Error('前面的配图暂时不可用');
        const bytes=await fs.readFile(image.storagePath);if(bytes.length!==image.size)throw new Error('前面的配图尚未就绪');
        verify(await store.read());assets={image:`data:${image.mimeType};base64,${bytes.toString('base64')}`};break;
      }
    }
    return createVisualArtifact(doc,format,async(name,bytes,mime,content)=>{
    const file=await saveFeatureArtifact(store,scope,directory,name,bytes,mime,'document',verify);
    await store.mutate(db=>{verify(db);const f=ownedAttachment(db.attachments,scope,file.id);f.visualDocument=content;if(welcomeImageId&&format==='html')f.welcomeImageId=welcomeImageId;});
    onSaved?.(file.id);return file;
    },assets);
  };
}

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
  const formats:Record<string,string>={'image/jpeg':'.jpg','image/webp':'.webp','image/png':'.png','image/svg+xml':'.svg','text/html':'.html','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx','application/vnd.openxmlformats-officedocument.presentationml.presentation':'.pptx','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx'};
  const extension=formats[mimeType];if(!extension)throw new Error('成果格式不支持');
  const id=uid('att');
  const storagePath=path.join(directory,id+extension);
  await fs.writeFile(storagePath,bytes,{flag:'wx',mode:0o600});
  const file:Attachment={...scope,id,originalName:name.slice(0,160),size:bytes.length,mimeType,kind,storagePath,extractedText:'',status:'ready',createdAt:new Date().toISOString()};
  try { await store.mutate(db=>{verify(db);if(!db.conversations.some(c=>c.id===scope.conversationId&&c.workspaceId===scope.workspaceId&&c.userId===scope.userId))throw new Error('成果所属任务已变化');db.attachments.push(file);}); }
  catch(e){await fs.rm(storagePath,{force:true});throw e;}
  return {id,name:file.originalName};
}
