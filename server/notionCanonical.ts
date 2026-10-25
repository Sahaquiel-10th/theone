import {createHash} from 'node:crypto';

export const notionHash=(body:string)=>createHash('sha256').update(body).digest('hex');
/** Persisted v1 receipts retain this exact comparison, never silently upgrade. */
export function legacyNotionNormalized(body:string){
 const literalCode=/`|~~~|^(?: {4}|\t)|<(?:pre|code)\b/im.test(body);
 const text=literalCode?body:body.replace(/<br\s*\/?>/gi,'\n');
 return text.split('\n').map(line=>line.trimEnd()).filter(line=>line.trim()).join('\n').trim();
}
/** V2 recognizes only the three proven Notion serialization differences.
 * Unknown tags, attributes, cell text, links and order remain byte-sensitive.
 * Code makes the whole document opaque rather than changing literal content. */
export function canonicalNotionBody(body:string){
 if(/`|~~~|^(?: {4}|\t)|<(?:pre|code)\b/im.test(body))return `raw\n${body}`;
 let text=body.replace(/(?<!\\)<b>([^<>\n]+)<\/b>/g,'**$1**');
 text=text.replace(/^<quote>\r?\n?([\s\S]*?)\r?\n?<\/quote>$/gm,(whole,content:string)=>{
  if(/<\/?quote\b/.test(content)||!content.trim())return whole;
  return content.split(/\r?\n/).map(line=>line.trim()?`> ${line}`:'').join('\n');
 });
 const lines=text.split('\n');
 text=lines.map((line,index)=>{
  if(/^\s*>\s*$/.test(line))return '';
  // A delimiter is a typed table row, not arbitrary punctuation in prose.
  if(/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|\s*$/.test(line)){
   const count=line.split('|').length,previous=lines.slice(0,index).filter(l=>l.trim()).at(-1),next=lines.slice(index+1).find(l=>l.trim());
   if(previous&&next&&/^\|.*\|\s*$/.test(previous)&&/^\|.*\|\s*$/.test(next)&&previous.split('|').length===count&&next.split('|').length===count)return line.split('|').map(cell=>cell.trim()).join('|').trimEnd();
  }
  return line;
 }).join('\n');
 return `markdown\n${legacyNotionNormalized(text)}`;
}
export const canonicalNotionDigest=(body:string)=>notionHash(canonicalNotionBody(body));
