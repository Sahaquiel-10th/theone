import type {CapabilityCard} from './capabilityCatalog.js';
import {featureCategories} from './featureCategories.js';

export type DiscoveryQuery = {query:string; industry?:string; category?:string; outputKind?:'text'|'image'|'local_file'; offset?:number};
export const discoverySchema = {type:'object',additionalProperties:false,properties:{
  query:{type:'string',maxLength:300},industry:{type:'string',maxLength:60},category:{type:'string',enum:featureCategories.map(item=>item.id)},
  outputKind:{type:'string',enum:['text','image','local_file']},offset:{type:'integer',minimum:0,maximum:10000}
},required:['query']};

export function validateDiscoveryQuery(raw:unknown):DiscoveryQuery {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('请说明要找的能力');
  const q=raw as DiscoveryQuery;
  if(Object.keys(q).some(key=>!['query','industry','category','outputKind','offset'].includes(key))||typeof q.query!=='string'||q.query.length>300
    ||q.industry!==undefined&&(typeof q.industry!=='string'||q.industry.length>60)
    ||q.category!==undefined&&!featureCategories.some(item=>item.id===q.category)
    ||q.outputKind!==undefined&&!['text','image','local_file'].includes(q.outputKind)
    ||q.offset!==undefined&&(!Number.isInteger(q.offset)||q.offset<0||q.offset>10000))throw new Error('能力查找条件无效');
  return {...q,query:q.query.trim()};
}
const normalized=(value:string)=>value.normalize('NFKC').toLowerCase();
function tokens(query:string) {
  const result=new Set<string>();
  for(const part of normalized(query).match(/[a-z0-9_]+|[\p{Script=Han}]+/gu)??[]) {
    if(/^[a-z0-9_]+$/.test(part)){if(part.length>1)result.add(part);continue;}
    if(part.length<=5)result.add(part);
    for(let i=0;i<part.length-1&&result.size<100;i++)result.add(part.slice(i,i+2));
  }
  return [...result];
}
function score(card:CapabilityCard,query:string) {
  const terms=tokens(query),q=normalized(query);
  const fields:[string,number][]=[
    [card.name,8],[card.description,1],[(card.discovery?.aliases??[]).join(' '),8],[(card.discovery?.scenarios??[]).join(' '),5],
    [(card.discovery?.industries??[]).join(' '),5],[featureCategories.find(item=>item.id===card.category)?.name??'',3],[(card.tools??[]).join(' '),2]
  ];
  let value=0;
  for(const [text,weight] of fields){const body=normalized(text);value+=terms.filter(term=>body.includes(term)).length*weight;}
  for(const name of [card.name,...card.discovery?.aliases??[]])if(name.length>1&&q.includes(normalized(name)))value+=100;
  return value;
}
/** Input must be a freshly authorized catalog. Search never broadens its scope. */
export function discoverCapabilities(cards:CapabilityCard[],input:DiscoveryQuery) {
  const q=validateDiscoveryQuery(input);
  const ranked=cards.filter(card=>card.available&&(!q.category||card.category===q.category)
    &&(!q.outputKind||card.outputKinds.includes(q.outputKind)))
    .map(card=>{const relevance=score(card,q.query);return {card,relevance,score:relevance+(q.industry&&(card.discovery?.industries??[]).some(industry=>normalized(industry).includes(normalized(q.industry!)))?40:0)};}).filter(item=>!q.query||item.relevance>0)
    .sort((a,b)=>b.score-a.score||a.card.id.localeCompare(b.card.id));
  const offset=q.offset??0,items=ranked.slice(offset,offset+8).map(item=>item.card);
  return {items,total:ranked.length,nextOffset:offset+items.length<ranked.length?offset+items.length:undefined,
    message:items.length?'这些是当前账号已开放的候选能力；这里只查目录，没有执行或购买。':'当前授权范围内没有匹配项；可换关键词或去掉分类再找，不能据此断言平台没有这种能力。'};
}

/** Essential executors + explicit selections + a small relevant shortlist. No full-library prompt. */
export function initialCapabilityContext(cards:CapabilityCard[],query:string,featureIds:string[]=[]) {
  const keep=new Map<string,CapabilityCard>();
  let sources=0;
  for(const card of cards)if(['general','logic','writing','image_generation','local_special'].includes(card.executorId??'')||featureIds.includes(card.featureId??'')||card.kind==='knowledge'&&sources++<6)keep.set(card.id,card);
  for(const card of discoverCapabilities(cards,{query:query.slice(0,300)}).items.slice(0,6))keep.set(card.id,card);
  return [...keep.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
