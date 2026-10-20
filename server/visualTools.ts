import {OrchestrationInputError,type OrchestrationTool} from './taskOrchestrator.js';
import {artifactResultLinks} from './artifactLinks.js';
import {visualDocumentSchema,validateVisualDocument,renderVisualDiagram,renderVisualPage,type VisualDocument} from './visualDocument.js';
export const visualToolPresets=[
  {id:'oneFlowchart',name:'完整流程图',description:'当步骤、分工、资料流向或几个场景需要一张图讲清楚时使用。输入结构化说明，生成可缩放的私有 SVG 全图；不是只有图片提示词。'},
  {id:'oneHtml',name:'交互说明网页',description:'适用于使用说明、攻略、方案导览、学习指南等需要浏览与比较的交付。先整理不同场景，再生成可切换场景、展开步骤、查看全图的私有 HTML 文件。不要为一句简单回答生成网页。'}
];
export type SaveVisual=(doc:VisualDocument,format:'html'|'svg')=>Promise<{id:string;name:string}>;
const visualInputGuidance='参数直接传平铺对象：version=1、title(最多100字)、intro(最多300字)、scenes(2–6个)。不要套document/dataJson，不传HTML或SVG代码。每个scene必须有id、title、situation、feature、advantage、benefit、evidence、steps、prompt、capabilityIds；id以英文字母开头且仅含字母数字下划线连字符，每个id唯一。title最多45字，situation/advantage/benefit/evidence最多180字，feature最多160字，steps为2–5个非空字符串且每条最多120字，prompt最多400字，capabilityIds无关联能力时传空数组。先按工具schema修正参数再调用，不要将格式问题说成工具无权限。';
function validateVisualToolInput(raw:unknown){
  try{return validateVisualDocument(raw);}
  catch{throw new OrchestrationInputError(visualInputGuidance);}
}
/** Shared function implementation. Onboarding and normal features use the same renderer. */
export async function createVisualArtifact(doc:VisualDocument,format:'html'|'svg',save:(name:string,bytes:Buffer,mime:string,doc:VisualDocument)=>Promise<{id:string;name:string}>,assets?:{image?:string;context?:import('./welcomeNewspaper.js').NewspaperContext}){
  const valid=validateVisualDocument(doc),html=format==='html';
  return save(valid.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'').slice(0,90)+(html?'.html':'.svg'),Buffer.from(html?renderVisualPage(valid,assets?.image,undefined,assets?.context):renderVisualDiagram(valid)),html?'text/html':'image/svg+xml',valid);
}
export function visualTool(id:string,description:string,verify:()=>Promise<void>,save?:SaveVisual):OrchestrationTool{
  if(!visualToolPresets.some(x=>x.id===id))throw new Error('未知的视觉工具');
  return {name:id,description:description+'\n'+visualInputGuidance,label:id==='oneHtml'?'整理网页':'整理流程图',effect:'artifact',run:async()=>{throw new Error('请提供完整的结构化说明');},structured:{schema:visualDocumentSchema,validate:validateVisualToolInput,run:async raw=>{
    await verify();if(!save)throw new Error('网页与流程图存储暂时不可用');const file=await save(validateVisualDocument(raw),id==='oneHtml'?'html':'svg');await verify();
    return {status:'completed',file:{...file,...artifactResultLinks(file.id,true)},format:id==='oneHtml'?'html':'svg',message:'已生成私有成果文件；查看或下载请使用返回的 openUrl / downloadUrl，不要猜测地址。未公开发布。'};
  }}};
}
