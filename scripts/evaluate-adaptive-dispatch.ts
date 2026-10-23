import 'dotenv/config';
import mysql from 'mysql2/promise';
import {parseArgs} from 'node:util';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CoordinatorService} from '../server/coordinatorService.js';
import {decryptCredential} from '../server/knowledge/credentialCipher.js';
import {callModelWithTools} from '../server/modelGateway.js';
import {effectiveModel} from '../server/modelPricing.js';
import {calculateModelPower} from '../server/powerBilling.js';
import {inputProfile} from '../server/oneContext.js';
import type {ModelConfig} from '../server/types.js';
import {dispatchFixture,evalScope} from './eval/dispatchFixture.js';

/** Public synthetic paired experiment only. No production Store import, no
 * customer history/knowledge/ledger writes, no automatic task/provider retry. */
const {values}=parseArgs({strict:true,allowPositionals:false,options:{'run-public-pairs':{type:'boolean'},'model-id':{type:'string'},cases:{type:'string'}}});
if(!values['run-public-pairs']||!values['model-id']||!/^[A-Za-z0-9_-]{1,100}$/.test(values['model-id'])||process.env.DB_PROVIDER!=='mysql')throw Error('explicit model and paired probe required');
const connection=await mysql.createConnection({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT??3306),user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,database:process.env.MYSQL_DATABASE});
let native:ModelConfig;
try{
 const [rows]=await connection.execute<mysql.RowDataPacket[]>('SELECT record_json FROM models WHERE id=? LIMIT 1',[values['model-id']]);
 const record=rows[0]?.record_json,model=typeof record==='string'?JSON.parse(record):record;
 if(!model?.enabled||model.kind!=='chat')throw Error('enabled chat model required');
 native={...effectiveModel(model),pricingHistory:undefined,apiKey:model.encryptedApiKey?decryptCredential(model.encryptedApiKey):model.apiKey,systemPrompt:''};
}finally{await connection.end();}
const cases=[
 {id:'weather',text:'请联网查杭州今天天气，用一句话回答并附来源，不要创建任务。'},
 {id:'history',text:'蓝桥活动之前说的人数、总预算、文件限制分别是什么？只回答，不要开始任务。'},
 {id:'continuation',text:'继续这个任务：补一句雨天备选，不要改原有要求。'},
 {id:'combined',text:'请联网查杭州今天天气，然后做一份能打开的出行建议网页，分晴天安排和雨天备选两个场景；不要生图，不要操作本机。这是独立合成验收，不要重跑旧任务。'},
];
const selected=values.cases?.split(',');
if(selected&&(!selected.length||selected.some(id=>!cases.some(c=>c.id===id))))throw Error('unknown paired case');
const results=[];
for(const [index,scenario] of cases.entries())if(!selected||selected.includes(scenario.id))for(const contextMode of index%2?['adaptive','legacy'] as const:['legacy','adaptive'] as const){
 const f=dispatchFixture(),directory=await mkdtemp(path.join(tmpdir(),'one-adaptive-public-'));
 await f.store.mutate(db=>{
  db.models=[{...native,id:'eval-model',isDefault:true}];
  db.users[0].contextPreferences=[{...evalScope,timeZone:'Asia/Shanghai',city:'杭州'}];
  const target=db.conversations.find(c=>c.id==='old-task-0')!;
  target.messages[0].content='蓝桥活动：42人，总预算900元。整理一份活动安排文字，不覆盖已有文件；不联网、不写外部平台。';
  target.title='蓝桥活动安排';
  const feature={name:'合成交互网页',author:'ONE',description:'生成可打开的私有HTML网页，适合攻略与两场景说明。',instructions:'调用 oneHtml 交付真实网页，不要只返回代码或承诺。使用本次已取得的天气，不要重复搜索；不要生图。',limitations:'仅合成资料，不发布分享，不访问本机或知识。',integration:'question_answer' as const,modelId:'eval-model',knowledgeMode:'none' as const,usageMultiplier:1,tools:[{id:'oneHtml',description:'交付HTML网页'}]};
  const version={version:1,values:feature,evidence:'synthetic eval',approvedBy:'eval-admin',approvedAt:'2026-10-23T00:00:00Z'};
  db.settings.officialFeatures=[{id:'eval-html',revision:1,draft:feature,status:'approved',current:version,history:[version],release:{id:'eval-html-release',version:1,userIds:[evalScope.userId],publishedAt:'2026-10-23T00:00:00Z',publishedBy:'eval-admin'}}];
 });
 let calls=0,searches=0,usageMicros=0,totalBytes=0,firstBytes=0;const toolCalls:string[]=[],profiles:unknown[]=[];const started=Date.now();
 const service=new CoordinatorService(f.store,{recallWithDiagnostics:async()=>{throw Error('private knowledge not permitted');}},{contextMode,artifactDirectory:directory,
  webSearch:async()=>{searches++;return [{title:'公开合成天气测试数据',url:'https://example.com/synthetic-weather',snippet:'这是合成测试，不是真实天气。杭州：晴，22度；雨天备选为室内活动。'}];},
  modelCall:async(model,messages,tools,requestId,options)=>{
   calls++;if(calls>10)throw Error('synthetic case model-call ceiling reached');
   const profile=inputProfile({messages,tools},evalScope.workspaceId)!;if(!firstBytes)firstBytes=profile.totalBytes;totalBytes+=profile.totalBytes;
   const result=await callModelWithTools(model,messages,tools,requestId,{...options,timeoutMs:60000});
   if(!result.usage)throw Error('missing provider usage');
   usageMicros+=calculateModelPower(model,result.usage.inputTokens,result.usage.outputTokens,result.usage.cacheUsage).chargedMicros;
   toolCalls.push(...result.toolCalls.map(t=>t.function.name));profiles.push({inputTokens:result.usage.inputTokens,outputTokens:result.usage.outputTokens,cache:result.usage.cacheUsage,finishReason:result.finishReason,offered:tools.map(t=>t.function.name),called:result.toolCalls.map(t=>t.function.name),syntheticReply:result.content.slice(0,700)});
   return result;
  }
 });
 let passed=false,error=false,reply='',taskId:string|undefined;
 try{
  const response=await service.dispatch(evalScope,{operationId:`public_pair_${scenario.id}_${contextMode}`,text:scenario.text,budget:10,webSearch:['weather','combined'].includes(scenario.id),...(scenario.id==='continuation'?{boundTaskId:'old-task-0'}:{})},async()=>{});
  reply=response.message.content;taskId=response.taskId;
  if(taskId){await service.resume(evalScope,async()=>{});const deadline=Date.now()+180000;
   while(Date.now()<deadline){const db=await f.store.read(),job=db.chatOperations!.find(o=>o.workRun&&o.conversationId===taskId)?.workRun;if(job&&['completed','failed','needs_input','cancelled'].includes(job.state))break;await new Promise(resolve=>setTimeout(resolve,100));}
  }
  const db=await f.store.read(),jobs=db.chatOperations!.filter(o=>o.workRun),files=db.attachments.filter(f=>f.conversationId===taskId);
  if(scenario.id==='weather')passed=searches===1&&!taskId&&/22/.test(reply)&&reply.includes('https://example.com/synthetic-weather');
  if(scenario.id==='history')passed=!taskId&&/42/.test(reply)&&/900/.test(reply)&&/不.{0,4}覆盖/.test(reply);
  if(scenario.id==='continuation')passed=taskId==='old-task-0'&&jobs.length===1&&jobs[0].workRun?.state==='completed'&&/42/.test(jobs[0].workRun.instruction)&&/900/.test(jobs[0].workRun.instruction)&&/不.{0,4}覆盖/.test(jobs[0].workRun.instruction);
  if(scenario.id==='combined'){
   const html=files.find(f=>f.originalName.endsWith('.html'));const bytes=html?await readFile(html.storagePath,'utf8'):'';
   passed=searches>=1&&jobs.length===1&&jobs[0].workRun?.state==='completed'&&!!html&&/22/.test(bytes)&&!toolCalls.includes('generate_image')&&!toolCalls.includes('execute_local_task');
  }
 }catch{error=true;}
 const db=await f.store.read();
 const row={scenario:scenario.id,mode:contextMode,passed,error,calls,searches,toolCalls,firstBytes,totalBytes,usageComplete:profiles.length===calls,knownUsageMicros:usageMicros,retailEquivalentMicros:profiles.length===calls?usageMicros:null,isolatedLedgerMicros:db.modelUsageRecords.reduce((n,r)=>n+(r.chargedMicros??0),0),durationMs:Date.now()-started,profiles,syntheticReply:reply.slice(0,600),steps:db.contextTraces.flatMap(t=>t.executionSteps??[]).map(t=>({tool:t.tool,status:t.status,result:t.status==='rejected'?t.resultPreview:undefined})),jobs:db.chatOperations!.filter(o=>o.workRun).map(o=>({state:o.workRun!.state,failureCode:o.workRun!.failureCode,instruction:o.workRun!.instruction.slice(0,800)})),artifacts:db.attachments.map(f=>({kind:f.kind,bytes:f.size})),accountCharged:false};
 results.push(row);console.log(JSON.stringify({event:'public_adaptive_pair_result',...row}));
}
console.log(JSON.stringify({event:'public_adaptive_pair_summary',baselineCommit:'51ad5ee',singlePairPerCase:true,alternatingOrder:true,deterministicWeatherAdapter:true,results:results.map(({profiles,...row})=>row),accountCharged:false}));
if(results.some(r=>r.mode==='adaptive'&&!r.passed))process.exitCode=1;
