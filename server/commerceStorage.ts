import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { resolve4 } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import sharp from 'sharp';
import { publicIpv4 } from './connectors/standardHttp.js';
import { decodeGeneratedImageDataUrl, type DecodedGeneratedImage } from './generatedImage.js';
import { uid } from './security.js';
import type { Attachment } from './types.js';
import type { CommerceJob, CommerceVariant } from './commerceTypes.js';

export const COMMERCE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const MAX_PIXELS = 60_000_000, CID = 'industry:commerce';
class CommerceStorageError extends Error {}
const storageError = (message: string) => new CommerceStorageError(message);
const safeStorageError = (error:unknown,message:string) => error instanceof CommerceStorageError ? error : storageError(message);
function sniffImage(data: Buffer): DecodedGeneratedImage['mimeType'] {
  if (data.length >= 8 && data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (data.length >= 3 && data[0]===255 && data[1]===216 && data[2]===255) return 'image/jpeg';
  if (data.length >=12 && data.subarray(0,4).toString()==='RIFF' && data.subarray(8,12).toString()==='WEBP') return 'image/webp';
  throw storageError('作图服务返回的文件不是支持的 PNG、JPG 或 WebP 图片');
}
const extensionFor = (mime:DecodedGeneratedImage['mimeType']):DecodedGeneratedImage['extension'] => mime==='image/jpeg'?'.jpg':mime==='image/png'?'.png':'.webp';
export function safeCommerceImageUrl(raw:string):URL {
  let url:URL;try{url=new URL(raw);}catch{throw storageError('图片下载地址无效');}
  // Signed query strings are allowed; credentials, local hosts and non-HTTPS ports are not.
  if(raw.length>16000 || url.protocol!=='https:' || url.username || url.password || url.port || url.hash || isIP(url.hostname)
    || !url.hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal)\.?$/i.test(url.hostname)) throw storageError('图片下载地址无效');
  return url;
}

/** Pin vetted DNS to the actual TLS connection; redirects receive a fresh policy check. */
export function createCommerceImageDownloader(deps={resolve4,request},timeoutMs=45000) {
  return async(raw:string,maxBytes=COMMERCE_IMAGE_MAX_BYTES):Promise<DecodedGeneratedImage>=>{
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>COMMERCE_IMAGE_MAX_BYTES)throw storageError('图片大小上限无效');
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    const run=async()=>{
      let current=raw;
      for(let redirects=0;redirects<=3;redirects++){
        const url=safeCommerceImageUrl(current),addresses=await deps.resolve4(url.hostname);controller.signal.throwIfAborted();
        if(!addresses.length||addresses.some(ip=>!publicIpv4(ip)))throw storageError('图片下载地址不可访问');
        const response=await new Promise<{redirect?:string;data?:Buffer;contentType?:string}>((resolve,reject)=>{
          const req=deps.request(url,{method:'GET',agent:false,signal:controller.signal,family:4,
            lookup:(_hostname,_options,callback)=>callback(null,addresses[0],4),
            headers:{Accept:'image/png, image/jpeg, image/webp','Accept-Encoding':'identity'}},res=>{
            const status=res.statusCode??0;
            // Handle even an early stream error before rejecting/destroying it.
            res.on('error',()=>reject(storageError('生成的图片下载失败')));
            if([301,302,303,307,308].includes(status)){
              const location=res.headers.location;res.destroy();
              if(!location){reject(storageError('图片下载跳转无效'));return;}
              resolve({redirect:location});return;
            }
            if(status!==200){res.destroy();reject(storageError('生成的图片下载失败，请核对原任务'));return;}
            const length=res.headers['content-length'];
            if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>maxBytes)){res.destroy();reject(storageError('生成的图片超过大小限制'));return;}
            if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(storageError('生成的图片压缩格式不受支持'));return;}
            const contentType=String(res.headers['content-type']??'').split(';')[0].trim().toLowerCase();
            if(!['image/png','image/jpeg','image/webp','application/octet-stream'].includes(contentType)){res.destroy();reject(storageError('作图服务返回的文件类型不受支持'));return;}
            const chunks:Buffer[]=[];let size=0;
            res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBytes){res.destroy();reject(storageError('生成的图片超过大小限制'));return;}chunks.push(chunk);});
            res.on('aborted',()=>reject(storageError('生成的图片下载中断')));
            res.on('end',()=>{
              if(!res.complete && 'complete' in res){reject(storageError('生成的图片下载中断'));return;}
              if(!size){reject(storageError('生成图片内容为空'));return;}
              if(length!==undefined&&Number(length)!==size){reject(storageError('生成的图片内容不完整'));return;}
              resolve({data:Buffer.concat(chunks,size),contentType});
            });
          });
          req.on('error',()=>reject(storageError(controller.signal.aborted?'图片下载超时':'生成的图片下载失败')));req.end();
        });
        if(response.redirect){if(redirects===3)throw storageError('图片下载跳转过多');current=new URL(response.redirect,url).href;continue;}
        const data=response.data!,mimeType=sniffImage(data);
        if(response.contentType!=='application/octet-stream'&&response.contentType!==mimeType)throw storageError('生成图片的文件类型与内容不一致');
        return {data,mimeType,extension:extensionFor(mimeType)};
      }
      throw storageError('图片下载跳转过多');
    };
    try{return await Promise.race([run(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(storageError('图片下载超时'));},timeoutMs);})]);}
    catch(error){throw safeStorageError(error,'生成的图片下载失败，请核对原任务');}
    finally{clearTimeout(timer);controller.abort();}
  };
}
const downloadImage=createCommerceImageDownloader();

async function imageMetadata(data:Buffer,mimeType:string,decodePixels=false){
  try{
  if(data.length<1||data.length>COMMERCE_IMAGE_MAX_BYTES||sniffImage(data)!==mimeType)throw storageError('图片大小、类型或内容无效');
  const image=sharp(data,{limitInputPixels:MAX_PIXELS,failOn:'error'}),metadata=await image.metadata();
  if(!metadata.width||!metadata.height||metadata.width>32768||metadata.height>32768||metadata.width*metadata.height>MAX_PIXELS||(metadata.pages??1)>1
    ||!['png','jpeg','webp'].includes(metadata.format??'')||`image/${metadata.format}`!==mimeType)throw storageError('生成的图片尺寸或格式无效');
  // Metadata alone can accept a truncated image. Decode before preserving edit bytes unchanged.
  if(decodePixels)await image.stats();
  return metadata;
  }catch(error){throw safeStorageError(error,'图片内容不完整或尺寸超出范围');}
}

export async function saveCommerceImage(raw:string,job:CommerceJob,variant:CommerceVariant,uploadDir:string):Promise<Attachment>{
  if(typeof raw!=='string'||!job.workspaceId||!job.userId)throw storageError('生成图片归属无效');
  if(raw.startsWith('data:')&&raw.length>Math.ceil(COMMERCE_IMAGE_MAX_BYTES/3)*4+200)throw storageError('生成的图片超过大小限制');
  let {data,mimeType,extension}=raw.startsWith('data:')?decodeGeneratedImageDataUrl(raw,COMMERCE_IMAGE_MAX_BYTES):await downloadImage(raw);
  const metadata=await imageMetadata(data,mimeType,true),swap=[5,6,7,8].includes(metadata.orientation??1);
  variant.sourceWidth=swap?metadata.height!:metadata.width!;variant.sourceHeight=swap?metadata.width!:metadata.height!;
  if(job.kind==='image_edit'){
    variant.outputWidth=variant.sourceWidth;variant.outputHeight=variant.sourceHeight;
  }else{
    const portrait=job.taskType==='portrait'||job.brief.outputFormat==='portrait';variant.outputWidth=1440;variant.outputHeight=portrait?1920:1440;
    data=await sharp(data,{limitInputPixels:MAX_PIXELS,failOn:'error'}).rotate().resize(variant.outputWidth,variant.outputHeight,{fit:'contain',position:'centre',background:{r:255,g:255,b:255,alpha:1}}).png().toBuffer();
    mimeType='image/png';extension='.png';
    if(data.length>COMMERCE_IMAGE_MAX_BYTES)throw storageError('导出图片超过大小限制');
    if(variant.sourceWidth!==variant.outputWidth||variant.sourceHeight!==variant.outputHeight){
      const ratioChanged=Math.abs(variant.sourceWidth/variant.sourceHeight-variant.outputWidth/variant.outputHeight)>.001;
      variant.qualityNote=[variant.qualityNote,`已从${variant.sourceWidth}×${variant.sourceHeight}适配为${variant.outputWidth}×${variant.outputHeight}${ratioChanged?'，为保留完整画面按比例留白':''}；这是导出尺寸，请核对放大后的细节清晰度。`].filter(Boolean).join(' ');
    }
  }
  const id=uid('att'),attachment:Attachment={id,workspaceId:job.workspaceId,userId:job.userId,conversationId:CID,status:'ready',originalName:`${job.brief.productName.slice(0,50)}-${variant.name.slice(0,30)}${extension}`,mimeType,kind:'image',size:data.length,storagePath:path.join(uploadDir,`${id}${extension}`),extractedText:'',uploadedBytes:data.length,textChars:0,createdAt:new Date().toISOString()};
  try{
    await fs.mkdir(uploadDir,{recursive:true,mode:0o700});
    const handle=await fs.open(attachment.storagePath,'wx',0o600);
    try{await handle.writeFile(data);await handle.close();}catch(error){await handle.close().catch(()=>undefined);await fs.unlink(attachment.storagePath).catch(()=>undefined);throw error;}
  }catch{throw storageError('生成图片保存失败，请核对原任务');}
  return attachment;
}

export async function readCommerceImages(attachments:Attachment[]):Promise<string[]>{
  try{
  if(attachments.length>16)throw storageError('单次最多读取16张图片');
  const owner=attachments[0];let total=0;const result:string[]=[];
  for(const a of attachments){
    if(!owner||a.workspaceId!==owner.workspaceId||a.userId!==owner.userId||a.status!=='ready'||a.conversationId!==CID||a.kind!=='image')throw storageError('图片归属或处理状态无效');
    const handle=await fs.open(a.storagePath,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const stat=await handle.stat();if(!stat.isFile()||stat.size!==a.size||stat.size>COMMERCE_IMAGE_MAX_BYTES||stat.size<=0)throw storageError('图片文件大小无效');
      total+=stat.size;if(total>150*1024*1024)throw storageError('本次图片总大小超过150MB，请压缩后重试');
      const data=await handle.readFile();if(data.length!==a.size)throw storageError("图片文件内容已变化");await imageMetadata(data,a.mimeType);
      result.push(`data:${a.mimeType};base64,${data.toString('base64')}`);
    }finally{await handle.close();}
  }
  return result;
  }catch(error){throw safeStorageError(error,'图片文件无法安全读取，请重新上传');}
}
