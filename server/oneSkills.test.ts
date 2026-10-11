import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import XLSX from 'xlsx';
import JSZip from 'jszip';
import {oneSkillLibrary,installOneSkillLibrary,bootstrapOneSkills} from './oneSkillLibrary.js';
import {validateFeatureExperience,composeFeatureTask} from './featureExperience.js';
import {calculateFinance} from '../skills-library/one/shared/scripts/finance.mjs';
import {csvParse,tableWorkbook,tableFileToCsv} from './skillTables.js';
import {selectedFeatureFiles,selectedTableCsv,saveFeatureArtifact} from './featureArtifacts.js';
import {localSkillTool} from './skillLocalTools.js';
import {featureImageBytes} from './featureImage.js';
import {importSkill} from './skillImport.js';
import {availableFeature,releaseFeature,startFeatureRun,executeFeatureRun,featureRunResult,continueFeatureRun,featureSummary} from './featureRuns.js';
import {updateOfficialFeature} from './officialFeatures.js';
import type {Database} from './types.js';
import type {Store} from './db.js';
const usage={inputTokens:10,outputTokens:5,totalTokens:15,source:'provider' as const};
const done={content:'测试结果',toolCalls:[],usage,finishReason:'stop' as const};
function fixture(){
 let db={users:[{id:'a',username:'甲',role:'admin',enabled:true},{id:'b',username:'乙',role:'user',enabled:true}],workspaces:[{id:'wa',status:'active'},{id:'wb',status:'active'}],workspaceMembers:[{workspaceId:'wa',userId:'a'},{workspaceId:'wb',userId:'b'}],models:[{id:'chat',name:'文字',kind:'chat',enabled:true,apiKey:'synthetic',systemPrompt:'safe',isDefault:true,inputPowerPerMillion:2,outputPowerPerMillion:4,costInputPowerPerMillion:1,costOutputPowerPerMillion:2},{id:'image',name:'图片',kind:'image',enabled:true,apiKey:'synthetic',systemPrompt:'safe',imagePowerPerCall:.01,costImagePowerPerCall:.005,inputPowerPerMillion:0,outputPowerPerMillion:0}],knowledgeConnections:[],modelUsageRecords:[],powerLedger:[],powerAccounts:[{id:'pa',workspaceId:'wa',userId:'a',balanceMicros:1000000},{id:'pb',workspaceId:'wb',userId:'b',balanceMicros:1000000}],attachments:[],conversations:[],messages:[],contextTraces:[],chatOperations:[],auditLogs:[],settings:{safetyRules:'safe',officialFeatures:[]}} as unknown as Database;
 let queue:Promise<unknown>=Promise.resolve();
 const store:Store={read:async()=>db,mutate:fn=>{const p=queue.then(()=>{const old=structuredClone(db);try{return fn(db);}catch(e){db=old;throw e;}});queue=p.catch(()=>undefined);return p;}};
 return {store,db:()=>db,scope:{workspaceId:'wa',userId:'a'}};
}
function publish(f:ReturnType<typeof fixture>,id:string){installOneSkillLibrary(f.db(),'a',[id]);let r=f.db().settings.officialFeatures!.find(s=>s.id===id)!;updateOfficialFeature(f.db().settings,id,{action:'approve',revision:r.revision,confirmed:true,evidence:'本次测试以合成输入验证第一版配置、收费隔离与文件输出'},'a','t');r=f.db().settings.officialFeatures!.find(s=>s.id===id)!;releaseFeature(f.db(),id,{action:'publish',revision:r.revision,version:1,userIds:['a'],confirmed:true},'a');return {operationId:'operation_1234567890',releaseId:r.release!.id,prompt:'请使用我提供的真实材料',sourceIds:[],confirmed:true,budget:.1};}
const noKnowledge={recallWithDiagnostics:async()=>{assert.fail('unexpected knowledge');}};
test('24 first-party recipes have distinct controls, valid defaults and idempotent installation',()=>{
 const f=fixture();assert.equal(oneSkillLibrary.length,24);assert.equal(new Set(oneSkillLibrary.map(s=>s.id)).size,24);
 for(const recipe of oneSkillLibrary){validateFeatureExperience(recipe.values.experience);assert.ok(composeFeatureTask(recipe.values.experience,'我的任务',{},undefined));assert.equal(recipe.values.author,'ONE');}
 assert.throws(()=>installOneSkillLibrary(f.db(),'b'),/无权/);
 assert.equal(installOneSkillLibrary(f.db(),'a').added.length,24);const record=f.db().settings.officialFeatures![0];record.draft.instructions='用户修改的独立版本';assert.equal(installOneSkillLibrary(f.db(),'a').existing.length,24);assert.equal(record.draft.instructions,'用户修改的独立版本');assert.equal(f.db().settings.officialFeatures!.every(s=>!s.release&&s.status==='draft'),true);
});
test('options reject forged fields, languages, numeric ranges, script fields and invalid actions',()=>{
 const e=oneSkillLibrary.find(s=>s.id==='one-g04')!.values.experience!;
 assert.match(composeFeatureTask(e,'联系客户',{language:'英文',bilingual:false},'draft'),/英文/);
 assert.throws(()=>composeFeatureTask(e,'任务',{language:'未知语言'},'draft'));
 assert.throws(()=>composeFeatureTask(e,'任务',{workspaceId:'wb'},'draft'));
 assert.throws(()=>composeFeatureTask(e,'任务',{},'madeup'));
 assert.throws(()=>validateFeatureExperience({...e,script:'rm -rf'}));
 const p=oneSkillLibrary.find(s=>s.id==='one-s01')!.values.experience!;assert.throws(()=>composeFeatureTask(p,'任务',{scenario:101},'calculate'));
});
test('profit, promotion and tax-aware quotes compute edge cases without inventing inputs',()=>{
 assert.equal(calculateFinance('profit',{revenue:10000,variableCost:4000,fixedCost:5000,quantity:100}).operatingProfit,1000);
 assert.equal(calculateFinance('profit',{revenue:10000,variableCost:4000,fixedCost:5000,quantity:100}).breakEvenQuantity,84);
 assert.equal(calculateFinance('profit',{revenue:0,variableCost:10,fixedCost:50,quantity:1}).operatingProfitRate,null);
 assert.equal(calculateFinance('promotion',{price:100,discount:20,variableCost:60,giftCost:5,channelRate:.1,fixedCampaignCost:100,participants:10}).campaignProfit,-30);
 assert.equal(calculateFinance('promotion',{price:10,discount:0,variableCost:20,giftCost:0,channelRate:0,fixedCampaignCost:0,participants:10}).breakEvenParticipants,null);
 assert.equal(calculateFinance('quote',{items:[{name:'商品',unit:'件',quantity:1,unitPrice:1.005}],shipping:0,taxRate:0,pricesIncludeTax:true}).total,1.01);
 assert.equal(calculateFinance('quote',{items:[{name:'商品',unit:'件',quantity:1,unitPrice:1}],shipping:0,taxRate:.145,pricesIncludeTax:false}).addedTax,.15);
 const quote={items:[{name:'课程',unit:'次',quantity:3,unitPrice:.1}],shipping:0,taxRate:.1,pricesIncludeTax:true};assert.equal(calculateFinance('quote',quote).total,.3);assert.equal(calculateFinance('quote',{...quote,pricesIncludeTax:false}).total,.33);
 assert.throws(()=>calculateFinance('profit',{revenue:10,variableCost:-1,fixedCost:2,quantity:1}));assert.throws(()=>calculateFinance('profit',{revenue:10,variableCost:1,fixedCost:2}));assert.throws(()=>calculateFinance('quote',{...quote,taxRate:2}));
});
test('CSV preserves quoted lines, explicit duplicate keys, empty keys and calendar anomalies',()=>{
 const clean=csvParse('clean',{csv:'客户,备注\nA,"第一行\n第二行"\nA,重复\n,一\n,二',deduplicate:true,keyColumns:['客户']});assert.equal(clean.inputRows,4);assert.equal(clean.outputRows,3);assert.equal(clean.duplicatesRemoved,1);assert.equal(clean.rows[1][1],'第一行\n第二行');
 assert.throws(()=>csvParse('clean',{csv:'a\n1\n1',deduplicate:true}),/依据/);
 const rows=csvParse('customers',{csv:'客户,最近交易日期\n甲,2026-01-01\n乙,2026-11-01\n丙,2026-02-30',referenceDate:'2026-10-11',inactiveDays:90}).rows;assert.equal(rows[1][3],'可考虑回访');assert.equal(rows[2][3],'日期待核实');assert.equal(rows[3][3],'日期待核实');
 assert.throws(()=>csvParse('customers',{csv:'客户,最近交易日期\n甲,2026-01-01',referenceDate:'2026-02-30',inactiveDays:90}));
});
test('XLSX exports literal strings, reads complete data and rejects excessive rows or sheets',async()=>{
 const bytes=tableWorkbook([['ID','内容'],['1','=HYPERLINK("http://bad")']]);const book=XLSX.read(bytes,{type:'buffer'});assert.equal(book.Sheets['结果'].B2.t,'s');assert.equal(book.Sheets['结果'].B2.f,undefined);
 assert.match(await tableFileToCsv(bytes,'表.xlsx'),/HYPERLINK/);
 const extra=XLSX.utils.book_new();XLSX.utils.book_append_sheet(extra,XLSX.utils.aoa_to_sheet([['a'],[1]]),'one');XLSX.utils.book_append_sheet(extra,XLSX.utils.aoa_to_sheet([['b'],[2]]),'two');await assert.rejects(tableFileToCsv(XLSX.write(extra,{type:'buffer',bookType:'xlsx'}),'many.xlsx'),/一个工作表/);
 await assert.rejects(tableFileToCsv(tableWorkbook([['a'],...Array.from({length:2001},()=>['x'])]),'large.xlsx'),/2000/);
});
test('table merge reads full authorized inputs rather than merging model previews',async()=>{
 const reads:string[]=[];let output:(string|number|boolean|null)[][]=[];
 const tool=localSkillTool('oneTable','合并',async()=>{},{readTable:async id=>{reads.push(id);return 'ID,名称\n'+Array.from({length:50},(_,i)=>`${id}${i},客户`).join('\n');},saveTable:async rows=>{output=rows;return {id:'file',name:'结果.xlsx'};}});
 const r=await tool.structured!.run({operation:'merge',dataJson:JSON.stringify({attachmentIds:['a','b']})}) as any;
 assert.equal(output.length,101);assert.equal(r.outputRows,100);assert.equal(r.rows.length,31);assert.equal(r.previewOnly,true);assert.deepEqual(reads,['a','b']);
 await assert.rejects(tool.structured!.run({operation:'merge',dataJson:JSON.stringify({attachmentIds:['a','a']})}));
});
test('selected files enforce workspace AND owner AND allowlist; failed artifact writes clean the disk',async t=>{
 const f=fixture(),directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-skill-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const storagePath=path.join(directory,'input.csv');await fs.writeFile(storagePath,'ID\n1');
 f.db().attachments.push({id:'own',...f.scope,storagePath,originalName:'输入.csv',mimeType:'text/csv',kind:'spreadsheet',size:4,extractedText:'ID\n1',status:'ready',createdAt:'t'});
 await assert.rejects(selectedFeatureFiles(f.store,{workspaceId:'wb',userId:'a'},['own']));await assert.rejects(selectedFeatureFiles(f.store,{workspaceId:'wa',userId:'b'},['own']));await assert.rejects(selectedTableCsv(f.store,f.scope,[],'own'));
 assert.match(await selectedTableCsv(f.store,f.scope,['own'],'own'),/1/);
 await assert.rejects(saveFeatureArtifact(f.store,{...f.scope,conversationId:'none'},directory,'结果.xlsx',Buffer.from('x'),'application/test','spreadsheet',()=>{throw new Error('revoked');}));assert.deepEqual(await fs.readdir(directory),['input.csv']);assert.equal(f.db().attachments.length,1);
});
test('real calculation tool + private XLSX receipt, selected options, replay and continuation isolation',async t=>{
 const f=fixture(),body=publish(f,'one-g05'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-skill-run-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const submitted={...body,options:{currency:'美元'},actionId:'quote'};await startFeatureRun(f.store,f.scope,'one-g05',submitted,async()=>{});let calls=0;
 await executeFeatureRun(f.store,f.scope,body.operationId,async()=>{},noKnowledge,{artifactDirectory:directory,modelCall:async(_m,messages,tools)=>{calls++;assert.match(JSON.stringify(messages),/美元/);if(calls===1){assert.equal(tools[0].function.name,'oneFinance');return {...done,content:'',toolCalls:[{id:'q',type:'function',function:{name:'oneFinance',arguments:JSON.stringify({operation:'quote',dataJson:JSON.stringify({items:[{name:'课程',unit:'次',quantity:3,unitPrice:100}],shipping:0,taxRate:0,pricesIncludeTax:true})})}}]};}assert.match(JSON.stringify(messages),/300/);return done;}});
 const result=featureRunResult(f.db(),f.scope,body.operationId);assert.equal(result.status,'completed');assert.equal(result.files?.length,1);assert.equal(result.charges?.length,2);const quoteFile=f.db().attachments.find(a=>a.id===result.files![0].id)!;assert.match(await tableFileToCsv(await fs.readFile(quoteFile.storagePath),'quote.xlsx'),/美元/);assert.equal(f.db().powerAccounts[1].balanceMicros,1000000);assert.doesNotMatch(JSON.stringify(result),/storagePath|synthetic/);
 assert.equal((await startFeatureRun(f.store,f.scope,'one-g05',submitted,async()=>{})).created,false);
 await assert.rejects(startFeatureRun(f.store,f.scope,'one-g05',{...submitted,options:{currency:'欧元'}},async()=>{}),/同一提交标识/);
 await assert.rejects(continueFeatureRun(f.store,{workspaceId:'wb',userId:'b'},body.operationId,{...body,operationId:'continuation_12345678'},async()=>{}));
 const next=await continueFeatureRun(f.store,f.scope,body.operationId,{operationId:'continuation_12345678',prompt:'数量改为4',confirmed:true,budget:.1},async()=>{});assert.equal(next.created,true);assert.match(next.result.prompt??'',/美元/);assert.match(next.result.prompt??'',/数量改为4/);
 assert.equal(featureSummary(availableFeature(f.db(),f.scope,'one-g05').record).destinations.length,0);
});
test('image execution uses references, bills owner and returns only private image paths; Key loss stops save',async t=>{
 const f=fixture(),body=publish(f,'one-g09'),directory=await fs.mkdtemp(path.join(os.tmpdir(),'one-skill-image-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await startFeatureRun(f.store,f.scope,'one-g09',body,async()=>{});await executeFeatureRun(f.store,f.scope,body.operationId,async()=>{},noKnowledge,{artifactDirectory:directory,imageCall:async(_m,messages)=>{assert.match(messages[0].content,/封面/);return {content:'图片',imageUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',usage};}});
 const r=featureRunResult(f.db(),f.scope,body.operationId);assert.equal(r.status,'completed');assert.match(r.imageUrl??'',/^\/api\/attachments\//);assert.equal(r.files?.length,1);assert.equal(r.charges?.length,1);assert.throws(()=>featureRunResult(f.db(),{workspaceId:'wb',userId:'b'},body.operationId));
 const g=fixture(),next=publish(g,'one-g09');let key=true;await startFeatureRun(g.store,g.scope,'one-g09',next,async()=>{});await executeFeatureRun(g.store,g.scope,next.operationId,async()=>{if(!key)throw new Error('key absent');},noKnowledge,{artifactDirectory:directory,imageCall:async()=>{key=false;return {content:'图片',imageUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',usage};}});assert.equal(g.db().attachments.length,0);assert.equal(featureRunResult(g.db(),g.scope,next.operationId).status,'failed');
 await assert.rejects(featureImageBytes('data:image/png;base64,bm90LWFuLWltYWdl'));await assert.rejects(featureImageBytes('https://127.0.0.1/secret'));await assert.rejects(featureImageBytes('file:///etc/passwd'));
});
test('ONE ZIP preserves options and reviewed tools but drops uploaded model binding',async()=>{
 const recipe=oneSkillLibrary[0],zip=new JSZip();zip.file('SKILL.md','---\nname: demo\ndescription: 功能测试\n---\n示例说明');zip.file('config.json',JSON.stringify({...recipe,values:{...recipe.values,modelId:'untrusted'}}));const r=await importSkill(await zip.generateAsync({type:'nodebuffer'}),'skill.zip');assert.equal(r.values?.name,recipe.values.name);assert.equal('modelId' in r.values!,false);assert.equal(r.values?.tools?.[0].id,'oneFinance');assert.ok(r.values?.experience?.inputs.length);
});

test('first edition bootstraps only missing skills, opens admin testing and preserves operator changes',()=>{const f=fixture();const first=bootstrapOneSkills(f.db());assert.equal(first.added.length,24);assert.equal(first.opened.length,24);for(const s of f.db().settings.officialFeatures!)assert.deepEqual(s.release?.userIds,['a']);assert.throws(()=>availableFeature(f.db(),{workspaceId:'wb',userId:'b'},'one-g04'));const r=f.db().settings.officialFeatures![0];delete r.release;r.draft.instructions='管理员自己的修改';assert.equal(bootstrapOneSkills(f.db()).added.length,0);assert.equal(r.release,undefined);assert.equal(r.draft.instructions,'管理员自己的修改');});

test('a full existing catalog cannot make first-party bootstrap stop application startup',()=>{const f=fixture();f.db().settings.officialFeatures=Array.from({length:100},(_,i)=>({id:'existing-'+i})) as any;assert.equal(bootstrapOneSkills(f.db()).added.length,0);assert.equal(f.db().settings.officialFeatures!.length,100);});
