import {slideFiles,validateDeck,type SlideDeck} from './officeSlides.js';
import {createWorkbook,fillWorkbook,reconcileWorkbook,analyzeWorkbook,inspectWorkbook} from './officeWorkbook.js';
import {createWord} from './officeDocument.js';
import {obj,type OfficeFile} from './officeXml.js';
import {artifactResultLinks} from './artifactLinks.js';
import {OrchestrationEffectNotStartedError,reviewedNativeEffectTool,type OrchestrationTool} from './taskOrchestrator.js';
import {systemParameterFault,toolRecoveryMessage,type ToolRecoveryDiagnostic} from './toolRecovery.js';
export const officeToolPresets=[
 {id:'oneSlides',name:'演示稿制作与导出',description:'用结构化页面生成可离线播放的HTML和可编辑PPTX。支持翻页、全屏、备注、一键导出HTML/PPTX，打印存为PDF。不能执行任意HTML脚本。'},
 {id:'oneWorkbook',name:'办公表格生成与处理',description:'创建带公式/下拉选项的XLSX，按指定单元格填写授权模板，按明确匹配列对账，或按列统计并生成原生Excel图表。只读取当前授权文件。'},
 {id:'oneDocument',name:'正式Word文档生成',description:'将结构化章节与表格生成有目录、标题样式、A4版式和页码的可编辑DOCX，不输出伪装的HTML或Markdown。'}
];
export type OfficeTemplateSelection={state:'none'}|{state:'one';id:string}|{state:'ambiguous'};
export type OfficeContext={requiresXlsxTemplate?:boolean;resolveOfficeTemplate?:(kind:'workbook'|'slides'|'table')=>Promise<OfficeTemplateSelection>;saveOffice?:(file:OfficeFile)=>Promise<{id:string;name:string}>;readOffice?:(id:string)=>Promise<Buffer>;readSlides?:(id:string)=>Promise<SlideDeck>;readTable?:(id:string)=>Promise<string>};
/** This classification receives only code-bound human requests or explicit
 * published input constraints, never a model's chosen operation/query. Newer
 * explicit changes override the older requirement; an ordinary 'continue'
 * keeps the already-stated requirement. It grants no attachment access. */
export function requiresXlsxTemplate(humanRequests:readonly string[]){
 for(const raw of [...humanRequests].reverse()){
  const text=raw.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'').replace(/^\s*>.*$/gm,'').replace(/“[^”]*”|「[^」]*」|"[^"\n]*"|'[^'\n]*'/g,quoted=>/\.xlsx[’'"”」]?$/i.test(quoted)?quoted:'').trim();
  if(!text)continue;
  if(/(?:不要|不需要|不用|无需|不使用|不得|禁止|不能)[^。；，,\n]{0,12}(?:xlsx|excel)/i.test(text))return false;
  const imageTemplate=/(?:图片|截图|照片).{0,10}(?:模[板版]|重建)|(?:按|照着|根据).{0,8}(?:图片|截图|照片)/.test(text);
  const definiteExistingXlsx=/(?:原始|现有|已有|已上传|上传的|原来的).{0,8}(?:xlsx|excel)|[^\s]+\.xlsx\b/i.test(text);
  if(imageTemplate&&!definiteExistingXlsx)return false;
  const explicit=/(?:填写|填入|填充|更新|修改|编辑|沿用|套用).{0,30}(?:xlsx|excel)(?:.{0,8}(?:模板|文件|表格))?|(?:xlsx|excel).{0,8}模板.{0,20}(?:填|更新|修改|编辑)|(?:按|用|根据|照着).{0,10}(?:xlsx|excel).{0,4}模板.{0,12}(?:填|更新|修改|编辑)/i.test(text);
  if(explicit&&!/(?:如果|假如|例如|比如|举例|假设).{0,20}(?:填写|修改|模板)/.test(text))return true;
  if(imageTemplate)return false;
 }
 return false;
}
const reviewedOfficeCallbacks=new WeakSet<Function>();
/** Mark only callbacks from our owned-attachment/artifact adapter. Function
 * identity survives adding other local tools through a context object spread. */
export function reviewedOfficeArtifactContext<T extends OfficeContext>(context:T):T{for(const key of ['resolveOfficeTemplate','saveOffice','readOffice','readSlides','readTable'] as const){const callback=context[key];if(callback)reviewedOfficeCallbacks.add(callback);}return context;}
const reviewedContext=(context:OfficeContext)=>(['resolveOfficeTemplate','saveOffice','readOffice','readSlides','readTable'] as const).every(key=>!context[key]||reviewedOfficeCallbacks.has(context[key]!));
export const workbookFormulaGuidance='create 的 dataJson 结构为 {title,sheets:[{name,headers,rows,formulas:[{cell,formula}]}]}。headers 占 Excel 第1行，rows[0] 对应第2行，空白分隔行也占行；公式使用 Excel 地址，不是 rows 的数组索引。公式目标在 rows 中留 null。先按行列映射逐一核对全部请求情形，尤其最后一行，不要把公式写到空白分隔行而漏掉末行。创建返回实际文件回读预览，必须核对请求情形的值与公式再宣告完成；预览截断不代表未展示的内容已核对。本工具实际支持本工作簿引用、四则运算和 SUM/AVERAGE/MIN/MAX/ROUND/ROUNDUP。需要整数保本人数时可用 ROUNDUP(120/(50-15),0)，结果为4；不能把已支持的公式误说成不支持或替换为待定。其他函数与外部引用不支持。';
const reasonOf=(error:unknown)=>error instanceof Error?error.message:'';
function officePreparationHint(id:string,error:unknown){
 const reason=error instanceof Error?error.message:'';
 // Fixed native hints only: filesystem/reader errors can contain private paths.
 if(reason==='办公成果存储尚未配置')return '本次文件还没保存：成果保存位置尚未配置，请联系管理员恢复文件存储，再生成这一份文件。';
 if(id==='oneWorkbook'){
  if(reason==='需要1–40个不同列名')return '本次表格还没保存：请提供1–40个不重复且非空的列名，再生成这一份表格。';
  if(reason==='行与表头列数不一致')return '本次表格还没保存：每一行的单元格数量必须与列名数量一致，缺少的值用 null 补齐后再生成。';
  if(/公式|单元格/.test(reason))return '本次表格还没保存：请核对数据行与单元格地址，公式目标留空；仅使用本工作簿引用、四则运算及 SUM/AVERAGE/MIN/MAX/ROUND/ROUNDUP，再生成这一份表格。';
  if(/模板|附件|选中/.test(reason))return '本次表格还没保存：请重新选择这次获准使用的标准 XLSX 模板，并明确要填写的工作表和单元格，再继续生成。';
  return '本次表格还没保存：请核对标题、工作表名称、列名和各行数据；使用支持的结构与公式后，只重新生成这一份表格。';
 }
 return id==='oneSlides'?'本次演示文件还没保存：请核对每页标题、版式和内容字段，或重新选择获准修改的上一版，再生成这一份演示稿。':'本次文档还没保存：请补齐标题和章节，核对段落及表格结构后，再生成这一份文档。';
}
export function officeTool(id:string,description:string,verify:()=>Promise<void>,context:OfficeContext):OrchestrationTool{
 const operations=id==='oneSlides'?['create','inspect','revise']:id==='oneDocument'?['create']:['create','inspect','fill','reconcile','analyze'];
 const tool:OrchestrationTool={name:id,description:description+(id==='oneWorkbook'?'\n'+workbookFormulaGuidance:''),label:officeToolPresets.find(p=>p.id===id)!.name,effect:'artifact',run:async()=>{throw new Error('请提供结构化参数');},structured:{effect:raw=>(raw as {operation:string}).operation==='inspect'?'read':'artifact',schema:{type:'object',additionalProperties:false,properties:{operation:{type:'string',enum:operations},dataJson:{type:'string',maxLength:120000}},required:['operation','dataJson']},validate:raw=>{const d=obj(raw,['operation','dataJson']);if(!operations.includes(d.operation)||typeof d.dataJson!=='string'||d.dataJson.length>120000)throw new Error('办公工具参数无效');JSON.parse(d.dataJson);return d;},run:async(raw,invocation)=>{
  await verify();
  const configuration:ToolRecoveryDiagnostic={version:1,kind:'configuration',code:'storage_unconfigured',repair:'not_applicable'};
  if(!context.saveOffice&&(raw as {operation?:unknown}).operation!=='inspect')throw invocation?.rejectBeforeEffect(toolRecoveryMessage(configuration),configuration)??new OrchestrationEffectNotStartedError(toolRecoveryMessage(configuration),configuration);
  const templateId=async(value:unknown,kind:'workbook'|'slides'|'table')=>{
   if(typeof value==='string'&&value.trim())return value;
   if(!context.resolveOfficeTemplate)throw new Error(kind==='slides'?'需要本次授权的上一版演示稿':'需要本次选中的XLSX模板');
   const selected=await context.resolveOfficeTemplate(kind);await verify();
   if(selected.state==='one')return selected.id;
   if(kind!=='workbook'||context.requiresXlsxTemplate!==true){
    const diagnostic=systemParameterFault('arguments_invalid','available',['operation','dataJson.attachmentId']);
    const hint='当前没有唯一已选的原始模板，不能猜附件编号。若本轮是新建文件或按图片模板重建，请改用 create 并传完整结构化内容；不要把模型选错处理方式变成向用户索取 XLSX 模板。只有代码确认用户要求填写原 XLSX 时才需要该模板。';
    throw invocation?.rejectBeforeEffect(hint,diagnostic)??new OrchestrationEffectNotStartedError(hint,diagnostic);
   }
   const diagnostic:ToolRecoveryDiagnostic={version:1,kind:'missing_input',code:selected.state==='none'?'template_required':'template_ambiguous',repair:'not_applicable',field:'template_file'};
   throw invocation?.rejectBeforeEffect(toolRecoveryMessage(diagnostic),diagnostic)??new OrchestrationEffectNotStartedError(toolRecoveryMessage(diagnostic),diagnostic);
  };
  // Only pure validation and in-memory generation can prove that no saver was
  // entered. Keep authorization, attachment readers and savers outside this
  // boundary: their failures must abort, never buy an argument-repair turn.
  const prepare=async<T>(work:()=>T|Promise<T>):Promise<T>=>{try{return await work();}catch(error){await verify();if(error instanceof OrchestrationEffectNotStartedError)throw error;const message=officePreparationHint(id,error);const diagnostic=systemParameterFault('artifact_validation_failed','available',id==='oneWorkbook'&&reasonOf(error)==='行与表头列数不一致'?['sheets.rows']:undefined);throw invocation?.rejectBeforeEffect(message,diagnostic)??new OrchestrationEffectNotStartedError(message,diagnostic);}};
  const d=raw as {operation:string;dataJson:string};
  const payload=await prepare(()=>{if(!operations.includes(d.operation)||typeof d.dataJson!=='string'||d.dataJson.length>120000)throw new Error('办公工具参数无效');return JSON.parse(d.dataJson);});
  let files:OfficeFile[],summary:unknown;
  if(id==='oneWorkbook'&&d.operation==='inspect'){const p=await prepare(()=>{const p=obj(payload,['attachmentId']);return p;});p.attachmentId=await templateId(p.attachmentId,'workbook');if(!context.readOffice)throw new Error('需要本次选中的模板');const bytes=await context.readOffice(p.attachmentId);await verify();const result=await inspectWorkbook(bytes);await verify();return result;}
  if(id==='oneSlides'){
   if(d.operation==='create')files=await prepare(async()=>{validateDeck(payload);return slideFiles(payload);});
   else {const p=await prepare(()=>{const p=obj(payload,d.operation==='inspect'?['attachmentId']:['attachmentId','changes']);return p;});p.attachmentId=await templateId(p.attachmentId,'slides');if(!context.readSlides)throw new Error('需要本次授权的上一版演示稿');const deck=await context.readSlides(p.attachmentId);await verify();if(d.operation==='inspect')return {deck,scope:'已授权的上一版完整内容'};
    const prepared=await prepare(async()=>{if(!Array.isArray(p.changes)||!p.changes.length||p.changes.length>deck.slides.length)throw new Error('请提供指定页的修改');const seen=new Set<number>();for(const item of p.changes){const c=obj(item,['page','slide']);if(!Number.isInteger(c.page)||c.page<1||c.page>deck.slides.length||seen.has(c.page))throw new Error('修改页码无效或重复');seen.add(c.page);deck.slides[c.page-1]=c.slide;}return{files:await slideFiles(deck),summary:{updatedPages:[...seen],unchangedPages:deck.slides.length-seen.size}};});files=prepared.files;summary=prepared.summary;
   }
  }
  else if(id==='oneDocument')files=[await prepare(()=>createWord(payload))];
  else if(d.operation==='create'){
   files=[await prepare(()=>createWorkbook(payload))];
   // Return evidence from the actual XLSX, not a model's claimed cell layout.
   // Keep this bounded and scoped to the file just created; no existing file reads.
   const checked=await prepare(()=>inspectWorkbook(files[0].bytes));let remaining=120;
   summary={previewOnly:true,message:'刚生成文件的实际回读预览。请核对每个请求情形的值和公式；文件生成不代表内容已完整。',sheets:checked.sheets.map(sheet=>{const exhausted=remaining===0,cells=sheet.cells.slice(0,remaining);remaining-=cells.length;return {...sheet,cells,truncated:exhausted&&Boolean(sheet.range)||cells.length<sheet.cells.length};})};
  }
  else if(d.operation==='fill'){const p=await prepare(()=>{const p=obj(payload,['attachmentId','title','updates']);return p;});p.attachmentId=await templateId(p.attachmentId,'workbook');if(!context.readOffice)throw new Error('需要本次选中的XLSX模板');const bytes=await context.readOffice(p.attachmentId);await verify();files=[await prepare(()=>fillWorkbook(bytes,{title:p.title,updates:p.updates}))];summary={updatedCells:p.updates.length,recalculateOnOpen:true};}
  else if(d.operation==='reconcile'){const p=await prepare(()=>{const p=obj(payload,['leftId','rightId','title','leftKeys','rightKeys','leftAmount','rightAmount','tolerance','trim']);if(typeof p.leftId!=='string'||typeof p.rightId!=='string'||p.leftId===p.rightId)throw new Error('需要两个不同的已选中表格');return p;});if(!context.readTable)throw new Error('需要两个不同的已选中表格');const {leftId,rightId,...options}=p;const left=await context.readTable(leftId);await verify();const right=await context.readTable(rightId);await verify();const r=await prepare(()=>reconcileWorkbook(left,right,options));files=[r.file];summary=r.summary;}
  else {const p=await prepare(()=>{const p=obj(payload,['attachmentId','title','groupBy','valueColumn','aggregation','chartType']);return p;});p.attachmentId=await templateId(p.attachmentId,'table');if(!context.readTable)throw new Error('需要本次选中的表格');const {attachmentId,...options}=p;const csv=await context.readTable(attachmentId);await verify();const r=await prepare(()=>analyzeWorkbook(csv,options));files=[r.file];summary={...r.summary,preview:r.preview};}
  await verify();const saved=[];for(const file of files){await verify();let r:{id:string;name:string};try{r=await context.saveOffice!(file);}catch(error){
   // A failed saver or second file is not proof that no file was written.
   if(error instanceof OrchestrationEffectNotStartedError)throw new Error('这一步的文件保存还没确认，请先核对已有成果。');throw error;
  }saved.push({...r,...artifactResultLinks(r.id)});}await verify();return {status:'completed',files:saved,...(summary?{summary}:{}),message:'已生成真实私有文件。HTML演示稿下载后可离线打开并导出HTML或PowerPoint，PDF使用打印另存。不要把成果说成已公开发布。'};
 }}};
 return reviewedContext(context)?reviewedNativeEffectTool(tool):tool;
}
