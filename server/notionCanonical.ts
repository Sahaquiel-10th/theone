import {createHash} from 'node:crypto';

export const notionHash=(body:string)=>createHash('sha256').update(body).digest('hex');
/** Persisted v1 receipts retain this exact comparison, never silently upgrade. */
export function legacyNotionNormalized(body:string){
 const literalCode=/`|~~~|^(?: {4}|\t)|<(?:pre|code)\b/im.test(body);
 const text=literalCode?body:body.replace(/<br\s*\/?>/gi,'\n');
 return text.split('\n').map(line=>line.trimEnd()).filter(line=>line.trim()).join('\n').trim();
}
/** Versions retain their persisted meaning: v2 recognizes three proven
 * serialization differences; v3 accepts delimiter hyphen-run lengths; v4
 * additionally treats delimiter alignment markers as presentation only; v5
 * recognizes exact, plain single-line italic serialization. Earlier versions
 * retain their persisted meaning, including literal <i> text under v4.
 * Unknown tags, attributes, cell text, links and order remain byte-sensitive.
 * Code makes the whole document opaque rather than changing literal content. */
export function canonicalNotionBody(body:string,version:2|3|4|5=5){
 if(/`|~~~|^(?: {4}|\t)|<(?:pre|code)\b/im.test(body))return `raw\n${body}`;
 // Normalize before bold so a nested <i><b>...</b></i> remains conservative.
 // Edge whitespace, attributes, escapes and Markdown controls are not the
 // proven plain-text serialization and must not acquire equivalent meaning.
 let text=version>=5?body.replace(/(?<!\\)<i>([^<>\n]+)<\/i>/g,(whole,content:string)=>content===content.trim()&&!/[\\*_~\[\]]/.test(content)?`*${content}*`:whole):body;
 text=text.replace(/(?<!\\)<b>([^<>\n]+)<\/b>/g,'**$1**');
 text=text.replace(/^<quote>\r?\n?([\s\S]*?)\r?\n?<\/quote>$/gm,(whole,content:string)=>{
  if(/<\/?quote\b/.test(content)||!content.trim())return whole;
  return content.split(/\r?\n/).map(line=>line.trim()?`> ${line}`:'').join('\n');
 });
 const lines=text.split('\n');
 text=lines.map((line,index)=>{
  if(/^\s*>\s*$/.test(line))return '';
  // A delimiter is a typed table row, not arbitrary punctuation in prose.
  const delimiter=/^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|\s*$/;
  if(delimiter.test(line)){
   const count=line.split('|').length,previous=version===2?lines.slice(0,index).filter(l=>l.trim()).at(-1):lines[index-1],next=version===2?lines.slice(index+1).find(l=>l.trim()):lines[index+1];
   let insideTable=false;
   if(version>=3)for(let before=index-1;before>=0&&/^\|.*\|\s*$/.test(lines[before]);before--)if(delimiter.test(lines[before])){insideTable=true;break;}
   if(!insideTable&&previous&&next&&/^\|.*\|\s*$/.test(previous)&&/^\|.*\|\s*$/.test(next)&&previous.split('|').length===count&&next.split('|').length===count)return line.split('|').map(cell=>version>=4&&cell.trim()?'---':version===3?cell.trim().replace(/-{3,}/,'---'):cell.trim()).join('|').trimEnd();
  }
  return line;
 }).join('\n');
 return `markdown\n${legacyNotionNormalized(text)}`;
}
export const canonicalNotionDigest=(body:string,version:2|3|4|5=5)=>notionHash(canonicalNotionBody(body,version));
