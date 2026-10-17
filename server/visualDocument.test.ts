import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateVisualDocument,renderVisualDiagram,renderVisualPage,visualPageCsp,visualPageRuntime,visualScriptHash,visualDiagramHeight,type VisualDocument} from './visualDocument.js';
import {parseWelcomeManual,welcomeCapabilities,callWelcomePlanner,welcomeRetryPower} from './welcomeManual.js';
import {ModelRequestError} from './modelGateway.js';
import {visualTool} from './visualTools.js';
const scene={id:'work',title:'把资料变成说明',situation:'开会前，想把散乱的想法理清楚。',feature:'整理已有材料，列出关键决定。',advantage:'不必自己来回翻页。',benefit:'拿到一份能拿去讨论的提纲。',evidence:'逐条检查结论和待确认项。',steps:['告诉 ONE 目标。','检查提纲再补充要求。'],prompt:'请整理这份材料，缺少的地方单独列出来。',capabilityIds:['chat']};
const doc:VisualDocument={version:1,title:'小张的 ONE 使用说明',intro:'先把开会前最费劲的那一步交给 ONE。',scenes:[scene,{...scene,id:'next',title:'交给任务去做'}]};
test('pure planner retries known upstream 502 at most twice, checks cancellation and quotes all unfinished stages',async()=>{
 let calls=0,retries=0,checks=0;const verify=async()=>{checks++;};
 assert.equal(await callWelcomePlanner(async()=>{calls++;if(calls<3)throw new ModelRequestError(502,'temporarily unavailable');return 'ok';},verify,async()=>{retries++;},async()=>{}),'ok');assert.equal(calls,3);assert.equal(retries,2);assert.ok(checks>=5);
 calls=0;await assert.rejects(()=>callWelcomePlanner(async()=>{calls++;throw new ModelRequestError(401,'unauthorized');},verify,async()=>{},async()=>{}));assert.equal(calls,1);
 calls=0;await assert.rejects(()=>callWelcomePlanner(async()=>{calls++;throw new ModelRequestError(502,'unavailable');},verify,async()=>{},async()=>{}));assert.equal(calls,3);
 calls=0;await assert.rejects(()=>callWelcomePlanner(async()=>{calls++;throw new ModelRequestError(502,'unavailable');},async()=>{if(calls)throw Error('stopped');},async()=>{},async()=>{}),/stopped/);assert.equal(calls,1);
 const job={welcomeManual:{reservation:150000}} as any;assert.equal(welcomeRetryPower(job,.012),.162);job.welcomeManual.document=doc;assert.equal(welcomeRetryPower(job,.012),.012);job.welcomeImageAttachmentId='saved';assert.equal(welcomeRetryPower(job,.012),0);
});
test('document grammar rejects code, extra fields, malformed and unauthorized scenes',()=>{
 assert.deepEqual(validateVisualDocument(doc,['chat']),doc);
 for(const bad of [{...doc,script:'fetch(secret)'},{...doc,scenes:[scene]},{...doc,scenes:[scene,scene]},{...doc,scenes:[scene,{...scene,id:'bad',capabilityIds:['foreign']}]}])assert.throws(()=>validateVisualDocument(bad,['chat']));
 const f={version:1 as const,nickname:'小张',purposes:[],platforms:[],localReady:false,features:[]};assert.equal(welcomeCapabilities(f).some(x=>x.id==='local'||x.id==='knowledge'),false);assert.throws(()=>parseWelcomeManual({...doc,title:'别人的说明'},f),/称呼/);
});
test('fixed hash, no arbitrary execution/network, tall complete exports, hostile strings rendered as text',()=>{
 const input={...doc,title:'<script>bad()</script>',scenes:doc.scenes.map(s=>({...s,feature:'长'.repeat(160),benefit:'益'.repeat(180)}))};
 const html=renderVisualPage(input),svg=renderVisualDiagram(input);
 assert.equal(visualScriptHash,createHash('sha256').update(visualPageRuntime).digest('base64'));assert.ok(visualPageCsp().includes(`script-src 'sha256-${visualScriptHash}'`));assert.match(visualPageCsp(),/connect-src 'none'/);assert.doesNotMatch(visualPageCsp(),/allow-same-origin|script-src 'unsafe-inline'/);
 assert.match(html,/&lt;script&gt;/);assert.equal(html.split('<script>').length,2);assert.doesNotMatch(svg,/<script/);assert.ok(visualDiagramHeight(input)>1000);assert.match(svg,new RegExp(`height="${visualDiagramHeight(input)}"`));
});
test('function calls require fresh authorization and return a real private file receipt',async()=>{
 let checks=0,saves=0;const t=visualTool('oneHtml','交互说明',async()=>{checks++;},async(d,f)=>{assert.equal(d.title,doc.title);assert.equal(f,'html');saves++;return {id:'owned',name:'说明.html'};});
 const result=await t.structured!.run(t.structured!.validate(doc));assert.equal((result as any).status,'completed');assert.equal(checks,2);assert.equal(saves,1);
 await assert.rejects(()=>visualTool('oneFlowchart','画图',async()=>{throw Error('Key lost');},async()=>{saves++;return {id:'x',name:'x'};}).structured!.run(doc),/Key lost/);assert.equal(saves,1);
 await assert.rejects(()=>visualTool('oneHtml','说明',async()=>{}).structured!.run(doc),/存储/);
});
