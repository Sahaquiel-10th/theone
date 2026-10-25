/** Local-only synthetic acceptance: real routes/service/hook and Notion writer, fake remote edges. */
import assert from 'node:assert/strict';
import express from 'express';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import type {Database,ModelConfig} from '../server/types.js';
import type {Store} from '../server/db.js';
import type {ToolChatResult,ModelToolMessage} from '../server/modelGateway.js';
import type {NotionMcpService} from '../server/knowledge/notionMcpService.js';
import {NotionDocuments} from '../server/notionDocuments.js';
import {installCoordinatorRoutes} from '../server/coordinatorRoutes.js';
import {defaultTaskValues,updateTaskConfig} from '../server/aiTaskConfig.js';

if(process.env.ONE_SYNTHETIC_QA!=='1')throw Error('Set ONE_SYNTHETIC_QA=1; this fixture is not a production server.');
const verifyScenario=process.env.ONE_QA_NOTION_VERIFY==='1';
const verifyBody='## 保存核对隔离验收\n\n**方案已写完**，不用重写。\n\n> 等待核对，不等待再次确认。\n\n| 阶段 | 结果 |\n|---|----|\n| 写入 | 一次 |\n\n最后一行：青色42。';
const scope={workspaceId:'qa-continuation-workspace',userId:'qa-continuation-user'};
const parentId='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',pageId='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const title=verifyScenario?'保存核对 · 隔离验收':'启动器说明 · 隔离验收',first='第一行：小小启动器，插上就能找到 ONE。',second='第二行：初稿',revised='第二行：修订稿';
const initial='请在 Notion 草稿目录写一篇启动器说明。只用我随后补充的素材，不查知识库。缺素材就先问我，不能编。';
const supplement=`素材补充：小小启动器，插上就能找到 ONE。不要新建任务，只继续同一件，按原要求实际写入 Notion。正文只写两行：\n${first}\n${second}`;
const revision=`不要新建任务，只继续同一件。只把“${second}”改成“${revised}”，实际更新原来的 Notion 草稿，其余不动。`;
const models=['router','worker'].map(id=>({id,name:id,enabled:true,kind:'chat',apiKey:'fixture-only',systemPrompt:'',isDefault:id==='worker',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1}) as ModelConfig);
let db={users:[{id:scope.userId,enabled:true,role:'admin'}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[scope],models,settings:{safetyRules:'仅使用本轮合成资料',rechargeCnyPerPower:7},conversations:[],messages:[],chatOperations:[],knowledgeConnections:[{id:'qa-notion',workspaceId:scope.workspaceId,provider:'notion',status:'connected',clientId:'synthetic',createdAt:'now',updatedAt:'now',notionWriting:{grantId:'qa-grant',userId:scope.userId,authorizedAt:'now',parentId}}],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[{...scope,id:scope.userId,balanceMicros:100e6,reservedMicros:0}],powerLedger:[],attachments:[],executionTasks:[]} as unknown as Database;
for(const kind of ['coordinator','task_worker'] as const){
 updateTaskConfig(db.settings,models,kind,{revision:0,action:'draft',values:{...defaultTaskValues(kind),modelId:kind==='coordinator'?'router':'worker',enabled:true}},scope.userId,'now');
 updateTaskConfig(db.settings,models,kind,{revision:1,action:'publish'},scope.userId,'now');
}
let chain:Promise<unknown>=Promise.resolve();
const store={read:async()=>structuredClone(db),mutate:<T>(fn:(value:Database)=>T)=>{
 const next=chain.then(()=>{const draft=structuredClone(db),result=fn(draft);db=draft;return result;});chain=next.catch(()=>{});return next;
}} as Store;
let body='',posts=0,mainPosts=0,directPosts=0,creates=0,updates=0,reads=0,scopeChecks=0,manualRestarts=0,foreignRequestsBlocked=0,readbackAttempts=0;
const observedVerificationStates=new Set<string>();
const workerRequests=new Map<string,number>(),modelCalls:{model:string;requestId:string;tools:string[]}[]=[];
const answer=(content:string):ToolChatResult=>({content,finishReason:'stop',toolCalls:[],usage:{inputTokens:10,outputTokens:10,totalTokens:20,source:'provider'}});
const tool=(name:string,args:unknown):ToolChatResult=>({...answer(''),toolCalls:[{id:'synthetic-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const mcp={
 readDocument:async(workspaceId:string,id:string)=>{
  assert.equal(workspaceId,scope.workspaceId);assert.ok(id===parentId||id===pageId);scopeChecks++;reads++;
  assert.ok(id===parentId||body,'A child page must have really been created.');
  if(verifyScenario&&id===pageId){
   readbackAttempts++;
   if(readbackAttempts<=2)throw Error('Synthetic readback temporarily unavailable after one successful write.');
   return {text:body.replace('**方案已写完**','<b>方案已写完</b>').replace('> 等待核对，不等待再次确认。','<quote>\n等待核对，不等待再次确认。\n</quote>').replace('|---|----|','| --- | --- |')};
  }
  return {text:id===parentId?'合成草稿保存目录':body};
 },
 callDocumentTool:async(workspaceId:string,connectionId:string,grantId:string,userId:string,name:string,args:any,beforeSend?:()=>Promise<void>)=>{
  assert.deepEqual([workspaceId,connectionId,grantId,userId],[scope.workspaceId,'qa-notion','qa-grant',scope.userId]);scopeChecks++;
  assert.equal(typeof beforeSend,'function','Exercise the real authorization/write checkpoint.');
  await beforeSend!();
  if(name==='notion-create-pages'){
   assert.equal(args.parent.page_id,parentId);assert.equal(creates,0,'Continuation cannot create a second page.');
   assert.equal(args.pages.length,1);creates++;body=args.pages[0].content;return {pages:[{id:pageId}]};
  }
  assert.equal(name,'notion-update-page');assert.equal(args.page_id,pageId);assert.equal(creates,1);
  assert.equal(args.content_updates.length,1);const change=args.content_updates[0];assert.equal(body.split(change.old_str).length,2);
  updates++;body=body.replace(change.old_str,change.new_str);return {id:pageId};
 }
} as unknown as NotionMcpService;
const notionDocuments=new NotionDocuments(store,mcp);
const deps={notionDocuments,modelCall:async(model:ModelConfig,messages:ModelToolMessage[],tools:any[],requestId='synthetic-missing-request')=>{
 modelCalls.push({model:model.id,requestId,tools:tools.map(t=>t.function.name)});
 if(model.id==='router'){
  const last=messages.at(-1),readReturned=last?.role==='tool'&&last.tool_call_id==='synthetic-read_task';
  if(last?.role==='tool'&&!readReturned)return answer(verifyScenario?'方案写好后，我会自动核对保存，并把结果放在这里。':'我先处理这篇专栏；缺什么或完成了，直接在这里告诉你。');
  if(!tools.some(t=>t.function.name==='delegate_task'))return answer('按实际结果说明，未完成的部分请直接补充素材。');
  const reference=messages.find(m=>m.content?.startsWith('本轮授权参考：'))?.content;
  assert.ok(reference,'Use the real coordinator capability context.');const catalog=JSON.parse(reference.slice('本轮授权参考：'.length));
  const current=messages.filter(m=>m.role==='user').at(-1)?.content||'';
  const taskId=catalog.boundTaskId||catalog.tasks[0]?.id||null;
  // The deterministic model obeys the real existing-task read gate; its
  // successful handler, not this fixture, establishes inspected task state.
  if(taskId&&!readReturned)return tool('read_task',{query:taskId});
  return tool('delegate_task',{taskId,title,instruction:current,executorId:'general',featureIds:[]});
 }
 assert.equal(model.id,'worker');
 let attempt=workerRequests.get(requestId);if(!attempt){attempt=workerRequests.size+1;workerRequests.set(requestId,attempt);}
 if(verifyScenario){
  assert.equal(workerRequests.size,1,'Read-only verification must not start another worker.');
  if(messages.at(-1)?.role==='tool')return answer(JSON.stringify({outcome:'completed',content:body,summary:'方案已保存。'}));
  return tool('save_notion_draft',{title:'保存核对 · 隔离验收',content:verifyBody,final:true});
 }
 if(messages.at(-1)?.role==='tool')return answer(JSON.stringify({outcome:'completed',content:body,summary:updates?'第二行已修改，其余保持原样。':'两行说明已保存并回读。'}));
 if(attempt===1)return answer(JSON.stringify({outcome:'needs_input',content:'还缺启动器的素材。请直接补充一两句素材，我接着写。',summary:'还缺启动器素材。请直接补充一两句。'}));
 assert.match(JSON.stringify(messages),/小小启动器/,'The actual resumed execution must receive new material.');
 assert.ok(tools.some(t=>t.function.name==='save_notion_draft'));
 return tool('save_notion_draft',body?{old_str:second,new_str:revised,final:true}:{title,content:`${first}\n${second}`,final:true});
},reportCall:async()=>answer(updates?'第二行已改好，并已回读同一篇 Notion。':'两行说明已保存，并已回读核对。')};

const app=express();app.use(express.json({limit:'100kb'}));
const auth:express.RequestHandler=(req,res,next)=>{
 if(req.get('X-ONE-User')!==scope.userId||req.get('X-ONE-Workspace')!==scope.workspaceId){foreignRequestsBlocked++;res.status(403).json({error:'Synthetic scope mismatch'});return;}
 req.user=db.users[0];req.workspaceId=scope.workspaceId;next();
};
app.use('/api/coordinator',(req,_res,next)=>{if(req.method==='POST'){
 if(req.path==='/messages'){posts++;mainPosts++;}else if(/^\/tasks\/[^/]+\/messages$/.test(req.path)){posts++;directPosts++;}
 if(req.path.endsWith('/retry')||req.path==='/resume'&&req.body?.continueTaskId)manualRestarts++;
}next();});
const verify=async(req:express.Request)=>{assert.equal(req.user?.id,scope.userId);assert.equal(req.workspaceId,scope.workspaceId);};
installCoordinatorRoutes(app,[auth],[auth],store,verify,{recallWithDiagnostics:async()=>{throw Error('Knowledge recall is forbidden in this synthetic fixture.');}},deps);
app.post('/api/features/quote',auth,(_req,res)=>res.json({approvalThreshold:2,features:[]}));
function metrics(){
 const tasks=db.conversations.filter(c=>!c.coordinatorMain),jobs=db.chatOperations?.filter(o=>o.workRun)||[];
 for(const o of jobs){const verification=o.workRun?.notionReceipt?.verification;if(verification)observedVerificationStates.add(verification.state);}
 return {verifyScenario,posts,mainPosts,directPosts,create:creates,update:updates,read:reads,readbackAttempts,verificationStates:[...observedVerificationStates],attempts:workerRequests.size,scopeChecks,foreignRequestsBlocked,manualRestarts,taskCount:tasks.length,pageCount:creates,pageId:tasks[0]?.notionDocument?.pageId,body,
  tasks:tasks.map(c=>({id:c.id,paused:c.workPaused,pauseReason:c.workPauseReason})),jobs:jobs.map(o=>({id:o.id,operationId:o.operationId,state:o.workRun?.state,outcome:o.workRun?.resultOutcome,failureCode:o.workRun?.failureCode,receipt:o.workRun?.notionReceipt?.state})),
  main:db.conversations.find(c=>c.coordinatorMain)?.messages.map(m=>({role:m.role,content:m.content})),modelCalls,
  passed:verifyScenario?posts===1&&creates===1&&updates===0&&workerRequests.size===1&&tasks.length===1&&manualRestarts===0&&readbackAttempts>=3&&body===verifyBody&&jobs.at(-1)?.workRun?.state==='completed'&&jobs.at(-1)?.workRun?.notionReceipt?.state==='verified'&&observedVerificationStates.has('scheduled'):
  posts===3&&creates===1&&updates===1&&workerRequests.size===3&&tasks.length===1&&manualRestarts===0&&body===`${first}\n${revised}`&&jobs.at(-1)?.workRun?.notionReceipt?.state==='verified'};
}
app.get('/__qa/metrics',(_req,res)=>res.setHeader('Cache-Control','no-store').json(metrics()));
const client=`
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useCoordinator} from '/src/useCoordinator.ts';
import {api,expectUser} from '/src/oneApi.ts';
import {CoordinatorConversation} from '/src/preview/CoordinatorConversation.tsx';
import '/src/styles.css';
expectUser(${JSON.stringify(scope.userId)},${JSON.stringify(scope.workspaceId)});
const words=${JSON.stringify({initial:verifyScenario?'仅用以下合成内容写一份 Notion 草稿并核对保存，不查知识库，不做其他任务。正文：\n'+verifyBody:initial,supplement,revision})};
const verifyScenario=${JSON.stringify(verifyScenario)};
function App(){
 const c=useCoordinator(api,${JSON.stringify(scope.userId)},true,${JSON.stringify(scope.workspaceId)}),[m,setMetrics]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useEffect(()=>{const read=()=>fetch('/__qa/metrics').then(r=>r.json()).then(setMetrics);void read();const id=setInterval(read,600);return()=>clearInterval(id);},[]);
 const run=async(step)=>{setBusy(true);setError('');try{const id=m?.tasks[0]?.id;
  if(step==='revision')await c.direct(id,words.revision,[],'notion');
  else await c.submit({operationId:crypto.randomUUID(),text:words[step],...(step==='supplement'?{boundTaskId:id}:{}),outputDestination:'notion'});
 }catch(e){setError(e.message);}finally{setBusy(false);}};
 return <main className="one-studio coordinator-preview" style={{height:'100vh',display:'grid',gridTemplateColumns:'minmax(450px,1fr) 390px',gap:24,padding:24,background:'#dce5e9',color:'#203947'}}>
 <section style={{display:'flex',flexDirection:'column',minHeight:0}}><h1>{verifyScenario?'延迟只读核对 · 隔离验收':'同一任务自动续做 · 隔离验收'}</h1><small>真实生产路由与写入逻辑；模型、Notion 远端均为本地合成边界。</small>
 <CoordinatorConversation messages={c.state.dialogue} tasks={c.state.tasks} pending={!!c.state.pending} progress={c.progress} completed={c.settlement?.status==='completed'} onOpen={id=>void c.load(id)}/>
 {error||c.error?<p role="alert">{error||c.error}</p>:null}
 <div><button disabled={busy||!!c.state.pending||!!m?.taskCount} onClick={()=>run('initial')}>{verifyScenario?'提交一次，写入后前两次回读失败':'1 发起缺材料任务'}</button>
 {!verifyScenario?<>
 <button disabled={busy||!!c.state.pending||m?.jobs.at(-1)?.outcome!=='needs_input'||m?.create!==0} onClick={()=>run('supplement')}>2 主对话补充素材</button>
 <button disabled={busy||m?.create!==1||m?.update!==0||m?.jobs.at(-1)?.state!=='completed'} onClick={()=>run('revision')}>3 任务内改第二行</button></>:null}</div>
 <p role="status">{m?.passed?verifyScenario?'通过：只提交一次、只写一次、一个执行任务，自动延迟核对与主对话收尾，无需手点继续。':'通过：同任务、同页面、创建一次＋修改一次，均已回读，无需开始/重试。':busy?'正在提交本轮要求…':verifyScenario?'提交一次后等待自动核对，不要点重试。':'按 1 → 2 → 3 操作，等待上一轮结果出现后再点下一步。'}</p></section>
 <aside style={{overflow:'auto'}}><h2>只读验收计数</h2><pre aria-label="验收计数">{JSON.stringify(m,null,2)}</pre></aside></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const vite=await createServer({configFile:false,plugins:[react(),{name:'synthetic-task-continuation',resolveId(id){if(id==='/__qa/client.tsx')return id;},load(id){if(id==='/__qa/client.tsx')return client;}}],server:{middlewareMode:true,host:'127.0.0.1'},appType:'custom'});
app.get('/__qa/',async(_req,res,next)=>{try{res.type('html').send(await vite.transformIndexHtml('/__qa/','<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>ONE 自动续做隔离验收</title></head><body><div id="root"></div><script type="module" src="/__qa/client.tsx"></script></body></html>'));}catch(error){next(error);}});
app.use(vite.middlewares);
app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{console.error(error);res.status(error.status||500).json({error:error.message||'Synthetic fixture failure'});});
const port=Number(process.env.ONE_QA_CONTINUATION_PORT||4401);
const server=app.listen(port,'127.0.0.1',()=>process.stdout.write(`Synthetic continuation QA: http://127.0.0.1:${port}/__qa/\n`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{server.close();void vite.close().finally(()=>process.exit(0));});
