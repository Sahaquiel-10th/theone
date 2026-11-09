import {createHash} from 'node:crypto';
import {fromMarkdown} from 'mdast-util-from-markdown';
import {gfm} from 'micromark-extension-gfm';
import {gfmFromMarkdown} from 'mdast-util-gfm';

export const notionHash=(body:string)=>createHash('sha256').update(body).digest('hex');
export const CURRENT_NOTION_CANONICAL_VERSION=11 as const;
export type NotionCanonicalVersion=2|3|4|5|6|7|8|9|10|11;
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
 * v2-v5 keep their original whole-document code guard. v6 protects exact code
 * regions independently, without interpreting their contents as formatting.
 * v7 additionally recognizes the exact plain single-line inline-code spelling
 * emitted by Notion; all other code retains its original byte proof. v8 only
 * folds non-ASCII UTF-8 URL spelling after an unchanged ASCII authority. v9
 * admits underscore-containing identifiers only when the HTML parser proves
 * one exact plain text child inside attribute-free inline code. v10 uses
 * Markdown text-node values for proven character escapes and entities, and
 * recognizes attribute-free, standalone Notion empty-paragraph markers. v11
 * compares inline style coverage on leaves, independent of how one rich-text
 * range was split or whether its style wrapper sits around a link label. */
export function canonicalNotionBody(body:string,version:NotionCanonicalVersion=5){
 if(version>=6){
  const protectedBody=protectNotionCode(body,version);
  // Unclosed/ambiguous code and user control markers stay entirely opaque.
  if(!protectedBody)return `v${version}-raw\n${body}`;
  const restored=restoreNotionLiterals(canonicalMarkdown(protectedBody.text,version),protectedBody.code);
  if(!restored)return `v${version}-raw\n${body}`;
  return `v${version}-segments\n${JSON.stringify(canonicalTextLiterals(restored.body,restored.ranges,version))}`;
 }
 if(/`|~~~|^(?: {4}|\t)|<(?:pre|code)\b/im.test(body))return `raw\n${body}`;
 return canonicalMarkdown(body,version);
}
function canonicalMarkdown(body:string,version:NotionCanonicalVersion){
 const knownTag=version>=10?/^<\/?(?:b|i|s|u|quote)>$|^<br\s*\/?>$/i:/^<\/?(?:b|i|quote)>$|^<br\s*\/?>$/i;
 if(version>=6&&(body.match(/<\/?[A-Za-z][^>\n]*>/g)??[]).some(tag=>!knownTag.test(tag)))return `opaque-markdown\n${body}`;
 // Normalize before bold so a nested <i><b>...</b></i> remains conservative.
 // Edge whitespace, attributes, escapes and Markdown controls are not the
 // proven plain-text serialization and must not acquire equivalent meaning.
 let text=version===5?body.replace(/(?<!\\)<i>([^<>\n]+)<\/i>/g,(whole,content:string)=>content===content.trim()&&!/[\\*_~\[\]]/.test(content)?`*${content}*`:whole):body;
 if(version<6)text=text.replace(/(?<!\\)<b>([^<>\n]+)<\/b>/g,'**$1**');
 text=text.replace(/^<quote>\r?\n?([\s\S]*?)\r?\n?<\/quote>$/gm,(whole,content:string)=>{
  if(/<\/?quote\b/.test(content)||!content.trim())return whole;
  const quote=content.split(/\r?\n/).map(line=>line.trim()?`> ${line}`:'').join('\n');
  // The explicit closing wrapper ends a block. Keep that boundary while
  // parsing v6; a following paragraph/table must not become lazy quote text.
  return version>=6?`\n${quote}\n\n`:quote;
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
 // Do not remove paragraph boundaries before Markdown decides whether stars
 // are active emphasis or visible text. Only the final typed layout may fold
 // presentation whitespace; code/text values themselves stay protected.
 return version>=6?text.replace(/(?<!\\)<br\s*\/?>/gi,'\n'):`markdown\n${legacyNotionNormalized(text)}`;
}

type LiteralKind='code'|'link'|'url';
type ProtectedLiteral={kind:LiteralKind;raw:string;targetRaw?:string;inlineValue?:string};
type ProtectedRange={start:number;end:number;kind:LiteralKind;targetRaw?:string;inlineValue?:string};
function restoreNotionLiterals(text:string,literals:ProtectedLiteral[]){
 let body='',at=0;const ranges:ProtectedRange[]=[],used=new Set<number>();
 for(const match of text.matchAll(/\u0000C(\d+)\u0000/g)){
  const id=Number(match[1]),literal=literals[id];if(!literal||used.has(id))return;
  used.add(id);body+=text.slice(at,match.index);const start=body.length;body+=literal.raw;ranges.push({start,end:body.length,kind:literal.kind,targetRaw:literal.targetRaw,inlineValue:literal.inlineValue});at=match.index!+match[0].length;
 }
 if(used.size!==literals.length)return;body+=text.slice(at);return {body,ranges};
}
type MarkdownNode={type:string;value?:string;position?:{start:{offset?:number};end:{offset?:number}};children?:MarkdownNode[]};
const inlineHtmlStyleTypes:Record<string,string>={b:'strong',i:'emphasis',s:'delete',u:'notionUnderline'};
/** Map balanced, attribute-free inline styles to the same typed nodes as
 * Markdown. Child positions survive so code and link proofs stay exact. */
function typedNotionInlineStyles(nodes:MarkdownNode[]):MarkdownNode[]{
 const frames:{tag?:string;children:MarkdownNode[]}[]=[{children:[]}];
 for(const node of nodes){
  const opening=node.type==='html'&&/^<([bisu])>$/.exec(String(node.value));
  if(opening){frames.push({tag:opening[1],children:[]});continue;}
  const closing=node.type==='html'&&/^<\/([bisu])>$/.exec(String(node.value));
  if(closing){
   const frame=frames.at(-1)!;
   // A malformed range retains every original tag instead of acquiring a
   // partially inferred style or losing its visible tag spelling.
   if(frames.length===1||frame.tag!==closing[1])return nodes;
   frames.pop();
   frames.at(-1)!.children.push({type:inlineHtmlStyleTypes[frame.tag],children:frame.children});
  }else frames.at(-1)!.children.push(node);
 }
 return frames.length===1?frames[0].children:nodes;
}
type CanonicalNode={type:string;children?:CanonicalNode[];styles?:string[];value?:unknown;[key:string]:unknown};
/** Rich-text styles affect visible leaves. Link containers retain every
 * destination field while only their labels inherit style coverage. */
function canonicalInlineStyleCoverage(tree:CanonicalNode):CanonicalNode{
 const normalize=(nodes:CanonicalNode[],inherited:readonly string[]):CanonicalNode[]=>{
  const result:CanonicalNode[]=[];
  const append=(node:CanonicalNode)=>{
   const previous=result.at(-1);
   if(previous?.type==='text'&&node.type==='text'&&typeof previous.value==='string'&&typeof node.value==='string'){
    const {value:previousValue,...previousMetadata}=previous;
    const {value,...metadata}=node;
    if(JSON.stringify(previousMetadata)===JSON.stringify(metadata)){previous.value=previousValue+value;return;}
   }
   result.push(node);
  };
  for(const node of nodes){
   if(node.type==='notionInlineStyles'){
    const styles=[...new Set([...inherited,...(node.styles??[])])].sort();
    for(const child of normalize(node.children??[],styles))append(child);
   }else{
    const normalized={...node};
    if(node.children)normalized.children=normalize(node.children,inherited);
    else if(inherited.length)normalized.styles=[...inherited];
    append(normalized);
   }
  }
  return result;
 };
 return {...tree,children:normalize(tree.children??[],[])};
}
/** Parse with original paragraph boundaries. Literal punctuation may use its
 * escaped spelling, but strong/emphasis/table/list structure is never erased.
 * Raw code and link targets additionally bind syntax the parser would decode. */
function canonicalTextLiterals(body:string,protectedRanges:ProtectedRange[],version:NotionCanonicalVersion){
 const parsedUrls=new Set<ProtectedRange>(),parsedInlineCodes=new Set<ProtectedRange>();
 const clean=(node:MarkdownNode):unknown=>{
  const result:Record<string,unknown>={},record=node as unknown as Record<string,unknown>;
  for(const key of Object.keys(record).sort())if(key!=='position'&&key!=='children')result[key]=record[key];
  const start=node.position?.start.offset,end=node.position?.end.offset,raw=start===undefined||end===undefined?undefined:body.slice(start,end);
  // The parser proves escapes/entities are literal text before v10 folds
  // their spelling. Active markup, code, and link targets remain typed or
  // separately protected. Earlier receipts retain their exact old meaning.
  if(node.type==='text'&&raw!==undefined)result.value=version>=10?node.value:raw.replace(/\\([*_])/g,'$1');
  if(['code','inlineCode','html','image','imageReference'].includes(node.type)&&raw!==undefined)result.raw=raw;
  if(version>=7&&node.type==='inlineCode'){
   const literal=protectedRanges.find(range=>range.kind==='code'&&range.start===start&&range.end===end&&range.inlineValue!==undefined);
   // A protected link includes its label. Nested code therefore has no
   // separate outer range, but its exact parsed plain spelling is still proof.
   const nestedValue=version>=11&&typeof node.value==='string'&&raw===`\`${node.value}\``&&plainInlineCode(node.value,version)?node.value:undefined;
   const value=literal?.inlineValue??nestedValue;
   if(value!==undefined){result.value=value;delete result.raw;if(literal)parsedInlineCodes.add(literal);}
  }
  if(['link','linkReference','definition'].includes(node.type)&&start!==undefined&&end!==undefined){
   const literal=protectedRanges.find(range=>range.start<=start&&range.end>=end);
   result.targetRaw=literal?.targetRaw??raw;
   // GFM may serialize a bare URL as [the same visible URL](URL). Remove
   // only syntax parentheses whose contents are byte-identical to the parsed
   // target. Escapes, titles and every URL byte remain separately binding.
   if(node.type==='link'&&record.title==null&&typeof record.url==='string'){
    const target=version>=8?notionUtf8Url(record.url):record.url;
    if(version>=8)result.url=target;
    if(literal?.kind==='link'&&literal.targetRaw===`(${record.url})`)result.targetRaw=target;
    if(literal?.kind==='url'&&raw===record.url){result.targetRaw=target;parsedUrls.add(literal);}
   }
  }
  if(node.children){
   const children:unknown[]=[];
   const nodes=version>=10?typedNotionInlineStyles(node.children):node.children;
   for(let index=0;index<nodes.length;index++){
    const opening=nodes[index],text=nodes[index+1],closing=nodes[index+2];
    const tag=version<10&&opening.type==='html'&&/^<(b|i)>$/.exec(String(opening.value));
    const start=text?.position?.start.offset,end=text?.position?.end.offset,plain=start===undefined||end===undefined?'':body.slice(start,end);
    const exactCodeTags=version>=7&&opening.type==='html'&&opening.value==='<code>'&&text?.type==='text'&&closing?.type==='html'&&closing.value==='</code>';
    const code=exactCodeTags?protectedRanges.find(range=>range.kind==='code'&&range.start===opening.position?.start.offset&&range.end===closing.position?.end.offset&&range.inlineValue===plain):undefined;
    const codeValue=code?.inlineValue??(version>=11&&exactCodeTags&&text.value===plain&&plainInlineCode(plain,version)?plain:undefined);
    // Exact balanced plain HTML emphasis is a typed node. Synthesizing **/*
    // here would incorrectly turn real emphasis into visible stars whenever
    // punctuation makes the generated Markdown delimiter non-flanking.
    if(codeValue!==undefined){children.push({type:'inlineCode',value:codeValue});if(code)parsedInlineCodes.add(code);index+=2;}
    else if(tag&&text?.type==='text'&&closing?.type==='html'&&closing.value===`</${tag[1]}>`&&plain&&plain===plain.trim()&&!/[\\*_~\[\]<>\r\n]/u.test(plain)){
     children.push({type:tag[1]==='b'?'strong':'emphasis',children:[clean(text)]});index+=2;
    }else children.push(clean(opening));
   }
   result.children=children;
  }
  if(version>=10&&Object.values(inlineHtmlStyleTypes).includes(node.type)){
   let styles=[node.type],children=result.children as unknown[];
   const child=children.length===1?children[0] as {type?:unknown;styles?:string[];children?:unknown[]}|undefined:undefined;
   // Styles commute only when they cover the identical complete subtree.
   // A partially styled sibling keeps its own range in the child tree.
   if(child?.type==='notionInlineStyles'&&child.styles&&child.children){styles=[...styles,...child.styles];children=child.children;}
   return {type:'notionInlineStyles',styles:[...new Set(styles)].sort(),children};
  }
  return result;
 };
 const parsed=clean(fromMarkdown(body,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]}));
 const tree=version>=11?canonicalInlineStyleCoverage(parsed as CanonicalNode):parsed;
 return {tree,protected:protectedRanges.filter(range=>range.kind==='code'&&!parsedInlineCodes.has(range)||range.kind==='url'&&!parsedUrls.has(range)).map(range=>({kind:range.kind,raw:body.slice(range.start,range.end)}))};
}

/** Notion may UTF-8 percent-encode a non-ASCII path/query/fragment character.
 * Keep the authority and every ASCII byte untouched: no decoding, trimming,
 * case folding, dot-segment resolution, percent rewriting or URL reparsing. */
function notionUtf8Url(value:string){
 const match=/^(https?:\/\/[^/?#\s]+)([/?#][^\s]*)?$/.exec(value);
 if(!match||!match[2]||/[^\x21-\x7e]/.test(match[1])||value.includes('\\'))return value;
 try{return match[1]+match[2].replace(/[^\x00-\x7f]/gu,char=>encodeURIComponent(char));}catch{return value;}
}

const plainInlineCode=(value:string,version:NotionCanonicalVersion)=>Boolean(value)&&value===value.trim()&&!(version>=9?/[\\`*~\[\]<>&\r\n]/u:/[\\`*_~\[\]<>&\r\n]/u).test(value);

/** Preserve the exact bytes and positions of code and links/URLs; formatting
 * replacements must never rewrite a link target. User markers are rejected. */
function protectNotionCode(body:string,version:NotionCanonicalVersion):{text:string;code:ProtectedLiteral[]}|undefined{
 if(body.includes('\u0000'))return;
 const code:ProtectedLiteral[]=[];let text='',index=0;
 const lineEnd=(at:number)=>{const end=body.indexOf('\n',at);return end<0?body.length:end+1;};
 const protect=(end:number,kind:LiteralKind='code',targetRaw?:string,inlineValue?:string)=>{text+=`\u0000C${code.length}\u0000`;code.push({kind,raw:body.slice(index,end),targetRaw,inlineValue});index=end;};
 const escaped=(at:number)=>{let count=0;while(at>0&&body[--at]==='\\')count++;return count%2===1;};
 while(index<body.length){
  if(index===0||body[index-1]==='\n'){
   const end=lineEnd(index),line=body.slice(index,end),fence=/^ {0,3}(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)/.exec(line);
   if(/^ {0,3}\[[^\]\r\n]+\]:/.test(line)){protect(end,'link',line);continue;}
   if(fence){
    if(fence[1][0]==='`'&&fence[2].includes('`'))return;
    const close=new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*(?:\\r?\\n|$)`);let cursor=end,closed=false;
    while(cursor<body.length){const next=lineEnd(cursor);if(close.test(body.slice(cursor,next))){protect(next);closed=true;break;}cursor=next;}
    if(!closed)return;
    continue;
   }
   if(/^(?: {4}|\t)[^\r\n]*\S/.test(line)){
    let cursor=end;
    while(cursor<body.length){const next=lineEnd(cursor),nextLine=body.slice(cursor,next);if(!/^(?: {4}|\t)|^\s*$/.test(nextLine))break;cursor=next;}
    protect(cursor);continue;
   }
  }
  if(body[index]==='['&&!escaped(index)){
   let cursor=index+1,depth=1;
   for(;cursor<body.length&&cursor-index<=6000&&!/[\r\n]/.test(body[cursor]);cursor++){
    if(escaped(cursor))continue;if(body[cursor]==='[')depth++;if(body[cursor]===']'&&!--depth)break;
   }
   if(depth===0&&body[cursor+1]==='('){
    let at=cursor+2,parens=1,quote='';
    for(;at<body.length&&at-index<=6000&&!/[\r\n]/.test(body[at]);at++){
     if(escaped(at))continue;const char=body[at];if(quote){if(char===quote)quote='';continue;}
     if((char==='"'||char==="'")&&/\s/.test(body[at-1])){quote=char;continue;}
     if(char==='(')parens++;if(char===')'&&!--parens)break;
    }
    if(parens!==0)return;protect(at+1,'link',body.slice(cursor+1,at+1));continue;
   }
   if(depth===0&&body[cursor+1]==='['){const end=body.indexOf(']',cursor+2);if(end<0||/[\r\n]/.test(body.slice(cursor+2,end)))return;protect(end+1,'link',body.slice(cursor+1,end+1));continue;}
  }
  const autoLink=body[index]==='<'?/^<(?:https?:\/\/|mailto:)[^>\r\n]+>/i.exec(body.slice(index)):null;
  if(autoLink){protect(index+autoLink[0].length,'url');continue;}
  const url=/[hHmM]/.test(body[index])?/^(?:https?:\/\/|mailto:)[^\s<>]+/i.exec(body.slice(index)):null;
  if(url){protect(index+url[0].length,'url');continue;}
  if(version>=10&&(index===0||body[index-1]==='\n')){
   // These two documented platform spellings are paragraph separators only
   // on a line of their own. Fenced/indented code and links were protected
   // above. Inline, escaped, attributed, or other tags retain their bytes.
   const empty=/^<(?:empty-block|p)[ \t]*\/>[ \t]*(\r?\n|$)/.exec(body.slice(index));
   if(empty){text+=empty[1]?'\n':'';index+=empty[0].length;continue;}
  }
  const tag=body[index]==='<'?/^<(pre|code)\b[^>]*>/i.exec(body.slice(index)):null;
  if(tag&&!escaped(index)){
   const close=new RegExp(`</${tag[1]}\\s*>`,'i'),tail=body.slice(index+tag[0].length),match=close.exec(tail);
   if(!match)return;
   const value=tail.slice(0,match.index),inline=version>=7&&tag[0]==='<code>'&&match[0]==='</code>'&&plainInlineCode(value,version)?value:undefined;
   protect(index+tag[0].length+match.index+match[0].length,'code',undefined,inline);continue;
  }
  if(body[index]==='<'){
   if(body.startsWith('<!',index)||body.startsWith('<?',index))return;
   const knownTag=version>=10?/^<\/?(?:b|i|s|u|quote)>|^<br\s*\/?>/i:/^<\/?(?:b|i|quote)>|^<br\s*\/?>/i;
   if(/^<\/?[A-Za-z][A-Za-z0-9:-]*(?=[\s/>])/.test(body.slice(index))&&!knownTag.test(body.slice(index)))return;
  }
  if(body[index]==='`'&&!escaped(index)){
   let width=1;while(body[index+width]==='`')width++;
   let cursor=index+width,closed=false;
   while(cursor<body.length){const next=body.indexOf('`',cursor);if(next<0)break;let length=1;while(body[next+length]==='`')length++;
    if(length===width){const value=body.slice(index+width,next),inline=version>=7&&width===1&&plainInlineCode(value,version)?value:undefined;protect(next+length,'code',undefined,inline);closed=true;break;}cursor=next+length;
   }
   if(!closed){
    if(version<10)return;
    // An unmatched inline backtick is literal Markdown text. The parsed
    // node still decides whether its escaped spelling has the same value.
    text+=body[index++];
   }
   continue;
  }
  text+=body[index++];
 }
 return {text,code};
}
export const canonicalNotionDigest=(body:string,version:NotionCanonicalVersion=5)=>notionHash(canonicalNotionBody(body,version));
