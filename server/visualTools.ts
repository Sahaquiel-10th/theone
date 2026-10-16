import type {OrchestrationTool} from './taskOrchestrator.js';
import {visualDocumentSchema,validateVisualDocument,renderVisualDiagram,renderVisualPage,type VisualDocument} from './visualDocument.js';
export const visualToolPresets=[
  {id:'oneFlowchart',name:'完整流程图',description:'当步骤、分工、资料流向或几个场景需要一张图讲清楚时使用。输入结构化说明，生成可缩放的私有 SVG 全图；不是只有图片提示词。'},
  {id:'oneHtml',name:'交互说明网页',description:'适用于使用说明、攻略、方案导览、学习指南等需要浏览与比较的交付。先整理不同场景，再生成可切换场景、展开步骤、查看全图的私有 HTML 文件。不要为一句简单回答生成网页。'}
];
export type SaveVisual=(doc:VisualDocument,format:'html'|'svg')=>Promise<{id:string;name:string}>;
/** Shared function implementation. Onboarding and normal features use the same renderer. */
export async function createVisualArtifact(doc:VisualDocument,format:'html'|'svg',save:(name:string,bytes:Buffer,mime:string,doc:VisualDocument)=>Promise<{id:string;name:string}>){
  const valid=validateVisualDocument(doc),html=format==='html';
  return save(valid.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'').slice(0,90)+(html?'.html':'.svg'),Buffer.from(html?renderVisualPage(valid):renderVisualDiagram(valid)),html?'text/html':'image/svg+xml',valid);
}
export function visualTool(id:string,description:string,verify:()=>Promise<void>,save?:SaveVisual):OrchestrationTool{
  if(!visualToolPresets.some(x=>x.id===id))throw new Error('未知的视觉工具');
  return {name:id,description,run:async()=>{throw new Error('请提供完整的结构化说明');},structured:{schema:visualDocumentSchema,validate:validateVisualDocument,run:async raw=>{
    await verify();if(!save)throw new Error('网页与流程图存储暂时不可用');const file=await save(validateVisualDocument(raw),id==='oneHtml'?'html':'svg');await verify();
    return {status:'completed',file,format:id==='oneHtml'?'html':'svg',message:'已生成私有成果文件，可以查看或下载；未公开发布。'};
  }}};
}
