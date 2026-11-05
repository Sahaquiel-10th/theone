/** Only request-local, already-authorized text enters this bank. The model
 * selects an opaque ID; the server returns the original bytes as the citation. */
export type TeachingCitationOption={id:string;source:'material'|'attachment';quote:string};
export function teachingCitationOptions(sources:{material:string;attachment:string},question:string):TeachingCitationOption[]{
 const stop=new Set(['什么','怎么','如何','哪些','请问','请优先','优先','依据','回答','课程','资料','这里','介绍','说法']);
 const terms=[...new Set([...new Intl.Segmenter('zh-CN',{granularity:'word'}).segment(question)].filter(x=>x.isWordLike&&x.segment.length>1&&!stop.has(x.segment)).map(x=>x.segment.toLowerCase()))].slice(0,16);
 const options:{value:TeachingCitationOption;rank:number;index:number}[]=[];
 for(const source of ['material','attachment'] as const){
  let index=0;
  for(const match of sources[source].matchAll(/[^\n。！？]{1,700}[。！？]?/gu)){
   const quote=match[0].trim();if(!quote)continue;
   // A contents entry or transport header cannot substantiate historical facts.
   if(/(?:[.．·]\s*){4,}|…{2,}|⋯{2,}/u.test(quote)||/^【[^】]{0,500}】$/u.test(quote)||/^#{1,6}\s/u.test(quote)||/^第[一二三四五六七八九十百0-9]+[章节篇卷]/u.test(quote)&&!/[。！？]/u.test(quote)||/^(?:第)?\d+页?$/u.test(quote))continue;
   const lower=quote.toLowerCase(),near=sources[source].slice(Math.max(0,(match.index??0)-250),(match.index??0)+quote.length+250).toLowerCase(),rank=terms.reduce((sum,t)=>sum+(lower.includes(t)?3*t.length:0)+(near.includes(t)?t.length:0),0);
   options.push({value:{id:`${source==='material'?'M':'A'}${++index}`,source,quote},rank,index:options.length});
  }
 }
 let materialId=0,attachmentId=0;
 return options.sort((a,b)=>b.rank-a.rank||a.index-b.index).slice(0,24).map(x=>({...x.value,id:x.value.source==='material'?`M${++materialId}`:`A${++attachmentId}`}));
}
export function selectTeachingCitations(ids:unknown,options:TeachingCitationOption[]):{source:'material'|'attachment';quote:string}[]{
 if(!Array.isArray(ids)||ids.length>8||new Set(ids).size!==ids.length)throw new Error('TEACHING_CITATION_INVALID');
 return ids.map(id=>{const found=typeof id==='string'?options.find(option=>option.id===id):undefined;if(!found)throw new Error('TEACHING_CITATION_INVALID');return {source:found.source,quote:found.quote};});
}
