import type {CapabilityCard} from './capabilityCatalog.js';
import {isImageInstruction,type PlannedTask} from './dispatchPlan.js';
import {OrchestrationInputError} from './taskOrchestrator.js';

/** Resolve only exact entries from the caller's fresh authorized catalog. Never strip arbitrary prefixes. */
export function resolveDispatchCapabilities(task:PlannedTask,cards:CapabilityCard[],directFeature?:(id:string)=>string|undefined):PlannedTask{
  const result={...task,featureIds:[] as string[]};
  // These bindings are derived here, never trusted from an incoming task.
  delete result.knowledgeSourceIds;
  const ids=[...new Set([...(task.capabilityIds??[]),...task.featureIds])];
  let image=false,local=false,referenceRead=false;
  for(const id of ids){
    const card=cards.find(c=>c.available&&(c.id===id||c.kind==='feature'&&c.featureId===id));
    // Reviewed deterministic renderers need no feature model. Their caller must
    // independently authorize the exact release and matching renderer first.
    if(!card&&task.direct&&directFeature){const featureId=directFeature(id);if(featureId){result.featureIds.push(featureId);continue;}}
    if(!card)throw new OrchestrationInputError('所选能力当前不在授权目录中。请重新查找能力，选择返回的真实编号；不要猜编号或扩大权限。');
    if(card.kind==='knowledge'){
      if(!card.sourceId||card.id!==`knowledge:${card.sourceId}`||card.executorId||card.featureId||card.readOnlyTool||!card.tools.includes('knowledge_search'))throw new OrchestrationInputError('知识来源卡片不完整，请重新查找当前授权的知识来源。');
      if(task.knowledge==='none'||task.direct)throw new OrchestrationInputError('知识来源选择与这项任务的只用已有材料或直接生成要求冲突，请核对后重新安排。');
      result.knowledgeSourceIds=[...new Set([...(result.knowledgeSourceIds??[]),card.sourceId])];
      result.requiredTools=[...new Set([...(result.requiredTools??[]),'knowledge_search'])];
      referenceRead=true;
    }else if(card.readOnlyTool){
      if(card.kind!=='builtin'||card.id!=='builtin:public_web_search'||card.readOnlyTool!=='web_search'||!card.tools.includes(card.readOnlyTool)||card.executorId||card.featureId||task.direct)throw new OrchestrationInputError('查询能力不能当作执行模型或直接生成步骤，请核对任务安排。');
      result.requiredTools=[...new Set([...(result.requiredTools??[]),card.readOnlyTool])];
      referenceRead=true;
    }else if(card.kind==='feature'&&card.featureId)result.featureIds.push(card.featureId);
    else if(card.executorId==='image_generation')image=true;
    else if(card.executorId==='local_special')local=true;
    else if(card.kind==='executor'&&card.executorId){
      if(task.executorId!=='general'&&task.executorId!==card.executorId&&task.executorId!==card.id)throw new OrchestrationInputError('执行模型选择冲突，请为这一项任务只选择一个执行模型。');
      result.executorId=card.executorId;
    }else throw new OrchestrationInputError('这个能力不是可直接分派的功能。知识检索请使用 knowledge_search 或任务的 knowledge 字段；固定流程只能从其指定入口启动。');
  }
  const executor=cards.find(c=>c.available&&(c.id===result.executorId||c.executorId===result.executorId));
  if(executor?.executorId)result.executorId=executor.executorId;
  if(image&&local)throw new OrchestrationInputError('图片生成与本机操作应分成两项任务，真正依赖前一项时填写 dependsOn。');
  if(image){
    if(result.featureIds.some(id=>cards.find(c=>c.featureId===id)?.mode!=='image'))throw new OrchestrationInputError('请先安排图片任务，再安排依赖该图片的网页任务；网页的 dependsOn 指向图片任务，不要用占位图冒充成品。');
    result.executorId='image_generation';result.outputKind='image';
  }
  if(local){result.executorId='local_special';result.outputKind='local_file';}
  const imageHandoff=result.outputKind==='image'||result.executorId==='image_generation'||isImageInstruction(result.title)&&!result.featureIds.some(id=>cards.some(card=>card.featureId===id&&card.mode==='image'));
  if(referenceRead&&(imageHandoff||result.outputKind==='local_file'||result.executorId==='local_special'))throw new OrchestrationInputError('图片或本机的专用执行入口不能同时完成这些资料读取。请先单独读取所选知识或公开资料，拿到真实素材后，再明确交接给图片或本机任务；本次尚未开始执行。');
  result.featureIds=[...new Set(result.featureIds)];
  return result;
}

/** Make the callable form explicit next to discovery metadata, not hidden in a distant prompt. */
export function callableCapabilities(cards:CapabilityCard[]){
  return cards.map(card=>({...card,invocation:card.readOnlyTool?{tool:card.readOnlyTool}:card.kind==='feature'?{capabilityIds:[card.id],featureIds:[card.featureId],outputKind:card.mode==='image'?'image':'text'}:card.executorId?{capabilityIds:[card.id],executorId:card.executorId,featureIds:[],outputKind:card.mode==='image'?'image':card.mode==='local'?'local_file':'text'}:{tool:'knowledge_search',sourceId:card.sourceId}}));
}
