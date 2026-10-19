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
