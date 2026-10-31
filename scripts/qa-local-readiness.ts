/** Isolated browser acceptance. Real routes, dispatch and UI; synthetic device/model only. */
import express from 'express';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import type {Database,ModelConfig} from '../server/types.js';
import type {Store} from '../server/db.js';
import {installCoordinatorRoutes} from '../server/coordinatorRoutes.js';
import {defaultTaskValues,updateTaskConfig} from '../server/aiTaskConfig.js';
import {executorDefaults,updateExecutor} from '../server/executorProfiles.js';
import type {ToolChatResult} from '../server/modelGateway.js';
import type {LocalDeviceReadiness} from '../src/localDeviceReadiness.js';

if(process.env.ONE_SYNTHETIC_QA!=='1')throw Error('This synthetic fixture requires ONE_SYNTHETIC_QA=1.');
const scope={userId:'qa-local-user',workspaceId:'qa-local-workspace'};
const stamp=()=>new Date().toISOString();
const scenarios=['ready','offline','unselected','folder_unavailable','executor_unprepared','busy'] as const;
let device:typeof scenarios[number]='ready',mode='question',modelCalls=0,localAcceptances=0,readinessReads=0,folderChanges=0,posts=0;
const models=['qa-router','qa-worker'].map(id=>({id,name:id,provider:'fixture',protocol:'openai',baseUrl:'https://fixture.invalid',enabled:true,kind:'chat',apiKey:'synthetic-not-a-provider-credential',systemPrompt:'仅处理当前隔离合成要求。',isDefault:id==='qa-worker',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1,createdAt:stamp()}) as ModelConfig);
let database={users:[{id:scope.userId,enabled:true,role:'user',defaultWorkspaceId:scope.workspaceId}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[scope],models,settings:{safetyRules:'隔离测试，不得访问生产、真实文件或外部模型。',rechargeCnyPerPower:7},conversations:[],messages:[],chatOperations:[],knowledgeConnections:[],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[{...scope,id:'qa-local-power',balanceMicros:100e6,reservedMicros:0}],powerLedger:[],attachments:[{...scope,id:'qa-template',originalName:'synthetic-template.png',kind:'image',mimeType:'image/png',size:1,status:'ready',storagePath:'/synthetic-never-read/template.png',extractedText:'',createdAt:stamp()}],executionTasks:[],executionEvents:[]} as unknown as Database;
for(const [kind,modelId] of [['coordinator','qa-router'],['task_worker','qa-worker'],['codex_execution','qa-worker']] as const){
 updateTaskConfig(database.settings,models,kind,{revision:0,action:'draft',values:{...defaultTaskValues(kind),modelId,...(kind==='coordinator'?{enabled:true}:{})}},scope.userId,stamp());
 updateTaskConfig(database.settings,models,kind,{revision:1,action:'publish'},scope.userId,stamp());
}
database.users[0].role='admin';
const logic=updateExecutor(database,'qa-local-user',undefined,{revision:0,action:'draft',values:{...executorDefaults(),name:'合成本机交接',modelId:'qa-worker',routingRole:'logic'}});
updateExecutor(database,'qa-local-user',logic.id,{revision:1,action:'publish'});
database.users[0].role='user';
let mutation:Promise<unknown>=Promise.resolve();
const store:Store={read:async()=>structuredClone(database),mutate:<T>(fn:(current:Database)=>T)=>{
 const next=mutation.then(()=>{const draft=structuredClone(database),result=fn(draft);database=draft;return result;});mutation=next.catch(()=>{});return next;
}};
function readiness():LocalDeviceReadiness {
 const connected=device!=='offline',folderState=device==='unselected'?'unselected':device==='folder_unavailable'?'unavailable':connected?'ready':'unknown';
 const executorState=device==='executor_unprepared'?'unprepared':device==='busy'?'busy':connected?'ready':'unknown';
 const reason=device==='ready'?'ready':device==='unselected'?'folder_unselected':device;
 return {checkedAt:stamp(),ready:device==='ready',connected,folder:{state:folderState,...(folderState==='ready'?{targetName:'/synthetic/authorized-folder'}:{})},executor:{state:executorState,...(executorState==='ready'?{installedVersion:'0.160.1',installedSource:'managed' as const}:{})},reason} as LocalDeviceReadiness;
}
const answer=(content:string):ToolChatResult=>({content,toolCalls:[],finishReason:'stop',usage:{inputTokens:50,outputTokens:50,totalTokens:100,source:'provider'}});
const app=express();app.use(express.json());
app.use((req,_res,next)=>{(req as any).user={id:scope.userId};(req as any).workspaceId=scope.workspaceId;(req as any).oneKeyDeviceId='qa-device';(req as any).oneKeyInstallationId='qa-installation';next();});
const metrics=()=>({device,mode,posts,modelCalls,localAcceptances,readinessReads,folderChanges,externalModelCalls:0,actualDiskWrites:0,operations:database.chatOperations.map(operation=>({id:operation.operationId,status:operation.status,failure:operation.failure,local:Boolean(operation.workRun?.state==='prepared')}))});
app.get('/__qa/metrics',(_req,res)=>res.json(metrics()));
app.post('/__qa/config',(req,res)=>{if(!scenarios.includes(req.body.device)||!['question','execute','wrapper','no_dispatch','attachment'].includes(req.body.mode))return res.status(400).json({error:'Unknown synthetic mode'});device=req.body.device;mode=req.body.mode;res.json(metrics());});
app.get('/api/me/local-device/readiness',(_req,res)=>{readinessReads++;res.setHeader('Cache-Control','no-store');res.json(readiness());});
app.get('/api/me/local-device',(_req,res)=>res.json({targetName:readiness().folder.targetName}));
app.post('/api/me/local-device',(_req,res)=>{folderChanges++;res.json({targetName:'/synthetic/authorized-folder'});});
app.get('/api/me/executor',(_req,res)=>res.json({available:device!=='offline',installedVersion:device==='executor_unprepared'?undefined:'0.160.1',installedSource:'managed',version:'0.160.1'}));
app.get('/api/knowledge/connections/notion/writing',(_req,res)=>res.json({connected:false,writeAuthorized:false,ready:false,parentId:'',referenceIds:[]}));
app.get('/api/attachments/qa-template',(_req,res)=>res.json({attachment:{id:'qa-template',originalName:'synthetic-template.png',kind:'image',mimeType:'image/png',status:'ready',size:1}}));
app.use('/api/coordinator/messages',(req,_res,next)=>{if(req.method==='POST')posts++;next();});
installCoordinatorRoutes(app,[(_req,_res,next)=>next()],[(_req,res)=>{res.status(403).json({error:'No admin operations in this fixture.'});}],store,async()=>{}, {recallWithDiagnostics:async()=>{throw Error('No knowledge access in this synthetic fixture.');}}, {
 inspectLocalReadiness:async()=>readiness(),
 executeLocal:async()=>{localAcceptances++;return{id:`qa-local-execution-${localAcceptances}`,status:'queued'};},
 modelCall:async(_model,messages,tools)=>{
  modelCalls++;
  if(mode==='question')return answer('接收记录是这次要求是否被系统接到的凭据。这里只解释，不操作电脑，也不需要重新配置文件夹。');
  if(mode==='no_dispatch')return answer('我正在检查目录。');
  if(messages.at(-1)?.role==='tool')return answer('这条合成本机要求已交接。此页面仅模拟设备接收，不声称真实文件已经生成。');
  const name=mode==='wrapper'?'delegate_task':'execute_local_task';
  if(!tools.some(tool=>tool.function.name===name))return answer('这轮没有可用的本机交接工具，尚未操作文件。');
  return {...answer(''),toolCalls:[{id:`qa-local-tool-${modelCalls}`,type:'function',function:{name,arguments:JSON.stringify({taskId:null,title:'隔离本机验收',instruction:'仅在已授权的默认工作文件夹内创建合成验收文档，不读取无关内容，不联网、不覆盖已有文件。',executorId:'general',...(mode==='wrapper'?{capabilityIds:['builtin:codex_execution']}:{})})}}]};
 },
});
const client=`
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api,expectUser,ApiError} from '/src/oneApi.ts';
import {useCoordinator} from '/src/useCoordinator.ts';
import {CoordinatorConversation} from '/src/preview/CoordinatorConversation.tsx';
import {LocalDeviceSettings} from '/src/LocalDeviceSettings.tsx';
import {DocumentDestinationPicker} from '/src/DocumentDestination.tsx';
import {refreshLocalDeviceReadiness} from '/src/localDeviceReadinessStore.ts';
import '/src/styles.css';
expectUser('qa-local-user','qa-local-workspace');
let dropNext=false,blockReads=false;
const qaApi=async(path,options)=>{
 if(blockReads&&path.startsWith('/api/coordinator')&&options?.method!=='POST')throw new ApiError('合成网络暂时断开',undefined,503);
 const result=await api(path,options);
 if(path==='/api/coordinator/messages'&&options?.method==='POST'&&dropNext){dropNext=false;blockReads=true;throw new TypeError('Synthetic acknowledgement lost');}
 return result;
};
function App(){
 const c=useCoordinator(qaApi,'qa-local-user',true,'qa-local-workspace');
 const [device,setDevice]=useState('ready'),[mode,setMode]=useState('question'),[destination,setDestination]=useState('local'),[text,setText]=useState('啥叫没有接收记录？'),[metrics,setMetrics]=useState(null),[notice,setNotice]=useState(''),[dropAck,setDropAck]=useState(false);
 useEffect(()=>{let live=true;const read=()=>fetch('/__qa/metrics').then(response=>response.json()).then(value=>{if(live)setMetrics(value);});void read();const timer=setInterval(read,500);return()=>{live=false;clearInterval(timer);};},[]);
 async function configure(){await fetch('/__qa/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device,mode})});await refreshLocalDeviceReadiness(qaApi);setNotice('合成场景已更新，未更换工作文件夹。');}
 async function submit(event,explicit=false){event?.preventDefault();setNotice('');await configure();dropNext=dropAck;try{await c.submit({operationId:crypto.randomUUID(),text,modelId:'qa-router',outputDestination:destination,localExecution:explicit,attachmentIds:mode==='attachment'?['qa-template']:[]});setNotice('已核对这次合成提交。');}catch(error){setNotice(error.message);}}
 async function recover(){blockReads=false;await c.refresh();setNotice('仅恢复读取原提交，没有重发。');}
 return <main style={{display:'grid',gridTemplateColumns:'minmax(520px,1fr) 520px',gap:24,padding:24,height:'100vh',overflow:'auto',background:'#dce5e9',color:'#203947'}}>
 <section><h1>本机执行链路 · 隔离验收</h1><p>真实调度、回执和组件。设备与模型为合成；实际文件写入、外部模型调用均为 0。</p>
 <div style={{height:420,overflow:'auto'}} className="one-studio coordinator-preview"><CoordinatorConversation messages={c.state.dialogue} tasks={c.state.tasks} pending={!!c.state.pending} progress={c.progress} completed={c.settlement?.status==='completed'} onStop={c.stop} onOpen={()=>{}} onRestore={setText}/></div>
 <form onSubmit={submit}><label>本轮要求<textarea aria-label="本轮要求" rows={3} value={text} onChange={event=>setText(event.target.value)}/></label><DocumentDestinationPicker api={qaApi} value={destination} onChange={setDestination} localDisabled={false} onSettings={()=>{}} onLocalSettings={()=>document.getElementById('qa-settings').scrollIntoView()}/>
 <button type="submit" disabled={!!c.state.pending}>发送（保存位置只是偏好）</button><button type="button" disabled={!!c.state.pending} onClick={()=>submit(undefined,true)}>明确本机执行</button></form>
 <p role="status">{c.state.pending?'正在核对原提交':'等待已结束'} · {notice}</p>{c.error?<p role="alert">{c.error}</p>:null}
 <details open><summary>合成故障控制</summary><label>设备状态<select aria-label="设备状态" value={device} onChange={event=>setDevice(event.target.value)}><option value="ready">已连接且原目录可用</option><option value="offline">设备离线</option><option value="unselected">首次未选目录</option><option value="folder_unavailable">原目录不可用</option><option value="executor_unprepared">工具未准备</option><option value="busy">工具正忙</option></select></label>
 <label>调度场景<select aria-label="调度场景" value={mode} onChange={event=>setMode(event.target.value)}><option value="question">解释性追问</option><option value="execute">正确本机交接</option><option value="wrapper">普通分派选择本机能力</option><option value="no_dispatch">模型未产生交接</option><option value="attachment">本机新附件受理拒绝</option></select></label>
 <button type="button" onClick={configure}>只刷新合成状态</button><label><input type="checkbox" checked={dropAck} onChange={event=>setDropAck(event.target.checked)}/>提交后暂断确认与读回</label><button type="button" onClick={recover}>恢复读回（不重发）</button></details>
 <pre aria-label="合成验收计数">{JSON.stringify(metrics,null,2)}</pre></section>
 <aside id="qa-settings"><h2>真实本机设置组件</h2><LocalDeviceSettings api={qaApi}/></aside></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const vite=await createServer({configFile:false,plugins:[react(),{name:'one-local-readiness-qa',resolveId(id){if(id==='/__qa_local/client.tsx')return id;},load(id){if(id==='/__qa_local/client.tsx')return client;},configureServer(server){
 server.middlewares.use(async(req,res,next)=>{if(req.url?.split('?')[0]!=='/__qa_local/')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__qa_local/','<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>ONE 本机执行隔离验收</title></head><body><div id="root"></div><script type="module" src="/__qa_local/client.tsx"></script></body></html>'));});
 server.middlewares.use(app);
}}],server:{host:'127.0.0.1',port:4404,strictPort:true}});
await vite.listen();process.stdout.write('Synthetic local-readiness QA: http://127.0.0.1:4404/__qa_local/\n');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void vite.close().finally(()=>process.exit(0));});
