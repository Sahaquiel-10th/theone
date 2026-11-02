import {TaskWorkflowError,validateWorkflowSpec,workflowSpecSchema,type WorkflowSpec,type WorkflowStep,type WorkflowTool} from './taskWorkflow.js';
import {coordinatorPositiveRequest} from './executionIntent.js';
import {explicitlyNeedsPublicSearch} from './publicSearch.js';

/** A validated public-query step is explicit routing intent even when the
 * handoff uses different search wording. This is never a permission grant:
 * admission and execution still check the user's grant, denials and tools. */
export function workflowNeedsPublicSearch(instruction:string,workflow?:WorkflowSpec){
 return explicitlyNeedsPublicSearch(instruction)||workflow?.steps.some(step=>step.kind==='tool'&&step.tool==='web_search')===true;
}

/** A human may permit optional public research in a supplement. This is not
 * tool availability, and quoted/negated text never grants permission. */
export function workflowWebSearchPermission(text:string,previous=false,selected?:boolean){
 const request=coordinatorPositiveRequest(text);
 if(/(?:禁止|不准|不允许|不要|不用|不必|无需|不能|不)(?:再)?(?:联网|上网|公开搜索)/u.test(request))return false;
 const explicit=/(?:可以|允许|同意|准许)(?:在网上|上网|联网)(?:搜索|搜|查询|查)?/u.test(request);
 // The composer defaults false on a later message; the same task's existing
 // grant survives that default. A new explicit denial above revokes it.
 return explicit||explicitlyNeedsPublicSearch(request)||selected===true||previous;
}

/** Opt in to reuse only for a narrow writing clarification. New/unclear
 * material, date or object requests take a fresh authorized read instead. */
export function workflowKnowledgeReadUnchanged(text:string){
 const request=coordinatorPositiveRequest(text);
 if(/笔记|资料|来源|材料|记录|原文|对象|主题|日期|时间|今天|今日|昨天|昨日|前天|明天|上周|本周|这周|上月|本月|最新|最近|20\d{2}[-/.年]|重新(?:查|找|读|搜|检索)|再(?:查|找|读|搜|检索)|改用|更换|换(?:成|个|一|条|份)|另(?:一|份|条)/u.test(request))return false;
 return /案例|例子|写法|语气|篇幅|结构|格式|结尾|开头|论证/u.test(request);
}

/** Advertise only reads that this round can really authorize. Admission still
 * validates the chosen executor/target afresh; a schema is never a grant. */
export function workflowSchemaForTools(available:readonly string[]){
 const schema=structuredClone(workflowSpecSchema),properties=schema.properties.steps.items.properties;
 const tools=properties.tool.enum.filter(tool=>available.includes(tool));
 if(tools.length)properties.tool.enum=tools;
 else{
  properties.kind.enum=properties.kind.enum.filter(kind=>kind!=='tool');
  delete (properties as Partial<typeof properties>).tool;
 }
 return schema;
}

export type ResolveTaskWorkflowInput={
 explicit?:WorkflowSpec;requiredKnowledge:boolean;readOnlyNotion:boolean;notion:boolean;
 features:{id:string;name:string}[];requiredFeatureIds:string[];instruction:string;
 tools:string[];executorIds:string[];requiredTools?:string[];
 /** Same authorized topic on a supplement; never a public-search fallback. */
 knowledgeQuery?:string;
 /** Server-resolved exact existing message only. Never accepted from the
  * dispatch schema, and never proof that its original writing task finished. */
 existingArtifact?:{id:string};
};
export type WorkflowPlanningReason='scope'|'feature'|'tool'|'executor'|'required_feature'|'required_tool'|'source_dependency'|'notion'|'notion_input'|'readonly'|'ambiguous'|'public_query';
/** Private admission error; no task, model or external operation is started by
 * this resolver. Callers may map it to a plain next step before spending. */
export class WorkflowPlanningError extends TaskWorkflowError{
 constructor(readonly reason:WorkflowPlanningReason,message:string){super('WORKFLOW_INVALID',message);this.name='WorkflowPlanningError';}
}
const readTools:WorkflowTool[]=['knowledge_search','web_search','read_notion_document'];
// Only a reviewed terminal conversion recipe is inferred after a save. A name
// containing "网页" is not proof that an arbitrary uploaded feature is one.
const terminalHtmlFeatures=new Set(['one-visual-html','oneHtml']);
const fail=(reason:WorkflowPlanningReason,message:string):never=>{throw new WorkflowPlanningError(reason,message);};
function names(values:unknown):values is string[]{return Array.isArray(values)&&values.every(value=>typeof value==='string'&&Boolean(value.trim()));}
function sourceRequirements(input:ResolveTaskWorkflowInput){
 return [...new Set([...(input.requiredKnowledge?['knowledge_search']:[]),...(input.readOnlyNotion?['read_notion_document']:[]),...(input.requiredTools??[]).filter(name=>readTools.includes(name as WorkflowTool))])] as WorkflowTool[];
}
function preflight(input:ResolveTaskWorkflowInput,spec:WorkflowSpec){
 const selected=new Set(input.features.map(feature=>feature.id)),availableTools=new Set(input.tools),executors=new Set(input.executorIds),requiredSources=sourceRequirements(input);
 const ancestors=new Map<string,Set<string>>();
 for(const step of spec.steps){
  const prior=new Set<string>();for(const id of step.inputs){prior.add(id);for(const ancestor of ancestors.get(id)??[])prior.add(ancestor);}ancestors.set(step.id,prior);
  if(step.kind==='feature'&&!selected.has(step.featureId!))fail('feature','流程含未选择或未开放的功能，尚未执行。思考、构思案例和写正文使用 model 步骤，不需要另找功能；真实文件交付才选择已授权功能。');
  if(step.kind==='tool'&&step.required!==false&&!availableTools.has(step.tool!))fail('tool','流程需要的必需读取工具本轮没有开放，尚未执行。可选公开检索不能当作必需功能；请调整计划或恢复真正必需的读取能力。');
  if(step.kind==='model'&&(step.executorId!==undefined&&!executors.has(step.executorId)||!executors.size))fail('executor','流程指定的执行模型尚未就位，尚未执行。请重新选择可用模型。');
  if(step.kind==='notion'){
   if(input.readOnlyNotion)fail('readonly','本轮只允许读取 Notion，流程不能保存或修改原文。请去掉写入步骤。');
   if(!input.notion||!availableTools.has('save_notion_draft'))fail('notion','本轮没有可用的 Notion 保存目标或写入能力，尚未执行。请先选好保存位置。');
   if(!input.existingArtifact&&!step.inputs.some(id=>spec.steps.some(source=>source.id===id&&['model','feature'].includes(source.kind))))fail('notion_input','保存步骤没有直接取得可用的完整正文，尚未执行。请先生成正文，再把实际成果交给保存步骤。');
  }
 }
 for(const id of input.requiredFeatureIds)if(!spec.steps.some(step=>step.kind==='feature'&&step.featureId===id&&step.required!==false))fail('required_feature','流程遗漏了必须交付的功能，尚未执行。请补齐必需步骤。');
 const requiredWrite=!input.readOnlyNotion&&input.notion||(input.requiredTools??[]).includes('save_notion_draft');
 if(input.readOnlyNotion&&(input.requiredTools??[]).includes('save_notion_draft'))fail('readonly','本轮只允许读取 Notion，不能同时要求保存或修改原文。');
 if(requiredWrite&&!spec.steps.some(step=>step.kind==='notion'&&step.required!==false))fail('required_tool','流程遗漏了必须完成的 Notion 保存，尚未执行。请补上保存步骤。');
 for(const tool of requiredSources){
  const sources=spec.steps.filter(step=>step.kind==='tool'&&step.tool===tool&&step.required!==false);
  if(!sources.length)fail('required_tool','流程遗漏了必须完成的资料读取，尚未执行。请补齐来源步骤。');
  for(const step of spec.steps.filter(step=>step.required!==false&&['model','feature','notion'].includes(step.kind)))if(!sources.some(source=>ancestors.get(step.id)?.has(source.id)))fail('source_dependency','后续制作或保存步骤没有依赖必须读取的实际资料，尚未执行。请先读取，再把结果交给后续步骤。');
 }
 // A feature's internal lower-level tools are checked by that feature's own
 // reviewed runner. They cannot be silently dropped in a feature-free plan.
 const internal=(input.requiredTools??[]).filter(name=>name!=='save_notion_draft'&&!readTools.includes(name as WorkflowTool));
 if(internal.length&&!spec.steps.some(step=>step.kind==='feature'&&step.required!==false))fail('required_tool','流程包含尚未归属已选功能的必需工具，尚未执行。请明确负责交付的功能步骤。');
 return spec;
}

/** A tiny reviewed recipe fallback, not a second free-form planner. Full user
 * instruction remains the owning job's goal/context; never clip it or repeat
 * it into every step. Unknown multi-feature order requires an explicit plan. */
export function resolveTaskWorkflow(input:ResolveTaskWorkflowInput):WorkflowSpec|undefined{
 if(input?.knowledgeQuery!==undefined&&(typeof input.knowledgeQuery!=='string'||!input.knowledgeQuery.trim()||input.knowledgeQuery.length>4000))fail('scope','原资料检索条件无法确认，尚未执行。');
 if(!input||typeof input.requiredKnowledge!=='boolean'||typeof input.readOnlyNotion!=='boolean'||typeof input.notion!=='boolean'||typeof input.instruction!=='string'||!input.instruction.trim()||!Array.isArray(input.features)||input.features.some(feature=>!feature||typeof feature.id!=='string'||!feature.id.trim()||typeof feature.name!=='string'||!feature.name.trim())||new Set(input.features.map(feature=>feature.id)).size!==input.features.length||!names(input.requiredFeatureIds)||!names(input.tools)||!names(input.executorIds)||input.requiredTools!==undefined&&!names(input.requiredTools))fail('scope','任务流程的可用能力或完整目标未确认，尚未执行。');
 const featureIds=new Set(input.features.map(feature=>feature.id));
 if(input.requiredFeatureIds.some(id=>!featureIds.has(id)))fail('required_feature','必需功能没有被选中或已经不可用，尚未执行。请重新选择。');
 if(input.existingArtifact!==undefined){
  if(!input.existingArtifact||Object.keys(input.existingArtifact).join()!=='id'||typeof input.existingArtifact.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,99}$/.test(input.existingArtifact.id))fail('scope','待保存原文尚未绑定，请先明确要保存哪一篇。');
  if(input.readOnlyNotion)fail('readonly','本轮只允许读取 Notion，不能保存现有正文。');
  if(input.requiredKnowledge||input.requiredFeatureIds.length||(input.requiredTools??[]).some(name=>name!=='save_notion_draft'))fail('ambiguous','本轮不只是保存现有正文，请先明确额外制作或资料读取的安排。');
  // The exact body is held by the server-owned attempt, not copied into a
  // model prompt or the public workflow schema. Saving it requires no model.
  return preflight(input,validateWorkflowSpec({version:1,steps:[{id:'save_existing',title:'保存现有正文到 Notion',kind:'notion',instruction:'将用户明确选中的现有正文原样保存到本任务已确认的 Notion 目标并回读核对；不重新创作，不据此改变原写作任务的完成情况。',inputs:[],required:true,historyCount:0}]}));
 }
 if(input.explicit!==undefined)return preflight(input,validateWorkflowSpec(input.explicit));
 if(input.readOnlyNotion&&(input.requiredTools??[]).includes('save_notion_draft'))fail('readonly','本轮只允许读取 Notion，不能同时要求保存或修改原文。');
 if((input.requiredTools??[]).includes('save_notion_draft')&&!input.notion)fail('notion','本轮没有已确认的 Notion 保存目标，尚未执行。');
 const features=[...new Set(input.requiredFeatureIds)];
 if(features.length>1)fail('ambiguous','多个功能的先后关系尚未明确，尚未执行。请先提供明确的步骤安排。');
 const write=input.notion&&!input.readOnlyNotion;
 if(write&&features.length&&!terminalHtmlFeatures.has(features[0]))fail('ambiguous','保存与这个功能的先后关系尚未明确，尚未执行。请先明确哪些成果先生成、哪些后保存。');
 const sources=sourceRequirements(input);
 if(sources.includes('web_search'))fail('public_query','本轮需要明确的公开搜索关键词，尚未执行。请在显式流程中填写搜索词，不把完整私人任务发到公开搜索。');
 // Preserve the established single-model and single-feature short path.
 if(!sources.length&&!write){
  if((input.requiredTools??[]).some(name=>!readTools.includes(name as WorkflowTool)&&name!=='save_notion_draft')&&!features.length)fail('required_tool','必需工具尚未归属明确的功能，尚未执行。');
  return undefined;
 }
 const steps:WorkflowStep[]=sources.map((source,index)=>({id:'source_'+(index+1),title:source==='knowledge_search'?'查找任务资料':'读取现有原文',kind:'tool',tool:source,instruction:source==='knowledge_search'?(input.knowledgeQuery??input.instruction):'实际读取本任务已绑定的 Notion 原文，保留全文与原页入口；不要修改。',inputs:[],required:true,historyCount:0}));
 const sourceIds=steps.map(step=>step.id);
 if(write||!features.length)steps.push({id:'draft',title:'整理完整成果',kind:'model',instruction:'依据完整任务目标、全部约束及前置真实资料，形成可直接交付的完整正文；不要把中间片段当成终稿。',inputs:sourceIds,required:true,historyCount:0});
 if(write)steps.push({id:'save',title:'保存到原定位置',kind:'notion',instruction:'使用前置完整正文，保存到本任务已确认的 Notion 目标并回读核对；沿用已绑定原页，不重复新建。',inputs:['draft'],required:true,historyCount:0});
 if(features.length)steps.push({id:'feature',title:write?'制作交互网页':'完成已选功能',kind:'feature',featureId:features[0],instruction:write?'依据前置完整正文及已确认的原稿入口制作网页，完成原目标要求的交付；不改写或截短前置正文。':'依据完整任务目标、全部约束及前置真实资料，使用本功能完成指定成果。',inputs:write?['draft','save']:sourceIds,required:true,historyCount:0});
 return preflight(input,validateWorkflowSpec({version:1,steps}));
}
