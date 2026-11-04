import {Fragment} from 'react';
import type {CuriousOption,CuriousStage} from '../server/curiousOnboarding';

export type CuriousTextRun={text:string;strong:boolean};
export type CuriousTextOptions={
  /** A literal substring supplied by presentation metadata, never a pattern. */
  emphasis?:string;
  /** Only short, visible phrases are inferred. Disable for user-authored text. */
  fallbackEmphasis?:boolean;
};
export type CuriousOptionPresentation={
  title:string;
  support?:string;
  emphasis?:string;
  intent:'primary'|'secondary'|'tertiary'|'reply';
  kind:'source'|'action'|'reply';
};

const keywords=[
  '可交互网页','交互网页','简短框架','边聊边改','几个方向','小例子',
  '写东西','做内容','做方案','推进项目','整理资料','服务客户','做生意',
  '按需查找','核对引用','自己的资料','使用说明','任务区','主对话','继续聊',
] as const;
const bold=/\*\*([^*\n]+)\*\*/gu;
const maxMarkedLength=48;

function append(runs:CuriousTextRun[],text:string,strong=false){
  if(!text)return;
  const last=runs.at(-1);
  if(last?.strong===strong)last.text+=text;
  else runs.push({text,strong});
}

/** Only exact, paired **short text** markers are recognized. HTML, links,
 * Markdown images, single stars and unmatched markers remain plain text. */
function markedRuns(text:string):CuriousTextRun[]{
  const runs:CuriousTextRun[]=[];
  let offset=0,count=0;
  for(const match of text.matchAll(bold)){
    const start=match.index,end=start+match[0].length,content=match[1];
    if(text[start-1]==='*'||text[end]==='*'||!content.trim()||content!==content.trim()||[...content].length>maxMarkedLength||count>=3)continue;
    append(runs,text.slice(offset,start));append(runs,content,true);offset=end;count++;
  }
  append(runs,text.slice(offset));
  return runs;
}

function literalRuns(text:string,phrases:readonly string[],conservative:boolean):CuriousTextRun[]{
  const candidates=phrases.flatMap(phrase=>{
    const start=phrase?text.indexOf(phrase):-1;
    return start<0?[]:[{start,end:start+phrase.length,text:phrase}];
  }).sort((a,b)=>a.start-b.start||b.text.length-a.text.length);
  const runs:CuriousTextRun[]=[];
  let offset=0,count=0,used=0;
  const budget=conservative?Math.min(16,Math.floor([...text.replace(/\s/gu,'')].length/2)):maxMarkedLength;
  for(const candidate of candidates){
    const length=[...candidate.text].length;
    if(candidate.start<offset||count>=(conservative?2:1)||used+length>budget)continue;
    // A short whole reply is allowed when its phrase was explicitly selected
    // by the option presenter. Inferred emphasis must leave actual prose.
    if(conservative&&!/[\p{L}\p{N}]/u.test(text.slice(0,candidate.start)+text.slice(candidate.end)))continue;
    append(runs,text.slice(offset,candidate.start));append(runs,candidate.text,true);
    offset=candidate.end;used+=length;count++;
  }
  append(runs,text.slice(offset));
  return runs;
}

export function curiousTextRuns(text:string,{emphasis,fallbackEmphasis=true}:CuriousTextOptions={}):CuriousTextRun[]{
  if(text.includes('*'))return markedRuns(text);
  if(emphasis)return literalRuns(text,[emphasis],false);
  return fallbackEmphasis?literalRuns(text,keywords,true):text?[{text,strong:false}]:[];
}

/** Inline nodes only: safe inside an existing paragraph or a button title. */
export function CuriousInlineText({text,emphasis,fallbackEmphasis=true}:{text:string}&CuriousTextOptions){
  return <>{curiousTextRuns(text,{emphasis,fallbackEmphasis}).map((run,index)=>run.strong?<strong key={index}>{run.text}</strong>:<Fragment key={index}>{run.text}</Fragment>)}</>;
}

/** Paragraphs only: the caller owns spacing, color and the outer container. */
export function CuriousText({text,...options}:{text:string}&CuriousTextOptions){
  const paragraphs=text.replace(/\r\n?/gu,'\n').split(/\n[\t ]*\n(?:[\t ]*\n)*/u);
  return <>{paragraphs.filter(part=>part.trim()).map((part,index)=><p key={index}><CuriousInlineText text={part} {...options}/></p>)}</>;
}

/** Display metadata for an already authorized server option. It does not
 * validate a connection, rank sources, select a default or change its id. */
export function curiousOptionPresentation(option:CuriousOption,stage?:CuriousStage):CuriousOptionPresentation{
  if(stage==='knowledge'&&option.id.startsWith('connection:')){
    const title=option.label.replace(/^用已连接的\s*/u,'').trim()||option.label;
    return {title,support:'已连接 · 按需查找',intent:'primary',kind:'source'};
  }
  if(stage==='knowledge'&&option.action==='connect')return {title:option.label,intent:'secondary',kind:'action'};
  if(stage==='knowledge'&&option.id==='later')return {title:option.label,intent:'tertiary',kind:'reply'};
  const emphasis=keywords.map(phrase=>({phrase,index:option.label.indexOf(phrase)})).filter(item=>item.index>=0).sort((a,b)=>a.index-b.index||b.phrase.length-a.phrase.length)[0]?.phrase;
  return {title:option.label,...(emphasis?{emphasis}:{}),intent:'reply',kind:option.action?'action':'reply'};
}
