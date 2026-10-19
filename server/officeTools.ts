import {slideFiles,validateDeck,type SlideDeck} from './officeSlides.js';
import {createWorkbook,fillWorkbook,reconcileWorkbook,analyzeWorkbook,inspectWorkbook} from './officeWorkbook.js';
import {createWord} from './officeDocument.js';
import {obj,type OfficeFile} from './officeXml.js';
import {artifactResultLinks} from './artifactLinks.js';
import type {OrchestrationTool} from './taskOrchestrator.js';
export const officeToolPresets=[
 {id:'oneSlides',name:'演示稿制作与导出',description:'用结构化页面生成可离线播放的HTML和可编辑PPTX。支持翻页、全屏、备注、一键导出HTML/PPTX，打印存为PDF。不能执行任意HTML脚本。'},
 {id:'oneWorkbook',name:'办公表格生成与处理',description:'创建带公式/下拉选项的XLSX，按指定单元格填写授权模板，按明确匹配列对账，或按列统计并生成原生Excel图表。只读取当前授权文件。'},
 {id:'oneDocument',name:'正式Word文档生成',description:'将结构化章节与表格生成有目录、标题样式、A4版式和页码的可编辑DOCX，不输出伪装的HTML或Markdown。'}
];
export type OfficeContext={saveOffice?:(file:OfficeFile)=>Promise<{id:string;name:string}>;readOffice?:(id:string)=>Promise<Buffer>;readSlides?:(id:string)=>Promise<SlideDeck>;readTable?:(id:string)=>Promise<string>};
export const workbookFormulaGuidance='本工具实际支持本工作簿引用、四则运算和 SUM/AVERAGE/MIN/MAX/ROUND/ROUNDUP。需要整数保本人数时可用 ROUNDUP(120/(50-15),0)，结果为4；不能把已支持的公式误说成不支持或替换为待定。其他函数与外部引用不支持。';
export function officeTool(id:string,description:string,verify:()=>Promise<void>,context:OfficeContext):OrchestrationTool{
 const operations=id==='oneSlides'?['create','inspect','revise']:id==='oneDocument'?['create']:['create','inspect','fill','reconcile','analyze'];
 return {name:id,description:description+(id==='oneWorkbook'?'\n'+workbookFormulaGuidance:''),label:officeToolPresets.find(p=>p.id===id)!.name,effect:'artifact',run:async()=>{throw new Error('请提供结构化参数');},structured:{schema:{type:'object',additionalProperties:false,properties:{operation:{type:'string',enum:operations},dataJson:{type:'string',maxLength:120000}},required:['operation','dataJson']},validate:raw=>{const d=obj(raw,['operation','dataJson']);if(!operations.includes(d.operation)||typeof d.dataJson!=='string'||d.dataJson.length>120000)throw new Error('办公工具参数无效');JSON.parse(d.dataJson);return d;},run:async raw=>{
  await verify();if(!context.saveOffice)throw new Error('办公成果存储尚未配置');const d=raw as {operation:string;dataJson:string};if(!operations.includes(d.operation)||typeof d.dataJson!=='string'||d.dataJson.length>120000)throw new Error('办公工具参数无效');const payload=JSON.parse(d.dataJson);let files:OfficeFile[],summary:unknown;
  if(id==='oneWorkbook'&&d.operation==='inspect'){const p=obj(payload,['attachmentId']);if(typeof p.attachmentId!=='string'||!context.readOffice)throw new Error('需要本次选中的模板');const r=await inspectWorkbook(await context.readOffice(p.attachmentId));await verify();return r;}
  if(id==='oneSlides'){
   if(d.operation==='create'){validateDeck(payload);files=await slideFiles(payload);}
   else {const p=obj(payload,d.operation==='inspect'?['attachmentId']:['attachmentId','changes']);if(typeof p.attachmentId!=='string'||!context.readSlides)throw new Error('需要本次授权的上一版演示稿');const deck=await context.readSlides(p.attachmentId);await verify();if(d.operation==='inspect')return {deck,scope:'已授权的上一版完整内容'};
    if(!Array.isArray(p.changes)||!p.changes.length||p.changes.length>deck.slides.length)throw new Error('请提供指定页的修改');const seen=new Set<number>();for(const item of p.changes){const c=obj(item,['page','slide']);if(!Number.isInteger(c.page)||c.page<1||c.page>deck.slides.length||seen.has(c.page))throw new Error('修改页码无效或重复');seen.add(c.page);deck.slides[c.page-1]=c.slide;}files=await slideFiles(deck);summary={updatedPages:[...seen],unchangedPages:deck.slides.length-seen.size};
   }
  }
  else if(id==='oneDocument')files=[await createWord(payload)];
  else if(d.operation==='create')files=[await createWorkbook(payload)];
  else if(d.operation==='fill'){const p=obj(payload,['attachmentId','title','updates']);if(typeof p.attachmentId!=='string'||!context.readOffice)throw new Error('需要本次选中的XLSX模板');files=[await fillWorkbook(await context.readOffice(p.attachmentId),{title:p.title,updates:p.updates})];summary={updatedCells:p.updates.length,recalculateOnOpen:true};}
  else if(d.operation==='reconcile'){const p=obj(payload,['leftId','rightId','title','leftKeys','rightKeys','leftAmount','rightAmount','tolerance','trim']);if(typeof p.leftId!=='string'||typeof p.rightId!=='string'||p.leftId===p.rightId||!context.readTable)throw new Error('需要两个不同的已选中表格');const {leftId,rightId,...options}=p;const r=await reconcileWorkbook(await context.readTable(leftId),await context.readTable(rightId),options);files=[r.file];summary=r.summary;}
  else {const p=obj(payload,['attachmentId','title','groupBy','valueColumn','aggregation','chartType']);if(typeof p.attachmentId!=='string'||!context.readTable)throw new Error('需要本次选中的表格');const {attachmentId,...options}=p;const r=await analyzeWorkbook(await context.readTable(attachmentId),options);files=[r.file];summary={...r.summary,preview:r.preview};}
  await verify();const saved=[];for(const file of files){await verify();const r=await context.saveOffice(file);saved.push({...r,...artifactResultLinks(r.id)});}await verify();return {status:'completed',files:saved,...(summary?{summary}:{}),message:'已生成真实私有文件。HTML演示稿下载后可离线打开并导出HTML或PowerPoint，PDF使用打印另存。不要把成果说成已公开发布。'};
 }}};
}
