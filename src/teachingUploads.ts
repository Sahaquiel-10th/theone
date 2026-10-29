export type TeachingRequest=<T>(path:string,options?:RequestInit)=>Promise<T>;
export type TeachingUpload={id:string;originalName:string;status?:string;parseError?:string};
export const teachingFileAccept='.docx,.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.mp4,.webm';
export async function uploadTeachingFile(request:TeachingRequest,base:string,file:File,onProgress:(message:string)=>void):Promise<TeachingUpload>{
  onProgress(`正在上传 ${file.name} · 0%`);
  const created=await request<{attachment:TeachingUpload;chunkBytes?:number}>(`${base}/uploads`,{method:'POST',body:JSON.stringify({name:file.name,size:file.size,mimeType:file.type})});
  const bytes=created.chunkBytes??4*1024*1024;
  for(let offset=0;offset<file.size;offset+=bytes){await request(`${base}/uploads/${created.attachment.id}/chunks?offset=${offset}`,{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:file.slice(offset,offset+bytes)});onProgress(`正在上传 ${file.name} · ${Math.min(100,Math.round((offset+bytes)/file.size*100))}%`);}
  await request(`${base}/uploads/${created.attachment.id}/complete`,{method:'POST'});
  onProgress(`正在检查 ${file.name}`);
  for(let i=0;i<100;i++){
    const result=await request<{attachment:TeachingUpload}>(`${base}/uploads/${created.attachment.id}`);
    if(!result.attachment.status||result.attachment.status==='ready')return result.attachment;
    if(result.attachment.status==='failed')throw new Error(result.attachment.parseError??`${file.name} 未能处理，请检查文件后重试。`);
    await new Promise(resolve=>setTimeout(resolve,1200));
  }
  throw new Error('文件仍在检查，稍后再打开课程查看。请先保留原件。');
}
