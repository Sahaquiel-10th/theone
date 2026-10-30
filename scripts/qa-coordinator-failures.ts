/** Local synthetic acceptance: real dispatch/state/receipt paths, no provider or production access. */
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import type {IncomingMessage} from 'node:http';
import type {Database,ModelConfig} from '../server/types.js';
import type {Store} from '../server/db.js';
import {CoordinatorService} from '../server/coordinatorService.js';
import {defaultTaskValues,updateTaskConfig} from '../server/aiTaskConfig.js';
import {getChatOperationResult} from '../server/chatOperations.js';
import {ModelRequestError,type ToolChatResult} from '../server/modelGateway.js';
import {classifyCoordinatorFailure} from '../server/coordinatorFailures.js';
import {coordinatorRecoveryCopy,parseCoordinatorFailure} from '../src/coordinatorRecovery.js';

if(process.env.ONE_SYNTHETIC_QA!=='1')throw Error('Set ONE_SYNTHETIC_QA=1 for this isolated local fixture.');
const scope={workspaceId:'qa-failure-workspace',userId:'qa-failure-user'};
const scenarios=['healthy','503','401','length','toolincomplete','power'] as const;
const faults=['none','drop_ack','get_outage','drop_ack_and_get','get_after_complete'] as const;
type Scenario=typeof scenarios[number];type Fault=typeof faults[number];
let scenario:Scenario='503',fault:Fault='none',readsBlocked=false,posts=0,modelCalls=0,droppedAcks=0,blockedReads=0,completedReceiptSeen=false;
const stamp=()=>new Date().toISOString();
const models=['qa-router','qa-worker'].map(id=>({id,name:id,provider:'fixture',protocol:'openai',baseUrl:'https://fixture.invalid',enabled:true,kind:'chat',apiKey:'synthetic-not-a-provider-credential',systemPrompt:'仅处理本轮隔离合成资料。',isDefault:id==='qa-worker',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1,createdAt:stamp()}) as ModelConfig);
let db={users:[{id:scope.userId,enabled:true,role:'user',defaultWorkspaceId:scope.workspaceId}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[scope],models,settings:{safetyRules:'只处理当前隔离合成空间；禁止生产数据和外部写入。',rechargeCnyPerPower:7},conversations:[],messages:[],chatOperations:[],knowledgeConnections:[],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[{...scope,id:'qa-failure-power',balanceMicros:100e6,reservedMicros:0}],powerLedger:[],attachments:[],executionTasks:[],executionEvents:[]} as unknown as Database;
for(const [kind,modelId] of [['coordinator','qa-router'],['task_worker','qa-worker']] as const){
 updateTaskConfig(db.settings,models,kind,{revision:0,action:'draft',values:{...defaultTaskValues(kind),modelId,...(kind==='coordinator'?{enabled:true}:{})}},scope.userId,stamp());
 updateTaskConfig(db.settings,models,kind,{revision:1,action:'publish'},scope.userId,stamp());
}
let mutation:Promise<unknown>=Promise.resolve();
const store:Store={read:async()=>structuredClone(db),mutate:<T>(fn:(current:Database)=>T)=>{
 const next=mutation.then(()=>{const draft=structuredClone(db),result=fn(draft);db=draft;return result;});mutation=next.catch(()=>{});return next;
}};
const answer=(content:string,finishReason:ToolChatResult['finishReason']='stop'):ToolChatResult=>({content,toolCalls:[],finishReason,usage:{inputTokens:100,outputTokens:100,totalTokens:200,source:'provider'}});
const service=new CoordinatorService(store,{recallWithDiagnostics:async()=>{throw Error('Synthetic fixture never reads private knowledge.');}},{
 modelCall:async()=>{
  modelCalls++;const selected=scenario;
  await new Promise(resolve=>setTimeout(resolve,120));
  if(selected==='503')throw new ModelRequestError(503,'synthetic provider unavailable');
  if(selected==='401')throw new ModelRequestError(401,'synthetic authentication rejected');
  if(selected==='length')return answer('【隔离合成正文】\n\n先把真实收到的文字保留下来。第一段讨论活动如何让参与者自然开口，第二段整理可执行的讨论顺序。\n\n这里是已经返回的结尾，后半部分尚未写完。','length');
  if(selected==='toolincomplete')return {...answer('已经保存到 Notion，原页面更新好了。','length'),toolCalls:[{id:'synthetic-cut-tool',type:'function',function:{name:'delegate_task',arguments:'{"taskId":null,"title":"截断合成任务"'}}]};
  return answer('【隔离合成正常回复】\n\n收到你的讨论要求。这是通过真实 CoordinatorService.dispatch 保存并返回的正文。模型传输为本地注入，没有调用真实模型，也没有写入 Notion 或本机文件。');
 },
});
const verify=async()=>{};
const metrics=()=>({scenario,fault,readsBlocked,posts,modelCalls,externalWrites:0,droppedAcks,blockedReads,completedReceiptSeen,operations:(db.chatOperations??[]).filter(op=>op.requestId.startsWith('coord_')).map(op=>({operationId:op.operationId,status:op.status,failure:parseCoordinatorFailure(op.failure),taskIds:op.dispatchedTaskIds??[]})),assistantMessages:db.messages.filter(message=>message.role==='assistant').length});
const client=`
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useCoordinator} from '/src/useCoordinator.ts';
import {api,expectUser} from '/src/oneApi.ts';
import {CoordinatorConversation} from '/src/preview/CoordinatorConversation.tsx';
import '/src/styles.css';
expectUser('qa-failure-user','qa-failure-workspace');
function App(){
 const c=useCoordinator(api,'qa-failure-user',true,'qa-failure-workspace');
 const [scenario,setScenario]=useState('503'),[fault,setFault]=useState('none'),[draft,setDraft]=useState('只讨论，直接回答：这是一条本地合成验收要求，不分派任务。'),[notice,setNotice]=useState(''),[metrics,setMetrics]=useState(null);
 useEffect(()=>{let live=true;const read=()=>fetch('/__qa/metrics').then(r=>r.json()).then(value=>{if(live)setMetrics(value);});void read();const timer=setInterval(read,500);return()=>{live=false;clearInterval(timer);};},[]);
 async function restoreReads(){await fetch('/__qa/restore-reads',{method:'POST'});setNotice('GET 读取已恢复，只核对原提交，不重发。');await c.refresh();}
 async function submit(event){event.preventDefault();setNotice('');try{await fetch('/__qa/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario,fault})});await c.submit({operationId:crypto.randomUUID(),text:draft,modelId:'qa-router'});setNotice('这次提交已交给真实调度服务；结果以原回执核对。');}catch(error){setNotice(error.message);}}
 return <main className="one-studio coordinator-preview" style={{height:'100vh',display:'grid',gridTemplateColumns:'minmax(520px,1fr) 360px',gap:24,padding:24,background:'#dce5e9',color:'#203947'}}>
 <section style={{display:'flex',flexDirection:'column',minHeight:0}}><h1>调度失败与恢复 · 隔离验收</h1><p>真实调度服务与组件；模型、账户和网络故障均为本地合成。外部写入为 0。</p>
 <div style={{flex:1,minHeight:0}}><CoordinatorConversation messages={c.state.dialogue} tasks={c.state.tasks} pending={!!c.state.pending} progress={c.progress} completed={c.settlement?.status==='completed'} onStop={c.stop} onOpen={()=>{}} onRestore={setDraft}/></div>
 <form style={{display:'grid',gap:12}} onSubmit={submit}>
 <label>原始要求<textarea aria-label="原始要求" value={draft} onChange={event=>setDraft(event.target.value)} rows={3} style={{width:'100%'}}/></label><button type="submit" disabled={!!c.state.pending}>发送合成要求</button></form>
 <p role="status">{c.state.pending?'正在等待或核对原提交':'本轮等待已结束'} · {notice}</p>{c.error?<p role="alert">{c.error}</p>:null}</section>
 <aside style={{overflow:'auto'}}><label>模型场景<select aria-label="模型场景" value={scenario} onChange={event=>setScenario(event.target.value)}><option value="503">模型 503</option><option value="401">模型 401</option><option value="length">可读截断正文</option><option value="toolincomplete">截断工具前言</option><option value="healthy">正常回复</option><option value="power">电力不足</option></select></label>
 <label>网络故障<select aria-label="网络故障" value={fault} onChange={event=>setFault(event.target.value)}><option value="none">无故障</option><option value="drop_ack">丢弃 POST 接收确认</option><option value="get_outage">POST 后暂断 GET</option><option value="drop_ack_and_get">丢确认并暂断 GET</option><option value="get_after_complete">完成回执后暂断 GET</option></select></label>
 <p>故障在下一次发送时启用；恢复读取不触发新模型调用。</p><button type="button" onClick={restoreReads}>恢复 GET 核对</button><button type="button" onClick={()=>void c.refresh()}>只读核对原结果</button>
 <pre aria-label="只读验收计数" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(metrics,null,2)}</pre></aside></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
async function body(req:IncomingMessage){let text='';for await(const part of req)text+=part;return text?JSON.parse(text):{};}
const vite=await createServer({configFile:false,plugins:[react(),{name:'real-dispatch-synthetic-failure-qa',resolveId(id){if(id==='/__qa/client.tsx')return id;},load(id){if(id==='/__qa/client.tsx')return client;},configureServer(server){server.middlewares.use(async(req,res,next)=>{
 const url=new URL(req.url!,'http://127.0.0.1');
 if(url.pathname==='/__qa/'){
  res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__qa/','<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>ONE 调度失败隔离验收</title></head><body><div id="root"></div><script type="module" src="/__qa/client.tsx"></script></body></html>'));return;
 }
 if(url.pathname==='/__qa/client.tsx'||!url.pathname.startsWith('/api/coordinator')&&!url.pathname.startsWith('/__qa/'))return next();
 const json=(value:unknown,status=200)=>{if(res.destroyed||res.writableEnded)return;res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
 try{
  if(url.pathname==='/__qa/metrics')return json(metrics());
  if(req.method==='POST'&&url.pathname==='/__qa/restore-reads'){readsBlocked=false;completedReceiptSeen=true;return json(metrics());}
  if(req.method==='POST'&&url.pathname==='/__qa/config'){
   const config=await body(req);if(!scenarios.includes(config.scenario)||!faults.includes(config.fault))throw Error('Invalid synthetic scenario');
   scenario=config.scenario;fault=config.fault;readsBlocked=false;completedReceiptSeen=false;
   await store.mutate(current=>{current.powerAccounts[0].balanceMicros=scenario==='power'?0:100e6;});return json(metrics());
  }
  if(req.method==='GET'&&url.pathname.startsWith('/api/coordinator')&&readsBlocked){blockedReads++;return json({error:'合成 GET 暂时断开，请使用本页恢复读取按钮。',failure:{code:'transport_unknown',stage:'receipt',outcome:'unknown'}},503);}
  if(req.method==='POST'&&url.pathname==='/api/coordinator/messages'){
   const input=await body(req);posts++;const acceptedFault=fault;
   const result=await service.dispatch(scope,input,verify,()=>{
    if(['get_outage','drop_ack_and_get'].includes(acceptedFault))readsBlocked=true;
    if(['drop_ack','drop_ack_and_get'].includes(acceptedFault)){droppedAcks++;res.destroy();}
    else json({status:'pending',operationId:input.operationId},202);
   });
   if(!res.headersSent&&!res.destroyed)json({status:'completed',...result});return;
  }
  if(req.method==='GET'&&url.pathname==='/api/coordinator')return json(await service.state(scope,1,verify));
  if(req.method==='GET'&&url.pathname==='/api/coordinator/history')return json(await service.history(scope,url.searchParams.get('before')));
  if(req.method==='GET'&&url.pathname.startsWith('/api/coordinator/messages/')){
   const operationId=decodeURIComponent(url.pathname.split('/').at(-1)!);
   const current=await store.read(),operation=current.chatOperations?.find(op=>op.workspaceId===scope.workspaceId&&op.userId===scope.userId&&op.operationId===operationId&&op.requestId.startsWith('coord_'));
   if(!operation)return json({error:'合成提交不存在',failure:{code:'receipt_not_found',stage:'receipt',outcome:'not_started'}},404);
   if(operation.status==='completed'){
    const result=getChatOperationResult(current,{...scope,operationId});
    json({status:'completed',operationId,...result,taskId:operation.dispatchedTaskId,taskIds:operation.dispatchedTaskIds});
    if(fault==='get_after_complete'&&!completedReceiptSeen){completedReceiptSeen=true;readsBlocked=true;}return;
   }
   return json({status:operation.status,operationId,failure:parseCoordinatorFailure(operation.failure),progress:service.currentProgress(scope,operationId)});
  }
  if(req.method==='GET'&&url.pathname.startsWith('/api/coordinator/tasks/'))return json(await service.task(scope,decodeURIComponent(url.pathname.split('/').at(-1)!)));
  if(req.method==='POST'&&url.pathname==='/api/coordinator/resume')return json(await service.resume(scope,verify));
  if(req.method==='POST'&&url.pathname==='/api/coordinator/reports'){const input=await body(req);return json(await service.report(scope,input.ids,verify));}
  if(req.method==='POST'&&url.pathname==='/api/coordinator/notices/read'){const input=await body(req);await service.acknowledge(scope,input.ids);return json({ok:true});}
  if(req.method==='POST'&&/^\/api\/coordinator\/messages\/[^/]+\/stop$/.test(url.pathname))return json(await service.cancel(scope,decodeURIComponent(url.pathname.split('/').at(-2)!),verify));
  return json({error:'Unknown isolated fixture route'},404);
 }catch(error){const failure=classifyCoordinatorFailure(error,{stage:req.method==='GET'?'receipt':'accepting',outcome:'unknown'});json({error:coordinatorRecoveryCopy(failure),failure},(error as {status?:number})?.status??400);}
});}}],server:{host:'127.0.0.1',port:4403,strictPort:true}});
await vite.listen();
process.stdout.write('Real-dispatch synthetic failure QA: http://127.0.0.1:4403/__qa/\n');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void vite.close().finally(()=>process.exit(0));});
