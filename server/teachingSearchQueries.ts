/** ima's lexical endpoint can miss an unspaced Chinese question. Broaden only
 * the query, never the authorized source; at most two additional terms. */
export function teachingSearchQueries(query:string){
 const original=query.trim();
 if(original.length>400)return [original];
 const segmenter=new Intl.Segmenter('zh-CN',{granularity:'word'});
 const terms=[...segmenter.segment(original)].filter(s=>s.isWordLike&&s.segment.length>=2&&!['什么','怎么','如何','哪些','介绍','一下','问题','请问','位置'].includes(s.segment)).map(s=>s.segment);
 return [original,...[...new Set(terms)].filter(t=>t!==original).slice(0,2)];
}
