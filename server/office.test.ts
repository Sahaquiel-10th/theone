import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import XLSX from 'xlsx';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {slideFiles,validateDeck,type SlideDeck} from './officeSlides.js';
import {createWorkbook,fillWorkbook,reconcileWorkbook,analyzeWorkbook,inspectWorkbook} from './officeWorkbook.js';
import {createWord} from './officeDocument.js';
import {officeTool} from './officeTools.js';
import {officeArtifactContext} from './featureArtifacts.js';
import {installOfficeRoutes} from './officeRoutes.js';
import type {Database} from './types.js';
import type {Store} from './db.js';
import {runTaskOrchestrator,OrchestrationEffectNotStartedError,orchestrationFailureCode} from './taskOrchestrator.js';
import type {TaskStep} from './taskSteps.js';
import {taskRecovery} from '../src/taskRecovery.js';

function officeCheckpoint(){const steps:TaskStep[]=[];return{namespace:'feature:native-office:1',steps,save:async(step:TaskStep)=>{const index=steps.findIndex(s=>s.key===step.key);if(index<0)steps.push(step);else steps[index]=step;}};}
const nativeCall=(name:string,payload:unknown,operation='create')=>({id:'native-office-call',type:'function' as const,function:{name,arguments:JSON.stringify({operation,dataJson:JSON.stringify(payload)})}});

test('native workbook validation fails before saving and corrected arguments can finish without a false unknown write',async()=>{
 const checkpoints=officeCheckpoint();let turns=0,saves=0;
 const tool=officeTool('oneWorkbook','合成表格',async()=>{},{saveOffice:async file=>{saves++;return{id:'saved-workbook',name:file.name};}});
 const invalid={title:'合成预算',sheets:[{name:'预算',headers:[],rows:[[1]]}]};
 const valid={title:'合成预算',sheets:[{name:'预算',headers:['人数'],rows:[[4]]}]};
 const result=await runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[tool],maxSteps:4,beforeStep:async()=>{},checkpoints,call:async messages=>{
  turns++;
  if(turns===1)return{content:'',toolCalls:[nativeCall('oneWorkbook',invalid)]};
  if(turns===2){assert.match(JSON.stringify(messages),/列名|1–40/);assert.equal(checkpoints.steps[0].state,'failed');assert.equal(saves,0);return{content:'',toolCalls:[nativeCall('oneWorkbook',valid)]};}
  return{content:'表格已经生成。',toolCalls:[]};
 }});
 assert.equal(saves,1);assert.equal(result.content,'表格已经生成。');assert.deepEqual(checkpoints.steps.map(s=>s.state),['failed','completed']);assert.equal(checkpoints.steps.some(s=>s.state==='started'),false);
});

test('unrepaired native input has a specific no-artifact failure and permits retry without releasing another unknown effect',async()=>{
 const checkpoints=officeCheckpoint();let turns=0,saves=0;
 const tool=officeTool('oneWorkbook','合成表格',async()=>{},{saveOffice:async()=>{saves++;throw Error('must not save');}});
 await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[tool],maxSteps:3,beforeStep:async()=>{},checkpoints,call:async()=>++turns===1?{content:'',toolCalls:[nativeCall('oneWorkbook',{title:'无效',sheets:[{name:'预算',headers:['甲','乙'],rows:[[1]]}]})]}:{content:'目前还没有生成这份表格。',toolCalls:[]}}),error=>{assert.ok(error instanceof OrchestrationEffectNotStartedError);assert.equal(orchestrationFailureCode(error),'task_artifact_input_invalid');assert.match(error.message,/单元格数量.*列名.*null/);return true;});
 assert.equal(saves,0);assert.equal(checkpoints.steps[0].state,'failed');
 assert.equal(taskRecovery([{id:'current',state:'failed',steps:checkpoints.steps}]).kind,'retry');
 const unknown={...checkpoints.steps[0],key:'other-real-save',tool:'oneDocument',state:'started' as const};
 assert.equal(taskRecovery([{id:'current',state:'failed',steps:[unknown,...checkpoints.steps]}]).kind,'none','another real uncertain save stays protected');
});

test('a successful inspect cannot turn a rejected workbook creation into a delivered artifact',async()=>{
 const workbook=await createWorkbook({title:'已有模板',sheets:[{name:'表1',headers:['值'],rows:[[42]]}]});
 for(const trustedReceipt of [false,true]){
  const checkpoints=officeCheckpoint();let turns=0,saves=0;
  const tool=officeTool('oneWorkbook','合成表格',async()=>{},{readOffice:async()=>workbook.bytes,saveOffice:async()=>{saves++;throw Error('must not save');}});
  await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[tool],maxSteps:4,beforeStep:async()=>{},checkpoints,...(trustedReceipt?{completeAfterTools:()=>turns===2?'表格已经生成。':undefined}:{}),call:async()=>{
   turns++;
   if(turns===1)return{content:'',toolCalls:[nativeCall('oneWorkbook',{title:'无效',sheets:[{name:'预算',headers:[],rows:[[1]]}]})]};
   if(turns===2)return{content:'',toolCalls:[nativeCall('oneWorkbook',{attachmentId:'selected-template'},'inspect')]};
   return{content:'表格已经生成。',toolCalls:[]};
  }}),error=>error instanceof OrchestrationEffectNotStartedError);
  assert.equal(saves,0);assert.deepEqual(checkpoints.steps.map(s=>[s.effect,s.state]),[['artifact','failed'],['read','completed']]);
 }
});

test('Office reader failures retain their identity and never enter a paid argument-repair round',async()=>{
 for(const [id,operation,payload,reader] of [
  ['oneWorkbook','inspect',{attachmentId:'selected'},'readOffice'],
  ['oneWorkbook','fill',{attachmentId:'selected',title:'合成表格',updates:[]},'readOffice'],
  ['oneWorkbook','reconcile',{leftId:'selected',rightId:'right'},'readTable'],
  ['oneWorkbook','analyze',{attachmentId:'selected'},'readTable'],
  ['oneSlides','inspect',{attachmentId:'selected'},'readSlides'],
  ['oneSlides','revise',{attachmentId:'selected',changes:[]},'readSlides'],
 ] as const){
  const denied=new Error('附件不属于当前访客或尚未就绪');let turns=0,reads=0,saves=0;
  const tool=officeTool(id,'合成读取',async()=>{},{[reader]:async()=>{reads++;throw denied;},saveOffice:async()=>{saves++;throw Error('must not save');}});
  await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[tool],maxSteps:4,maxCorrections:2,beforeStep:async()=>{},call:async()=>{turns++;return{content:'',toolCalls:[nativeCall(id,payload,operation)]};}}),error=>error===denied);
  assert.equal(turns,1);assert.equal(reads,1);assert.equal(saves,0);
 }
});

test('pure Office payload validation fails before any reader and permits a bounded corrected call',async()=>{
 const workbook=await createWorkbook({title:'模板',sheets:[{name:'登记',headers:['客户'],rows:[['原始']]}]});
 for(const [id,operation,valid] of [
  ['oneWorkbook','fill',{attachmentId:'selected',title:'已填',updates:[{sheet:'登记',cell:'A2',value:'合成'}]}],
  ['oneWorkbook','reconcile',{leftId:'selected',rightId:'right',title:'对账',leftKeys:['客户'],rightKeys:['客户'],leftAmount:'金额',rightAmount:'金额',tolerance:0,trim:false}],
  ['oneWorkbook','analyze',{attachmentId:'selected',title:'分析',groupBy:'客户',valueColumn:'金额',aggregation:'sum',chartType:'bar'}],
  ['oneSlides','revise',{attachmentId:'selected',changes:[{page:1,slide:{title:'已改',layout:'cover'}}]}],
 ] as const){
  const checkpoints=officeCheckpoint();let turns=0,reads=0,saves=0;
  const tool=officeTool(id,'合成处理',async()=>{},{readOffice:async()=>{reads++;return workbook.bytes;},readTable:async()=>{reads++;return '客户,金额\n甲,1';},readSlides:async()=>{reads++;return structuredClone(officeDemo);},saveOffice:async file=>{saves++;return{id:`saved-${saves}`,name:file.name};}});
  await runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[tool],maxSteps:4,beforeStep:async()=>{},checkpoints,call:async()=>{
   turns++;if(turns===1)return{content:'',toolCalls:[nativeCall(id,{...valid,extra:true},operation)]};
   if(turns===2){assert.equal(reads,0);assert.equal(saves,0);assert.equal(checkpoints.steps[0].state,'failed');return{content:'',toolCalls:[nativeCall(id,valid,operation)]};}
   return{content:'文件已生成。',toolCalls:[]};
  }});
  assert.equal(checkpoints.steps.some(s=>s.state==='started'),false);assert.ok(saves>=1);
 }
});

test('a partial multi-file native delivery stays unknown through a nested artifact wrapper',async()=>{
 const checkpoints=officeCheckpoint();let saves=0;
 const native=officeTool('oneSlides','合成演示',async()=>{},{saveOffice:async file=>{if(++saves===1)return{id:'first-file',name:file.name};throw Error('second save acknowledgement lost');}});
 const wrapper={name:'oneHtml',effect:'artifact' as const,run:async()=>runTaskOrchestrator({entryPoint:'workspace' as const,messages:[],tools:[native],maxSteps:2,beforeStep:async()=>{},call:async()=>({content:'',toolCalls:[nativeCall('oneSlides',officeDemo)]})})};
 await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[wrapper],maxSteps:3,maxCorrections:2,beforeStep:async()=>{},checkpoints,call:async()=>({content:'',toolCalls:[{id:'wrapper',type:'function',function:{name:wrapper.name,arguments:'{"query":"合成演示"}'}}]})}),/second save acknowledgement lost/);
 assert.equal(saves,2);assert.equal(checkpoints.steps[0].state,'started');
});

test('inspect is a read, while a failed saver or a partial multi-file delivery remains unknown',async()=>{
 const workbook=await createWorkbook({title:'只读模板',sheets:[{name:'表1',headers:['值'],rows:[[42]]}]});
 const read=officeTool('oneWorkbook','读取模板',async()=>{},{readOffice:async()=>workbook.bytes});const reads=officeCheckpoint();let readTurn=0;
 await runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[read],maxSteps:2,beforeStep:async()=>{},checkpoints:reads,call:async()=>++readTurn===1?{content:'',toolCalls:[nativeCall('oneWorkbook',{attachmentId:'selected-template'},'inspect')]}:{content:'读取完成。',toolCalls:[]}});
 assert.equal(reads.steps[0].effect,'read');assert.equal(reads.steps[0].state,'completed');
 for(const multiFile of [false,true]){
  const checkpoint=officeCheckpoint();let saves=0;
  const tool=officeTool(multiFile?'oneSlides':'oneWorkbook','合成保存',async()=>{},{saveOffice:async file=>{saves++;if(multiFile&&saves===1)return{id:'first-delivered',name:file.name};throw new Error('private storage receipt missing secret=never-echo');}});
  await assert.rejects(()=>runTaskOrchestrator({entryPoint:'workspace',messages:[],tools:[tool],maxSteps:2,beforeStep:async()=>{},checkpoints:checkpoint,call:async()=>({content:'',toolCalls:[nativeCall(tool.name,multiFile?officeDemo:{title:'保存未知',sheets:[{name:'表1',headers:['值'],rows:[[1]]}]})]})}),error=>!(error instanceof OrchestrationEffectNotStartedError));
  assert.equal(checkpoint.steps[0].state,'started');assert.equal(saves,multiFile?2:1);
  assert.equal(taskRecovery([{id:'current',state:'failed',steps:checkpoint.steps}]).kind,'none');
 }
});
test('workbook tool advertises the actually implemented ROUNDUP function to execution models',()=>{
 const tool=officeTool('oneWorkbook','创建预算表',async()=>{},{});
 assert.match(tool.description!,/ROUNDUP\(120\/\(50-15\),0\)/);
 assert.match(tool.description!,/其他函数与外部引用不支持/);
 assert.match(tool.description!,/rows\[0\].*第2行/);assert.match(tool.description!,/空白分隔行也占行/);
 assert.doesNotMatch(officeTool('oneDocument','Word文档',async()=>{},{}).description!,/ROUNDUP/);
});
test('workbook creation returns bounded actual cell readback, including formula evidence, without reading existing files',async()=>{
 let saved=0;
 const tool=officeTool('oneWorkbook','创建预算表',async()=>{},{readOffice:async()=>{throw Error('must not read an existing file');},saveOffice:async file=>{saved++;assert.ok(file.bytes.length>0);return{id:'synthetic-file',name:file.name};}});
 const data={title:'合成核对',sheets:[{name:'核对',headers:['人数','净收益'],rows:[[4,null],[6,null],[10,null]],formulas:[{cell:'B2',formula:'A2*35-120'},{cell:'B3',formula:'A3*35-120'},{cell:'B4',formula:'A4*35-120'}]}]};
 const result=await tool.structured!.run({operation:'create',dataJson:JSON.stringify(data)}) as any;
 assert.equal(saved,1);assert.equal(result.summary.previewOnly,true);assert.equal(result.summary.sheets[0].truncated,false);
 assert.deepEqual(result.summary.sheets[0].cells.find((cell:any)=>cell.cell==='B4'),{cell:'B4',value:'230',valueTruncated:false,formula:'A4*35-120'});
 const many={title:'较长的合成核对',sheets:[{name:'核对',headers:['一','二','三','四','五'],rows:Array.from({length:100},()=>[1,2,3,4,5])},{name:'未展示页',headers:['值'],rows:[[123]]}]};
 const bounded=await tool.structured!.run({operation:'create',dataJson:JSON.stringify(many)}) as any;
 assert.equal(bounded.summary.sheets[0].cells.length,120);assert.equal(bounded.summary.sheets[0].truncated,true);
 assert.equal(bounded.summary.sheets[1].cells.length,0);assert.equal(bounded.summary.sheets[1].truncated,true);
});
export const officeDemo:SlideDeck={title:'项目交付与经营复盘',theme:'paper',slides:[
 {title:'项目交付与经营复盘',layout:'cover',subtitle:'演示资料 · 所有数据均为虚构',notes:'先说明本演示不代表任何企业的实际业绩。'},
 {title:'本轮需要确认的事项',layout:'bullets',bullets:['确认客户图纸和现场接口','对齐供货与安装的责任范围','用交付证据确认下一次付款节点'],source:'来源：本地虚构演示资料'},
 {title:'两种交付方式',layout:'split',columns:[{title:'分阶段交付',items:['先确认基础需求','分别验收各阶段成果']},{title:'集中交付',items:['先核对所有依赖','集中组织交付验收']}]},
 {title:'季度记录示例',layout:'chart',chart:{labels:['第一季度','第二季度','第三季度'],values:[32,45,54],unit:'记录数 · 虚构数据'}},
 {title:'项目交接记录',layout:'table',table:[['事项','负责人','状态'],['图纸确认','待指定','等待客户'],['安装安排','项目经理','日期待确认'],['培训记录','服务团队','待整理']]},
 {title:'下一步安排',layout:'bullets',bullets:['先补齐影响报价的资料','逐项核对交付范围与金额','明确需要负责人确认的事项'],notes:'不把建议日期说成客户已批准的承诺。'}]};
test('HTML and PPTX contain all pages, editable text and notes, and escape untrusted material',async()=>{
 const deck=structuredClone(officeDemo);deck.slides[1].bullets![0]='</script><img src=x onerror=alert(1)>';
 const files=await slideFiles(deck);assert.deepEqual(files.map(f=>f.name.split('.').at(-1)),['html','pptx']);const html=files[0].bytes.toString();assert.equal((html.match(/<section class="slide"/g)??[]).length,6);assert.match(html,/导出 PowerPoint/);assert.match(html,/导出 HTML/);assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;\/script&gt;/);
 const zip=await JSZip.loadAsync(files[1].bytes);assert.equal(Object.keys(zip.files).filter(k=>/^ppt\/slides\/slide\d+\.xml$/.test(k)).length,6);assert.match(await zip.file('ppt/slides/slide2.xml')!.async('string'),/&lt;\/script&gt;/);assert.match(await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string'),/不代表/);assert.doesNotMatch(Object.keys(zip.files).join(' '),/media\/image|vba/);
 assert.throws(()=>validateDeck({...officeDemo,slides:[{title:'太多',layout:'bullets',bullets:Array(8).fill('内容')}]}));
 assert.throws(()=>validateDeck({...officeDemo,slides:[{title:'不匹配',layout:'cover',bullets:['不能悄悄丢掉']}]}));
});
test('new workbooks calculate whitelisted formulas, preserve literal text and create dropdowns',async()=>{
 const file=await createWorkbook({title:'预算',sheets:[{name:'预算',headers:['项目','数量','单价','金额','状态'],rows:[['安装',3,0.1,null,'待确认'],['培训',2,0.2,null,'已确认'],['合计',null,null,null,'']],formulas:[{cell:'D2',formula:'ROUND(B2*C2,2)'},{cell:'D3',formula:'B3*C3'},{cell:'D4',formula:'SUM(D2:D3)'}],dropdowns:[{column:'状态',options:['待确认','已确认']} ]},{name:'说明',headers:['原文','引用'],rows:[['=HYPERLINK("https://bad")',null]],formulas:[{cell:'B2',formula:"'预算'!D4"}]}]});
 const book=XLSX.read(file.bytes,{type:'buffer',cellFormula:true});assert.equal(book.Sheets['预算'].D4.v,0.7);assert.equal(book.Sheets['说明'].B2.v,0.7);assert.equal(book.Sheets['说明'].A2.f,undefined);const zip=await JSZip.loadAsync(file.bytes),sheet=await zip.file('xl/worksheets/sheet1.xml')!.async('string');assert.match(sheet,/dataValidation/);assert.match(sheet,/state="frozen"/);assert.match(sheet,/autoFilter/);
 for(const formula of ['D2+1','B2/0','HYPERLINK("https://bad")','SUM([other.xlsx]Sheet1!B2)'])await assert.rejects(createWorkbook({title:'坏公式',sheets:[{name:'数据',headers:['名','值','值2','合计'],rows:[['x',1,2,null]],formulas:[{cell:'D2',formula}]}]}));
});
test('break-even ROUNDUP is cached as four and rounds away from zero without enabling external functions',async()=>{
 const formulas=['ROUNDUP(120/(50-15),0)','ROUNDUP(-1.01,0)','ROUNDUP(2.2,1)','ROUNDUP(123,-1)'];
 const file=await createWorkbook({title:'保本',sheets:[{name:'预算',headers:['公式结果'],rows:formulas.map(()=>[null]),formulas:formulas.map((formula,i)=>({cell:`A${i+2}`,formula}))}]});
 const b=XLSX.read(file.bytes,{type:'buffer',cellFormula:true});
 assert.deepEqual(formulas.map((_,i)=>b.Sheets['预算'][`A${i+2}`].v),[4,-2,2.2,130]);
 assert.equal(b.Sheets['预算'].A2.f,formulas[0]);
 for(const formula of ['ROUNDUP()','ROUNDUP(1,11)','ROUNDUP(1,0.5)','ROUNDUP([secret.xlsx]Sheet1!A1,0)'])await assert.rejects(createWorkbook({title:'拒绝',sheets:[{name:'数据',headers:['值'],rows:[[null]],formulas:[{cell:'A2',formula}]}]}));
});
test('formula-derived chart values use recalculated numbers, including negative ROUND half values',async()=>{
 const file=await createWorkbook({title:'公式图表',sheets:[{name:'计算',headers:['分类','数值'],rows:[['甲',null],['乙',null]],formulas:[{cell:'B2',formula:'ROUND(-1.5,0)'},{cell:'B3',formula:'0.1+0.2'}],chart:{type:'bar',categoryColumn:'分类',valueColumn:'数值',title:'计算结果'}}]});const b=XLSX.read(file.bytes,{type:'buffer'});assert.equal(b.Sheets['计算'].B2.v,-2);assert.equal(b.Sheets['计算'].B3.v,.3);const z=await JSZip.loadAsync(file.bytes);assert.match(await z.file('xl/charts/chart1.xml')!.async('string'),/<c:v>-2<\/c:v>/);
});
test('template fill keeps style, merged cells and all other package parts, clears stale caches and refuses formula overwrite',async()=>{
 const original=await createWorkbook({title:'模板',sheets:[{name:'登记',headers:['客户','数量','价格','金额'],rows:[['',2,30,null]],formulas:[{cell:'D2',formula:'B2*C2'}]}]});const zip=await JSZip.loadAsync(original.bytes);zip.file('customXml/data.xml','<keep>unchanged</keep>');let sx=await zip.file('xl/worksheets/sheet1.xml')!.async('string');sx=sx.replace('</sheetData>','<row r="3" ht="30"/></sheetData>').replace('</worksheet>','<mergeCells count="1"><mergeCell ref="A4:B4"/></mergeCells></worksheet>');zip.file('xl/worksheets/sheet1.xml',sx);const input=await zip.generateAsync({type:'nodebuffer'});
 const preview=await inspectWorkbook(input);assert.equal(preview.sheets[0].name,'登记');
 const filled=await fillWorkbook(input,{title:'已填登记',updates:[{sheet:'登记',cell:'A2',value:'客户甲'},{sheet:'登记',cell:'B2',value:3},{sheet:'登记',cell:'A4',value:'新填行'}]}),out=await JSZip.loadAsync(filled.bytes),book=XLSX.read(filled.bytes,{type:'buffer',cellFormula:true,sheetStubs:true});assert.equal(book.Sheets['登记'].A2.v,'客户甲');assert.equal(book.Sheets['登记'].A4.v,'新填行');assert.equal(book.Sheets['登记'].D2.f,'B2*C2');assert.equal(await out.file('xl/styles.xml')!.async('string'),await zip.file('xl/styles.xml')!.async('string'));assert.equal(await out.file('customXml/data.xml')!.async('string'),'<keep>unchanged</keep>');assert.doesNotMatch(await out.file('xl/worksheets/sheet1.xml')!.async('string'),/<f>B2\*C2<\/f><v>60<\/v>/);
 await assert.rejects(fillWorkbook(input,{title:'拒绝',updates:[{sheet:'登记',cell:'D2',value:50}]}),/公式/);await assert.rejects(fillWorkbook(input,{title:'拒绝',updates:[{sheet:'登记',cell:'B4',value:'x'}]}),/左上角/);
 const empty=await fillWorkbook(input,{title:'填空行',updates:[{sheet:'登记',cell:'A3',value:'新内容'}]}),ez=await JSZip.loadAsync(empty.bytes),es=await ez.file('xl/worksheets/sheet1.xml')!.async('string');assert.equal((es.match(/<row r="3"/g)??[]).length,1);assert.match(es,/<row r="3" ht="30">/);assert.equal(XLSX.read(empty.bytes,{type:'buffer'}).Sheets['登记'].A3.v,'新内容');
});
test('reconciliation retains duplicate and blank keys and decimal differences rather than choosing arbitrary records',async()=>{
 const left='单号,金额\n001,0.3\n002,10\n002,20\n,4\n003,5\n004,bad',right='订单,实收\n001,0.30\n002,30\n003,4.99\n004,6\n005,7';const r=await reconcileWorkbook(left,right,{title:'对账',leftKeys:['单号'],rightKeys:['订单'],leftAmount:'金额',rightAmount:'实收',tolerance:0,trim:false});assert.deepEqual(r.summary,{leftRows:6,rightRows:5,compared:3,exceptions:5,amountDifferences:1,uncomparable:1});const b=XLSX.read(r.file.bytes,{type:'buffer'});assert.equal(b.Sheets['左来源'].A2.v,'001');assert.equal(b.SheetNames.length,4);
});
test('analysis includes complete input rows, records excluded values and embeds a native editable chart',async()=>{
 const csv='分类,金额\n'+Array.from({length:80},()=> '甲,0.1').join('\n')+'\n乙,2\n乙,未知\n,3';const r=await analyzeWorkbook(csv,{title:'分类分析',groupBy:'分类',valueColumn:'金额',aggregation:'sum',chartType:'bar'});assert.equal(r.summary.included,81);assert.equal(r.summary.excluded,2);assert.deepEqual(r.preview,[['甲',8],['乙',2]]);const zip=await JSZip.loadAsync(r.file.bytes);assert.ok(zip.file('xl/charts/chart1.xml'));assert.match(await zip.file('xl/charts/chart1.xml')!.async('string'),/strCache/);assert.doesNotMatch(await zip.file('xl/worksheets/sheet1.xml')!.async('string'),/xmlns:r="[^"]+"[^>]*xmlns:r=/);
});
test('Word file contains editable chapters, table, styles and automatic footer page field',async()=>{
 const file=await createWord({title:'项目报告',style:'business',sections:[{heading:'项目目标',paragraphs:['确认本轮交付范围'],table:[['事项','状态'],['图纸','待确认']],source:'虚构资料'}]});const zip=await JSZip.loadAsync(file.bytes);const body=await zip.file('word/document.xml')!.async('string');assert.match(body,/w:tbl/);assert.match(body,/项目目标/);assert.match(await zip.file('word/footer1.xml')!.async('string'),/PAGE/);assert.equal(file.name,'项目报告.docx');
});
test('office readers enforce selected IDs and owner/workspace; revoked saves leave no output',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-office-auth-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const b=await createWorkbook({title:'模板',sheets:[{name:'登记',headers:['客户'],rows:[['甲']]}]});const filePath=path.join(directory,'input.xlsx');await fs.writeFile(filePath,b.bytes);const scope={workspaceId:'wa',userId:'a',conversationId:'c'};const db={attachments:[{...scope,id:'own',originalName:'模板.xlsx',storagePath:filePath,status:'ready',size:b.bytes.length,kind:'spreadsheet'}],conversations:[{id:'c',...scope}]} as unknown as Database;const store={read:async()=>db,mutate:async(fn:any)=>fn(db)} as Store;
 const context=officeArtifactContext(store,scope,directory,()=>{},['own']);assert.equal((await context.readOffice!('own')).length,b.bytes.length);await assert.rejects(context.readOffice!('other'));await assert.rejects(officeArtifactContext(store,{...scope,workspaceId:'wb'},directory,()=>{},['own']).readOffice!('own'));await assert.rejects(officeArtifactContext(store,{...scope,userId:'b'},directory,()=>{},['own']).readOffice!('own'));
 await assert.rejects(officeArtifactContext(store,scope,directory,()=>{throw new Error('revoked');},[]).saveOffice!(b));assert.deepEqual(await fs.readdir(directory),['input.xlsx']);
 let calls=0;const tool=officeTool('oneSlides','测试',async()=>{if(++calls>1)throw new Error('key removed');},{saveOffice:async()=>{throw new Error('must not save');}});await assert.rejects(tool.structured!.run({operation:'create',dataJson:JSON.stringify(officeDemo)}),/key removed/);
});
test('private slide preview cannot expose a different owner/workspace or turn uploaded HTML into executable output',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-office-view-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const bytes=Buffer.from('<!doctype html><title>受保护演示</title>');const storagePath=path.join(directory,'deck.html');await fs.writeFile(storagePath,bytes);
 const db={users:[{id:'a',enabled:true,role:'admin'},{id:'b',enabled:true,role:'user'}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a'},{workspaceId:'wb',userId:'b'}],attachments:[{id:'deck',workspaceId:'wa',userId:'a',officeArtifact:'slides',mimeType:'text/html',status:'ready',storagePath,size:bytes.length},{id:'uploaded',workspaceId:'wa',userId:'a',mimeType:'text/html',status:'ready',storagePath,size:bytes.length}]} as unknown as Database;
 const app=express();installOfficeRoutes(app,[(req,_res,next)=>{req.user=db.users.find(u=>u.id===req.header('x-user'))!;req.workspaceId=req.header('x-workspace');next();}],{read:async()=>db} as Store);app.use((_error:unknown,_req:unknown,res:any,_next:unknown)=>res.status(403).json({error:'denied'}));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));const address=server.address() as {port:number},url=`http://127.0.0.1:${address.port}`;
 const own=await fetch(url+'/api/office-files/deck/view',{headers:{'x-user':'a','x-workspace':'wa'}});assert.equal(own.status,200);assert.match(own.headers.get('content-security-policy')!,/sandbox allow-scripts allow-downloads allow-modals/);assert.doesNotMatch(own.headers.get('content-security-policy')!,/allow-same-origin/);assert.match(await own.text(),/受保护/);
 for(const [user,workspace] of [['b','wb'],['a','wb'],['b','wa']])assert.equal((await fetch(url+'/api/office-files/deck/view',{headers:{'x-user':user,'x-workspace':workspace}})).status,403);assert.equal((await fetch(url+'/api/office-files/uploaded/view',{headers:{'x-user':'a','x-workspace':'wa'}})).status,404);
});
