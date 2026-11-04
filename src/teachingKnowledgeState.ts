import type {TeachingKnowledgeSource} from '../server/teachingTypes';
/** Explicit selection consent travels only until the normalizing server save. */
export type TeachingKnowledgeSelection=TeachingKnowledgeSource&{confirmed?:true};
export type TeachingKnowledgePreview={status:'read'|'no_match';query:string;title:string;text:string};
export const teachingKnowledgeSourceKey=(source:Pick<TeachingKnowledgeSource,'connectionId'|'scope'|'pageId'>)=>JSON.stringify([source.connectionId,source.scope,source.pageId??'']);
export function mergeTeachingKnowledgeSelection(sources:readonly TeachingKnowledgeSource[],selected:TeachingKnowledgeSelection){const next=[...sources.filter(source=>teachingKnowledgeSourceKey(source)!==teachingKnowledgeSourceKey(selected)),selected];if(next.length>5)throw new Error('每门课程最多关联 5 处资料，请先移除不再使用的关联。');return next;}
export function teachingKnowledgeSourceSaved(source:TeachingKnowledgeSource,saved:readonly TeachingKnowledgeSource[]){return saved.some(value=>teachingKnowledgeSourceKey(value)===teachingKnowledgeSourceKey(source)&&value.binding===source.binding);}
export function teachingKnowledgePreviewLabel(status:TeachingKnowledgePreview['status']){return status==='read'?'本次取得可读资料片段':'本次未找到匹配片段';}
