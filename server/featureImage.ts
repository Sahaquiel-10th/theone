import {resolve4} from 'node:dns/promises';
import {request} from 'node:https';
import {publicIpv4} from './connectors/standardHttp.js';
import {safeToolEndpoint} from './connectors/boundedHttps.js';
import {decodeGeneratedImageDataUrl,type DecodedGeneratedImage} from './generatedImage.js';
function validImage(image:DecodedGeneratedImage){const b=image.data;const valid=image.mimeType==='image/png'?b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.toString('ascii',12,16)==='IHDR'&&b.readUInt32BE(16)>0&&b.readUInt32BE(20)>0:image.mimeType==='image/jpeg'?b.length>4&&b[0]===255&&b[1]===216&&b[b.length-2]===255&&b[b.length-1]===217:b.length>12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';if(!valid)throw new Error('生成图片内容无效');return image;}
/** Generated provider URLs are untrusted. Pin public DNS, refuse redirects and bound the bytes. */
export async function featureImageBytes(value:string){
  const limit=20*1024*1024;
  if(value.startsWith('data:'))return validImage(decodeGeneratedImageDataUrl(value,limit));
  const url=new URL(value),base=new URL(value);base.search='';safeToolEndpoint(base.href);
  const addresses=await resolve4(url.hostname);if(!addresses.length||addresses.some(a=>!publicIpv4(a)))throw new Error('生成图片地址不可用');
  const {bytes,mimeType}=await new Promise<{bytes:Buffer;mimeType:string}>((resolve,reject)=>{
    const signal=AbortSignal.timeout(30000);
    const req=request(url,{method:'GET',signal,agent:false,family:4,lookup:(_h,_o,cb)=>cb(null,addresses[0],4),headers:{'Accept-Encoding':'identity'}},res=>{
      const mimeType=String(res.headers['content-type']??'').split(';')[0];
      if(res.statusCode!==200||!['image/png','image/jpeg','image/webp'].includes(mimeType)){res.destroy();reject(new Error('生成图片格式不可用'));return;}
      const chunks:Buffer[]=[];let size=0;res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>limit){res.destroy(new Error('生成图片过大'));return;}chunks.push(chunk);});res.on('error',reject);res.on('end',()=>resolve({bytes:Buffer.concat(chunks),mimeType}));
    });req.on('error',reject);req.end();
  });
  return validImage(decodeGeneratedImageDataUrl(`data:${mimeType};base64,${bytes.toString('base64')}`,limit));
}
