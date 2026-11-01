/** Isolated browser acceptance. Real routes, dispatch and UI; synthetic device/model only. */
import express from 'express';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {readFileSync} from 'node:fs';
import type {Database,ModelConfig} from '../server/types.js';
import type {Store} from '../server/db.js';
import {installCoordinatorRoutes} from '../server/coordinatorRoutes.js';
import {defaultTaskValues,updateTaskConfig} from '../server/aiTaskConfig.js';
import {executorDefaults,updateExecutor} from '../server/executorProfiles.js';
import type {ToolChatResult} from '../server/modelGateway.js';
import type {LocalDeviceReadiness} from '../src/localDeviceReadiness.js';

if(process.env.ONE_SYNTHETIC_QA!=='1')throw Error('This synthetic fixture requires ONE_SYNTHETIC_QA=1.');
const scope={userId:'qa-local-user',workspaceId:'qa-local-workspace'};
const instanceId=`qa-local-${Date.now()}`;
const stamp=()=>new Date().toISOString();
const scenarios=['ready','offline','unselected','folder_unavailable','executor_unprepared','busy'] as const;
let device:typeof scenarios[number]='ready',mode='question',modelCalls=0,localAcceptances=0,readinessReads=0,folderChanges=0,posts=0;
let platform:'macos'|'windows'='macos',taskPhase='none',stopRequests=0,reconciliations=0,previewRequests=0;
const task=()=>taskPhase==='none'?null:({id:'qa-owned-execution',conversationId:'qa-owned-conversation',sourceMessageId:'qa-owned-input',status:taskPhase==='hold'?'cancelled':taskPhase,
 targetName:platform==='windows'?'C:\\Synthetic\\owned-folder':'/synthetic/authorized-folder',reportRound:2,updatedAt:'2026-11-01T00:00:00.000Z',createdAt:'2026-11-01T00:00:00.000Z',
 ...(taskPhase==='hold'?{requiresExecutionCheck:true,resultDeliveryPending:true,lastError:'合成旧操作的结束情况未确认；此页不会操作真实文件。'}:{finalResponse:'这只是合成设备回执，没有写入真实文件。'})});
const models=['qa-router','qa-worker'].map(id=>({id,name:id,provider:'fixture',protocol:'openai',baseUrl:'https://fixture.invalid',enabled:true,kind:'chat',apiKey:'synthetic-not-a-provider-credential',systemPrompt:'仅处理当前隔离合成要求。',isDefault:id==='qa-worker',inputPowerPerMillion:1,outputPowerPerMillion:1,costInputPowerPerMillion:1,costOutputPowerPerMillion:1,createdAt:stamp()}) as ModelConfig);
let database={users:[{id:scope.userId,enabled:true,role:'user',defaultWorkspaceId:scope.workspaceId}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[{...scope,role:'owner',status:'active'}],models,settings:{safetyRules:'隔离测试，不得访问生产、真实文件或外部模型。',rechargeCnyPerPower:7},conversations:[],messages:[],chatOperations:[],knowledgeConnections:[],auditLogs:[],contextTraces:[],modelUsageRecords:[],powerAccounts:[{...scope,id:'qa-local-power',balanceMicros:100e6,reservedMicros:0}],powerLedger:[],attachments:[{...scope,id:'qa-template',originalName:'synthetic-template.png',kind:'image',mimeType:'image/png',size:1,status:'ready',storagePath:'/synthetic-never-read/template.png',extractedText:'',createdAt:stamp()}],executionTasks:[],executionEvents:[]} as unknown as Database;
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
 return {checkedAt:stamp(),validForMs:10_000,platform,capabilities:{staticPreview:platform==='macos',taskDirectoryBinding:platform==='macos'},ready:device==='ready',connected,folder:{state:folderState,...(folderState==='ready'?{targetName:platform==='windows'?'C:\\Synthetic\\owned-folder':'/synthetic/authorized-folder'}:{})},executor:{state:executorState,...(executorState==='ready'?{installedVersion:'0.160.1',installedSource:'managed' as const}:{})},reason} as LocalDeviceReadiness;
}
const answer=(content:string):ToolChatResult=>({content,toolCalls:[],finishReason:'stop',usage:{inputTokens:50,outputTokens:50,totalTokens:100,source:'provider'}});
const app=express();app.use(express.json());
app.use((req,_res,next)=>{(req as any).user={id:scope.userId};(req as any).workspaceId=scope.workspaceId;(req as any).oneKeyDeviceId='qa-device';(req as any).oneKeyInstallationId='qa-installation';next();});
const metrics=()=>({instanceId,device,mode,platform,taskPhase,task:task(),posts,modelCalls,localAcceptances,readinessReads,folderChanges,stopRequests,reconciliations,previewRequests,externalModelCalls:0,actualDiskWrites:0,
 refusedOperations:[...new Set(database.messages.flatMap(message=>message.rejectedSubmission?[message.rejectedSubmission.operationId]:[]))],refusedMessageCount:database.messages.filter(message=>message.rejectedSubmission).length,
 refusedMessages:database.messages.filter(message=>message.rejectedSubmission).map(({id,role,content,rejectedSubmission})=>({id,role,content,operationId:rejectedSubmission!.operationId,failure:rejectedSubmission!.failure})),
 operations:database.chatOperations.map(operation=>({id:operation.operationId,status:operation.status,failure:operation.failure,local:Boolean(operation.workRun?.state==='prepared')}))});
app.get('/__qa/metrics',(_req,res)=>res.json(metrics()));
app.post('/__qa/config',(req,res)=>{if(!scenarios.includes(req.body.device)||!['question','execute','wrapper','no_dispatch','attachment'].includes(req.body.mode)||!['macos','windows'].includes(req.body.platform??'macos'))return res.status(400).json({error:'Unknown synthetic mode'});device=req.body.device;mode=req.body.mode;platform=req.body.platform??'macos';res.json(metrics());});
app.post('/__qa/task',(req,res)=>{if(!['none','queued','selecting_target','running','completed','cancelled','hold'].includes(req.body.phase))return res.status(400).json({error:'Unknown synthetic task phase'});taskPhase=req.body.phase;device=['queued','selecting_target','running','hold'].includes(taskPhase)?'busy':'ready';res.json(metrics());});
app.post('/api/executions/qa-owned-execution/cancel',(req,res)=>{if(!task()||req.body.expectedRound!==2)return res.status(409).json({error:'Synthetic task round changed'});stopRequests++;taskPhase='hold';device='busy';res.json({task:task(),events:[]});});
app.post('/api/executions/qa-owned-execution/reconcile-stop',(req,res)=>{if(taskPhase!=='hold'||req.body.expectedRound!==2||req.body.expectedUpdatedAt!==task()?.updatedAt||req.body.confirmation!=='manually_checked_original_execution_stopped'||!req.body.reason?.trim())return res.status(409).json({error:'Synthetic attestation is incomplete or stale'});reconciliations++;taskPhase='cancelled';device='ready';res.json({task:task(),events:[]});});
app.get('/api/executions/qa-owned-execution/trace',(_req,res)=>res.json({instruction:'合成安排：没有真实模型、没有真实目录、没有真实文件写入。'}));
app.post('/api/executions/qa-owned-execution/preview',(_req,res)=>{previewRequests++;res.status(409).json({error:'合成页不创建真实网页服务。'});});
app.get('/api/me/local-device/readiness',(_req,res)=>{readinessReads++;res.setHeader('Cache-Control','no-store');res.json(readiness());});
app.get('/api/me/local-device',(_req,res)=>res.json({targetName:readiness().folder.targetName}));
app.post('/api/me/local-device',(_req,res)=>{folderChanges++;res.json({targetName:'/synthetic/authorized-folder'});});
app.get('/api/me/executor',(_req,res)=>res.json({available:device!=='offline',installedVersion:device==='executor_unprepared'?undefined:'0.160.1',installedSource:'managed',version:'0.160.1'}));
app.get('/api/knowledge/connections/notion/writing',(_req,res)=>res.json({connected:false,writeAuthorized:false,ready:false,parentId:'',referenceIds:[]}));
app.get('/api/attachments/qa-template',(_req,res)=>res.json({attachment:{id:'qa-template',originalName:'synthetic-template.png',kind:'image',mimeType:'image/png',status:'ready',size:1}}));
app.use('/api/coordinator/messages',(req,_res,next)=>{if(req.method==='POST')posts++;next();});
installCoordinatorRoutes(app,[(_req,_res,next)=>next()],[(_req,res)=>{res.status(403).json({error:'No admin operations in this fixture.'});}],store,async()=>{}, {recallWithDiagnostics:async()=>{throw Error('No knowledge access in this synthetic fixture.');}}, {
 inspectLocalReadiness:async()=>readiness(),
 executeLocal:async()=>{localAcceptances++;taskPhase='queued';device='busy';return{id:'qa-owned-execution',status:'queued'};},
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
// Importing main.tsx would boot the full app. Expose its unchanged real private
// component/helpers in an isolated virtual module, not a QA reimplementation.
const mainSource=readFileSync(new URL('../src/main.tsx',import.meta.url),'utf8');
const mainSlice=(start:string,end:string)=>{const a=mainSource.indexOf(start),b=mainSource.indexOf(end,a);if(a<0||b<0)throw Error('Frozen main acceptance markers changed');return mainSource.slice(a,b);};
const executionComponent=`
import React,{useState,useContext,createContext} from 'react';
import {Check,ChevronDown,Square} from 'lucide-react';
import {friendlyExecutionProgress} from '/src/friendlyTaskStatus.ts';
import {executionNeedsReview} from '/src/executionReview.ts';
import {executionRecovery} from '/src/executionRecovery.ts';
import {ExecutionReconcileStop} from '/src/ExecutionReconcileStop.tsx';
import {StaticPreviewPanel} from '/src/StaticPreviewPanel.tsx';
import {MessageMarkdown} from '/src/MessageMarkdown.tsx';
import type {ExecutionTask,ExecutionEvent,Role} from '/server/types.ts';
import type {LocalDeviceReadiness} from '/src/localDeviceReadiness.ts';
export const PrivateApiContext=createContext(null);
${mainSlice('function executionStatusLabel(','function titleFrom(')}
${mainSlice('function ExecutionDisclosure(','type TaskNotice')}
export {ExecutionDisclosure};
export function executionMaterialActive(tasks){const runningExecutions=tasks.filter(isExecutionRunning);const executionBusy=runningExecutions.length>0;${mainSource.match(/const activeExecutionMode = [^;]+;/)![0]}return activeExecutionMode;}
`;
const client=`
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {api,expectUser,ApiError} from '/src/oneApi.ts';
import {useCoordinator} from '/src/useCoordinator.ts';
import {CoordinatorConversation} from '/src/preview/CoordinatorConversation.tsx';
import {LocalDeviceSettings} from '/src/LocalDeviceSettings.tsx';
import {DocumentDestinationPicker} from '/src/DocumentDestination.tsx';
import {refreshLocalDeviceReadiness} from '/src/localDeviceReadinessStore.ts';
import {useLocalDeviceReadiness} from '/src/useLocalDeviceReadiness.ts';
import {coordinatorDrafts,forgetCoordinatorDraft} from '/src/coordinatorDrafts.ts';
import {coordinatorPendingKey,forgetStoredCoordinatorOperation} from '/src/coordinatorTransport.ts';
import {pendingChatSubmissions,forgetChatSubmission} from '/src/chatSubmission.ts';
import {executionCancellationRequest} from '/src/executionRecovery.ts';
import {OneFluidSurface} from '/src/fluid/OneFluidSurface.tsx';
import {ExecutionDisclosure,PrivateApiContext,executionMaterialActive} from '/__qa_local/execution.tsx';
import '/src/styles.css';
import '/src/preview/workspace-preview.css';
import '/src/fluid-workspace.css';
expectUser('qa-local-user','qa-local-workspace');
const initialMetrics=await fetch('/__qa/metrics').then(response=>response.json());
// Restart resets this isolated in-memory server. Clear only this exact QA
// account's browser fallback so an old test cannot masquerade as persistence.
if(sessionStorage.getItem('one.synthetic-local-qa.instance')!==initialMetrics.instanceId){
 for(const draft of coordinatorDrafts('qa-local-user','qa-local-workspace'))forgetCoordinatorDraft('qa-local-user','qa-local-workspace',draft.operationId);
 const key=coordinatorPendingKey('qa-local-user','qa-local-workspace'),pending=localStorage.getItem(key);if(pending)forgetStoredCoordinatorOperation(localStorage,key,pending);
 for(const item of pendingChatSubmissions('coordinator:qa-local-user:qa-local-workspace'))forgetChatSubmission('coordinator:qa-local-user:qa-local-workspace',item.operationId);
 sessionStorage.setItem('one.synthetic-local-qa.instance',initialMetrics.instanceId);
}
let dropNext=false,blockReads=false;
const qaApi=async(path,options)=>{
 if(blockReads&&path.startsWith('/api/coordinator')&&options?.method!=='POST')throw new ApiError('合成网络暂时断开',undefined,503);
 const result=await api(path,options);
 if(path==='/api/coordinator/messages'&&options?.method==='POST'&&dropNext){dropNext=false;blockReads=true;throw new TypeError('Synthetic acknowledgement lost');}
 return result;
};
function App(){
 const c=useCoordinator(qaApi,'qa-local-user',true,'qa-local-workspace');
 const local=useLocalDeviceReadiness(qaApi);
 const [device,setDevice]=useState('ready'),[mode,setMode]=useState('question'),[platform,setPlatform]=useState('macos'),[destination,setDestination]=useState('local'),[text,setText]=useState('啥叫没有接收记录？'),[metrics,setMetrics]=useState(null),[notice,setNotice]=useState(''),[dropAck,setDropAck]=useState(false);
 async function readMetrics(){const value=await fetch('/__qa/metrics').then(response=>response.json());setMetrics(value);return value;}
 useEffect(()=>{let live=true;const read=()=>fetch('/__qa/metrics').then(response=>response.json()).then(value=>{if(live)setMetrics(value);});void readMetrics().then(value=>{if(live){setDevice(value.device);setMode(value.mode);setPlatform(value.platform);}});const timer=setInterval(read,500);return()=>{live=false;clearInterval(timer);};},[]);
 async function configure(next={device,mode,platform}){await fetch('/__qa/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});setDevice(next.device);setMode(next.mode);setPlatform(next.platform);await refreshLocalDeviceReadiness(qaApi);await readMetrics();setNotice('合成场景已更新，未更换工作文件夹。');}
 async function submit(event,explicit=false){event?.preventDefault();setNotice('');await configure();dropNext=dropAck;try{await c.submit({operationId:crypto.randomUUID(),text,modelId:'qa-router',outputDestination:destination,localExecution:explicit,attachmentIds:mode==='attachment'?['qa-template']:[]});setNotice('已核对这次合成提交。');}catch(error){setNotice(error.message);}}
 async function recover(){blockReads=false;await c.refresh();setNotice('仅恢复读取原提交，没有重发。');}
 async function phase(value,nextPlatform=platform){await configure({device:['queued','running','selecting_target','hold'].includes(value)?'busy':'ready',mode:'question',platform:nextPlatform});await fetch('/__qa/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:value})});await readMetrics();await refreshLocalDeviceReadiness(qaApi);}
 async function refusedPair(){try{blockReads=false;await phase('none');await configure({device:'offline',mode:'question',platform:'macos'});for(const text of ['QA拒绝历史第一条：保留模板甲','QA拒绝历史第二条：保留模板乙']){await c.submit({operationId:crypto.randomUUID(),text,modelId:'qa-router',outputDestination:'local',localExecution:true,attachmentIds:[]});await c.refresh();await readMetrics();}const value=await readMetrics();const valid=value.refusedMessageCount===4&&value.refusedOperations.length===2&&value.refusedMessages.every(message=>message.failure?.code==='local_device_offline'&&message.failure?.outcome==='not_started');setNotice(valid?'已核对服务端4条拒绝消息、2个原提交；不是仅靠页面草稿。可再发送普通追问或刷新验证。':'未通过持久历史验收：请看服务端拒绝计数和消息，不能以草稿显示代替。');}catch(error){setNotice('拒绝历史验收未完成：'+error.message);}}
 async function ordinary(){await phase('none');await configure({device:'ready',mode:'question',platform:'macos'});await c.submit({operationId:crypto.randomUUID(),text:'QA后续普通追问：刚才为什么没开始？',modelId:'qa-router',outputDestination:'local'});await c.refresh();await readMetrics();setNotice('普通追问已返回；前两条失败原话和回复不应消失。');}
 function serverOnlyReload(){if(c.state.pending)return;for(const draft of coordinatorDrafts('qa-local-user','qa-local-workspace'))if(draft.rejection)forgetCoordinatorDraft('qa-local-user','qa-local-workspace',draft.operationId);window.location.reload();}
 async function stopTask(){const request=executionCancellationRequest(metrics.task);await qaApi(request.path,{method:'POST',body:JSON.stringify(request.body)});await readMetrics();await refreshLocalDeviceReadiness(qaApi);setNotice('只向合成原任务的第3轮请求停止，没有重发任务。');}
 const active=executionMaterialActive(metrics?.task?[metrics.task]:[]);
 const historyNames=['QA拒绝历史第一条：保留模板甲','QA拒绝历史第二条：保留模板乙'];
 return <main style={{display:'grid',gridTemplateColumns:'minmax(560px,1fr) 480px',gap:24,padding:24,height:'100vh',overflow:'auto',background:'#dce5e9',color:'#203947'}}>
 <section><h1>本机执行链路 · 隔离验收</h1><p>真实调度、回执和组件。设备与模型为合成；实际文件写入、外部模型调用均为 0。</p>
 <nav aria-label="快捷验收场景" style={{display:'flex',flexWrap:'wrap',gap:8}}><button onClick={()=>phase('none')}>仅local偏好（不执行）</button><button onClick={()=>phase('queued')}>合成排队</button><button onClick={()=>phase('running')}>合成运行</button><button onClick={()=>phase('completed')}>合成完成</button><button onClick={()=>phase('hold')}>旧任务hold</button><button onClick={()=>phase('completed','windows')}>Windows预览</button></nav>
 <section aria-label="真实执行材质" style={{margin:'12px 0',height:260,position:'relative'}}><main className={'app-shell one-shell one-studio one-fluid-workspace '+(active?'execution-shell':'')} data-fluid-material="optical" data-fluid-scene="silver" data-fluid-accent="solar" style={{height:260,minHeight:260,borderRadius:20}}><div className="fluid-skin"><OneFluidSurface scene="silver" accent="solar" executionActive={active} width={740} height={260} activityOpen={false} localOpen={false} sidebarOpen={false} attentionTarget="main" attentionVersion={0} onActivityToggle={()=>{}} onLocalToggle={()=>{}} onSidebarToggle={()=>{}}/></div><div style={{position:'relative',zIndex:4,padding:40,pointerEvents:'none'}}><h2>真实 ONE 材质与执行状态</h2><output aria-label="执行材质状态">{active?'正在本机执行 · 深色材质':'未执行 · 普通材质'}</output><p>依据冻结 main 的真实运行状态表达式。保存位置 local 不代表执行。</p></div></main></section>
 <div style={{height:420,overflow:'auto'}} className="one-studio coordinator-preview"><CoordinatorConversation messages={c.state.dialogue} tasks={c.state.tasks} pending={!!c.state.pending} progress={c.progress} completed={c.settlement?.status==='completed'} onStop={c.stop} onOpen={()=>{}} onRestore={setText}/></div>
 <form onSubmit={submit}><label>本轮要求<textarea aria-label="本轮要求" rows={3} value={text} onChange={event=>setText(event.target.value)}/></label><DocumentDestinationPicker api={qaApi} value={destination} onChange={setDestination} localDisabled={false} onSettings={()=>{}} onLocalSettings={()=>document.getElementById('qa-settings').scrollIntoView()}/>
 <button type="submit" disabled={!!c.state.pending}>发送（保存位置只是偏好）</button><button type="button" disabled={!!c.state.pending||!local.canRequestExecution} onClick={()=>submit(undefined,true)}>明确本机执行</button></form>
 <p role="status">{c.state.pending?'正在核对原提交':'等待已结束'} · {notice}</p>{c.error?<p role="alert">{c.error}</p>:null}
 <details open><summary>合成故障控制</summary><label>设备状态<select aria-label="设备状态" value={device} onChange={event=>setDevice(event.target.value)}><option value="ready">已连接且原目录可用</option><option value="offline">设备离线</option><option value="unselected">首次未选目录</option><option value="folder_unavailable">原目录不可用</option><option value="executor_unprepared">工具未准备</option><option value="busy">工具正忙</option></select></label>
 <label>调度场景<select aria-label="调度场景" value={mode} onChange={event=>setMode(event.target.value)}><option value="question">解释性追问</option><option value="execute">正确本机交接</option><option value="wrapper">普通分派选择本机能力</option><option value="no_dispatch">模型未产生交接</option><option value="attachment">本机新附件受理拒绝</option></select></label>
 <label>平台<select aria-label="合成平台" value={platform} onChange={event=>setPlatform(event.target.value)}><option value="macos">macOS</option><option value="windows">Windows</option></select></label>
 <button type="button" onClick={()=>configure()}>只刷新合成状态</button><label><input type="checkbox" checked={dropAck} onChange={event=>setDropAck(event.target.checked)}/>提交后暂断确认与读回</label><button type="button" onClick={recover}>恢复读回（不重发）</button></details>
 <section aria-label="拒绝历史验收"><h2>拒绝历史 · 不丢原话</h2><button disabled={!!c.state.pending} onClick={refusedPair}>发送两条不同拒绝</button><button disabled={!!c.state.pending} onClick={ordinary}>再发普通追问</button><button disabled={!!c.state.pending} onClick={()=>window.location.reload()}>刷新页面</button><button disabled={!!c.state.pending} onClick={serverOnlyReload}>仅清合成拒绝草稿并刷新</button><p aria-label="拒绝历史摘要">{historyNames.map(name=>name+'：页面 '+c.state.dialogue.filter(message=>message.role==='user'&&message.text===name).length+' 条 / 服务端 '+(metrics?.refusedMessages??[]).filter(message=>message.role==='user'&&message.content===name).length+' 条').join('；')}。服务端拒绝消息 {metrics?.refusedMessageCount??0} 条。</p></section>
 <pre aria-label="合成验收计数">{JSON.stringify(metrics,null,2)}</pre></section>
 <aside id="qa-settings"><h2>真实本机设置组件</h2><LocalDeviceSettings api={qaApi}/><h2>真实任务详情组件</h2><p>原任务、按钮和管理员确认表单为真实组件；本页API只改变合成内存。</p><PrivateApiContext.Provider value={qaApi}>{metrics?.task?<ExecutionDisclosure task={metrics.task} events={[]} preparing={false} expanded={true} onToggle={()=>{}} onStop={stopTask} onContinue={()=>setNotice('此页不执行真实续做。')} onCheck={()=>void refreshLocalDeviceReadiness(qaApi)} actorRole="admin" onReconciled={async()=>{await readMetrics();await refreshLocalDeviceReadiness(qaApi);}} continuationDisabled={!local.canRequestExecution} localReadiness={local.status==='confirmed'?local.value:undefined}/>:<p>请选择上方合成任务场景。</p>}</PrivateApiContext.Provider></aside></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const vite=await createServer({configFile:false,plugins:[react(),{name:'one-local-readiness-qa',resolveId(id){if(id==='/__qa_local/client.tsx'||id==='/__qa_local/execution.tsx')return id;},load(id){if(id==='/__qa_local/client.tsx')return client;if(id==='/__qa_local/execution.tsx')return executionComponent;},configureServer(server){
 server.middlewares.use(async(req,res,next)=>{if(req.url?.split('?')[0]!=='/__qa_local/')return next();res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__qa_local/','<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>ONE 本机执行隔离验收</title></head><body><div id="root"></div><script type="module" src="/__qa_local/client.tsx"></script></body></html>'));});
 server.middlewares.use(app);
}}],server:{host:'127.0.0.1',port:4404,strictPort:true}});
await vite.listen();process.stdout.write('Synthetic local-readiness QA: http://127.0.0.1:4404/__qa_local/\n');
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void vite.close().finally(()=>process.exit(0));});
