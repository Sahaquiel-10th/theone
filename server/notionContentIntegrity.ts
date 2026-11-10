import {canonicalNotionBody} from './notionCanonical.js';

export type NotionContentIntegrityReason=
 |'source_empty'|'remote_incomplete'|'unsupported_source'|'unsupported_remote'
 |'title_unavailable'|'content_missing'|'ambiguous_layout'|'comparison_limit';
export type NotionContentIntegrityResult={
 version:1;
 state:'covered'|'missing'|'inconclusive';
 sourceBlockCount:number;
 matchedBlockCount:number;
 missingBlockCount:number;
 /** One-based source units, including a caller-proved projected title first. */
 missingBlockIndexes:number[];
 sourceChars:number;
 remoteChars:number;
 reason?:NotionContentIntegrityReason;
};
export type NotionContentIntegrityInput={
 source:string;
 remote:string;
 remoteComplete:boolean;
 /** Only the caller's exact saved title projection belongs in these fields. */
 sourceTitle?:string;
 remoteTitle?:string;
};

type CanonicalNode={type:string;children?:CanonicalNode[];value?:unknown;url?:unknown;targetRaw?:unknown;title?:unknown;checked?:unknown};
type Token=
 |{kind:'text'|'number'|'code';value:string}
 |{kind:'link';url:string;targetRaw:string;title:string|null;label:Token[]};
type ContentBlock=
 |{kind:'text';tokens:Token[];heading:boolean;checked?:boolean}
 |{kind:'code';value:string}
 |{kind:'table';rows:Token[][][]};
type ParsedDocument={blocks:ContentBlock[]};
type Match='matched'|'different'|'ambiguous';

const maximumCharacters=250_000;
const maximumBlocks=2_000;
const maximumComparisons=1_000_000;
const punctuation:Record<string,string>={
 '“':'"','”':'"','„':'"','「':'"','」':'"','『':'"','』':'"','＂':'"',
 '‘':"'",'’':"'",'＇':"'",'：':':','，':',','、':',','；':';',
 '。':'.','．':'.','！':'!','？':'?','（':'(', '）':')','［':'[','］':']',
 '｛':'{','｝':'}','—':'-',
};
const prose=(text:string)=>text.replace(/[“”„「」『』＂‘’＇：，、；。．！？（）［］｛｝—]/g,char=>punctuation[char]).replace(/\s+/gu,' ').replace(/ *([,:;.!?()[\]{}"']) */g,'$1').trim();

function numericValue(raw:string){
 const match=/^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?(%)?$/.exec(raw.replace(/[,， \t]/g,'').replace(/E/g,'e'))!;
 const fraction=match[3]??'',exponent=Number(match[4]??0),digits=match[2]+fraction;
 if(!Number.isFinite(exponent)||Math.abs(exponent)>1000||digits.length>1000)throw Error('numeric representation exceeds comparison limit');
 const significant=digits.replace(/^0+/,''),trailing=/0+$/.exec(significant)?.[0].length??0;
 const coefficient=trailing?significant.slice(0,-trailing):significant;
 const value=coefficient?coefficient+'e'+(exponent-fraction.length+trailing):'0';
 return match[1]+value+(match[5]??'');
}

/** Numeric punctuation is captured before prose punctuation is normalized.
 * No floating-point conversion can round a monetary amount or long integer. */
function textTokens(value:string):Token[]{
 const text=value.replace(/[０-９]/g,char=>String(char.charCodeAt(0)-0xff10)).replace(/−/g,'-').replace(/＋/g,'+').replace(/％/g,'%').replace(/．/g,'.');
 const number=/[+-]?(?:\d{1,3}(?:[,，]\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[ \t]*%)?/g;
 const tokens:Token[]=[];let at=0;
 for(const match of text.matchAll(number)){
  const before=prose(text.slice(at,match.index));if(before)tokens.push({kind:'text',value:before});
  // Equivalent decimal precision is a display choice. Sign and percent stay
  // explicit, so -3200, 3200, 32% and 32 remain different atoms.
  tokens.push({kind:'number',value:numericValue(match[0])});at=match.index!+match[0].length;
 }
 const tail=prose(text.slice(at));if(tail)tokens.push({kind:'text',value:tail});
 return tokens;
}

function inlineTokens(nodes:CanonicalNode[]):Token[]|undefined{
 const raw:({kind:'text';value:string}|Exclude<Token,{kind:'text'|'number'|'code'}>|{kind:'code';value:string})[]=[];
 const appendText=(value:string)=>{
  const previous=raw.at(-1);
  if(previous?.kind==='text')previous.value+=value;
  else raw.push({kind:'text',value});
 };
 for(const node of nodes){
  if(node.type==='text'&&typeof node.value==='string')appendText(node.value);
  else if(node.type==='break')appendText('\n');
  else if(node.type==='inlineCode'&&typeof node.value==='string')raw.push({kind:'code',value:node.value});
  else if(node.type==='link'&&typeof node.url==='string'&&typeof node.targetRaw==='string'){
   const label=inlineTokens(node.children??[]);
   if(!label||node.title!==undefined&&node.title!==null&&typeof node.title!=='string')return;
   raw.push({kind:'link',url:node.url,targetRaw:node.targetRaw,title:typeof node.title==='string'?node.title:null,label});
  }else return;
 }
 return raw.flatMap<Token>(token=>token.kind==='text'?textTokens(token.value):[token]);
}

/** Consume only the frozen v11 typed representation. Unknown platform syntax
 * stays inconclusive instead of becoming a guessed or stripped paragraph. */
function document(body:string):ParsedDocument|undefined{
 const prefix='v11-segments\n',canonical=canonicalNotionBody(body,11);
 if(!canonical.startsWith(prefix))return;
 const parsed=JSON.parse(canonical.slice(prefix.length)) as {tree?:CanonicalNode};
 if(parsed.tree?.type!=='root')return;
 const blocks:ContentBlock[]=[];
 const visit=(node:CanonicalNode,checked?:boolean):boolean=>{
  if(blocks.length>maximumBlocks)return false;
  if(node.type==='root'||node.type==='list'||node.type==='blockquote')return (node.children??[]).every(child=>visit(child));
  if(node.type==='listItem')return (node.children??[]).every((child,index)=>visit(child,index===0&&typeof node.checked==='boolean'?node.checked:undefined));
  if(node.type==='paragraph'||node.type==='heading'){
   const tokens=inlineTokens(node.children??[]);if(!tokens)return false;
   if(tokens.length)blocks.push({kind:'text',tokens,heading:node.type==='heading',...(checked!==undefined?{checked}:{})});
   return true;
  }
  if(node.type==='code'&&typeof node.value==='string'){blocks.push({kind:'code',value:node.value});return true;}
  if(node.type==='table'){
   const rows:Token[][][]=[];
   for(const row of node.children??[]){
    if(row.type!=='tableRow')return false;
    const cells:Token[][]=[];
    for(const cell of row.children??[]){
     if(cell.type!=='tableCell')return false;
     const tokens=inlineTokens(cell.children??[]);if(!tokens)return false;cells.push(tokens);
    }
    if(!cells.length||rows.length&&cells.length!==rows[0].length)return false;
    rows.push(cells);
   }
   if(!rows.length)return false;blocks.push({kind:'table',rows});return true;
  }
  // Dividers contain no source words, values, code or destinations.
  return node.type==='thematicBreak';
 };
 return visit(parsed.tree)&&blocks.length<=maximumBlocks?{blocks}:undefined;
}

const sameTokens=(source:Token[],remote:Token[])=>JSON.stringify(source)===JSON.stringify(remote);
function visibleText(tokens:Token[]):string|undefined{
 if(tokens.some(token=>token.kind!=='text'&&token.kind!=='number'))return;
 return tokens.map(token=>(token as {value:string}).value).join(' ');
}
function numericBoundary(source:string,remote:string,start:number){
 const before=remote[start-1]??'',after=remote[start+source.length]??'';
 return !(/^\d/.test(source)&&/[+\-\d.]/.test(before)||/[\d%]$/.test(source)&&/[\d.%]/.test(after));
}
const titleDecoration=(value:string)=>/^(?:(?:草稿|副本|已保存|更新于|创建于)|[+-]?\d+e[+-]?\d+%?|[\s\p{P}\p{S}\d年月日时分秒])*$/u.test(value);
export function notionTitleCovered(source:string,remote:string):boolean{
 const expected=prose(source),actual=prose(remote);
 if(!expected)return false;
 for(let at=actual.indexOf(expected);at>=0;at=actual.indexOf(expected,at+1)){
  if(numericBoundary(expected,actual,at)&&titleDecoration(actual.slice(0,at))&&titleDecoration(actual.slice(at+expected.length)))return true;
 }
 return false;
}
function textContains(source:string,remote:string){
 for(let at=remote.indexOf(source);at>=0;at=remote.indexOf(source,at+1))if(numericBoundary(source,remote,at))return true;
 return false;
}
function matches(source:ContentBlock,remote:ContentBlock):Match{
 if(source.kind!==remote.kind)return 'different';
 if(source.kind==='code'&&remote.kind==='code')return source.value===remote.value?'matched':'different';
 if(source.kind==='table'&&remote.kind==='table'){
  if(source.rows[0].length!==remote.rows[0].length)return 'ambiguous';
  let cursor=0;
  for(const row of source.rows){
   const at=remote.rows.findIndex((candidate,index)=>index>=cursor&&candidate.every((cell,column)=>sameTokens(row[column],cell)));
   if(at<0)return 'different';cursor=at+1;
  }
  return 'matched';
 }
 if(source.kind==='text'&&remote.kind==='text'){
  if(source.checked!==remote.checked)return 'different';
  if(sameTokens(source.tokens,remote.tokens))return 'matched';
  const expected=visibleText(source.tokens),actual=visibleText(remote.tokens);
  if(expected&&actual){
   if(source.heading&&remote.heading&&notionTitleCovered(expected,actual))return 'matched';
   if(textContains(expected,actual))return 'ambiguous';
  }
 }
 return 'different';
}

type LayoutAtom={kind:'character';value:string}|{kind:'check';value:boolean}|Token|{kind:'table_row';cells:Token[][]};
function tokenLayoutAtoms(tokens:Token[]):LayoutAtom[]{
 const atoms:LayoutAtom[]=[];
 for(const token of tokens){
  if(token.kind==='text'){
   for(const character of token.value)if(!/[\s\p{P}]/u.test(character))atoms.push({kind:'character',value:character});
  }else atoms.push(token);
 }
 return atoms;
}
function layoutAtoms(blocks:ContentBlock[],title?:string):LayoutAtom[]{
 const atoms:LayoutAtom[]=title?tokenLayoutAtoms(textTokens(title)):[];
 for(const block of blocks){
  if(block.kind==='text'){
   if(block.checked!==undefined)atoms.push({kind:'check',value:block.checked});
   for(const atom of tokenLayoutAtoms(block.tokens))atoms.push(atom);
  }else if(block.kind==='table'){
   // A platform may split one table into several blocks. Keep complete rows
   // and cell boundaries, without requiring the original table grouping.
   for(const cells of block.rows)atoms.push({kind:'table_row',cells});
  }else atoms.push(block);
 }
 return atoms;
}
function orderedLayoutAtoms(expected:LayoutAtom[],actual:LayoutAtom[]):boolean{
 let cursor=0;
 for(const atom of expected){
  const signature=JSON.stringify(atom);
  const label=atom.kind==='link'?tokenLayoutAtoms(atom.label):undefined;
  let found=false;
  while(cursor<actual.length){
   const candidate=actual[cursor++];
   if(atom.kind!==candidate.kind)continue;
   const same=atom.kind==='link'&&candidate.kind==='link'
    ?atom.url===candidate.url&&atom.targetRaw===candidate.targetRaw&&atom.title===candidate.title&&orderedLayoutAtoms(label!,tokenLayoutAtoms(candidate.label))
    :signature===JSON.stringify(candidate);
   if(same){found=true;break;}
  }
  if(!found)return false;
 }
 return true;
}
/** A layout-only fallback may lower certainty, never prove coverage. It
 * consumes every visible source atom in order, preserving duplicates, link
 * targets, literal code and each table row's separate cell values. */
function possibleLayout(source:ParsedDocument,remote:ParsedDocument,input:NotionContentIntegrityInput){
 const remoteTitle=input.sourceTitle!==undefined&&!notionTitleCovered(input.sourceTitle,input.remoteTitle??'')?undefined:input.remoteTitle;
 return orderedLayoutAtoms(layoutAtoms(source.blocks,input.sourceTitle),layoutAtoms(remote.blocks,remoteTitle));
}

/** Checks ordered source coverage only. The adapter supplies complete body
 * text and an explicit title projection. Transport envelopes are not parsed
 * here, and this result never decides whether an acknowledged write happened. */
export function checkNotionContentIntegrity(input:NotionContentIntegrityInput):NotionContentIntegrityResult{
 const stats={version:1 as const,sourceBlockCount:0,matchedBlockCount:0,missingBlockCount:0,missingBlockIndexes:[] as number[],sourceChars:input.source.length,remoteChars:input.remote.length};
 const inconclusive=(reason:NotionContentIntegrityReason):NotionContentIntegrityResult=>({...stats,state:'inconclusive',reason});
 if(!input.source.trim())return inconclusive('source_empty');
 if(input.remoteComplete!==true)return inconclusive('remote_incomplete');
 if(input.sourceTitle!==undefined&&!input.sourceTitle.trim())return inconclusive('unsupported_source');
 if(input.source.length>maximumCharacters||input.remote.length>maximumCharacters)return inconclusive('comparison_limit');
 let source:ParsedDocument|undefined,remote:ParsedDocument|undefined;
 try{source=document(input.source);}catch{return inconclusive('unsupported_source');}
 if(!source)return inconclusive('unsupported_source');
 stats.sourceBlockCount=source.blocks.length+(input.sourceTitle!==undefined?1:0);
 try{remote=document(input.remote);}catch{return inconclusive('unsupported_remote');}
 if(!remote)return inconclusive('unsupported_remote');
 if(!stats.sourceBlockCount)return inconclusive('source_empty');
 if(source.blocks.length*remote.blocks.length>maximumComparisons)return inconclusive('comparison_limit');
 if(input.sourceTitle!==undefined&&input.remoteTitle===undefined)return inconclusive('title_unavailable');
 const missing:number[]=[];let cursor=0,ambiguous=false;
 if(input.sourceTitle!==undefined){
  if(notionTitleCovered(input.sourceTitle,input.remoteTitle!))stats.matchedBlockCount++;
  else missing.push(1);
 }
 for(const [index,block] of source.blocks.entries()){
  let found=-1,possible=false;
  for(let at=cursor;at<remote.blocks.length;at++){
   const match=matches(block,remote.blocks[at]);
   if(match==='matched'){found=at;break;}
   if(match==='ambiguous')possible=true;
  }
  if(found>=0){stats.matchedBlockCount++;cursor=found+1;}
  else{missing.push(index+1+(input.sourceTitle!==undefined?1:0));ambiguous||=possible;}
 }
 if(missing.length&&!ambiguous)ambiguous=possibleLayout(source,remote,input);
 // Suspected layout changes are not proof that specific source blocks were
 // lost. Only the definite missing state exposes missing-block diagnostics.
 stats.missingBlockCount=ambiguous?0:missing.length;stats.missingBlockIndexes=ambiguous?[]:missing.slice(0,20);
 return {...stats,state:missing.length?ambiguous?'inconclusive':'missing':'covered',...(missing.length?{reason:ambiguous?'ambiguous_layout' as const:'content_missing' as const}:{})};
}
