import JSZip from 'jszip';
export const xml=(s:unknown)=>String(s??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export const unxml=(s:string)=>s.replace(/&(amp|lt|gt|quot|apos);/g,(_,n)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"} as Record<string,string>)[n]!);
export const prolog='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
export function obj(v:unknown,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('结构化文件参数无效');return v as Record<string,any>;}
export function str(v:unknown,max=200,empty=false):string{if(typeof v!=='string'||(!empty&&!v.trim())||v.length>max)throw new Error(`文字为空或超过${max}字`);return v;}
export const filename=(s:string,ext:string)=>s.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'').slice(0,80)+ext;
export type OfficeFile={name:string;bytes:Buffer;mime:string};
export const MIME={xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
export async function boundedOfficeZip(bytes:Buffer){
 if(!bytes.length||bytes.length>2*1024*1024)throw new Error('模板最多2MB');
 const zip=await JSZip.loadAsync(bytes),files=Object.values(zip.files).filter(f=>!f.dir);if(files.length>200)throw new Error('模板结构过于复杂');
 let total=0;for(const file of files){await new Promise<void>((resolve,reject)=>{const stream=file.nodeStream();stream.on('data',(chunk:Buffer)=>{total+=chunk.length;if(total>12*1024*1024){stream.pause();reject(new Error('模板解压内容过大'));}});stream.on('end',resolve);stream.on('error',reject);});}
 if(files.some(f=>/vbaProject|externalLinks|connections\.xml|embeddings\//i.test(f.name)))throw new Error('请使用不含宏、外部链接或嵌入对象的标准XLSX模板');
 return zip;
}
