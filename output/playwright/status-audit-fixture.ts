// Pure in-memory API fixture. Only the local preview imports this module.
export const STATUS_AUDIT_CASES=['waiting','empty','local','offline','unavailable','stop-rejected','stop-task-rejected'] as const;
export const STATUS_TASK_STATES=['running','needs_input','paused','reconciling'] as const;
export type StatusTaskState=typeof STATUS_TASK_STATES[number];
export type StatusAuditCase=typeof STATUS_AUDIT_CASES[number];
export const STATUS_MAIN_OPERATION='status-audit-main-operation';
export const STATUS_TASK_ID='status-audit-writing';
export const STATUS_EXECUTION_ID='status-audit-local';
export function createStatusAuditFixture(params:URLSearchParams,now=Date.now()) {
 const requested=params.get('statusCase');
 const variant:StatusAuditCase=STATUS_AUDIT_CASES.includes(requested as StatusAuditCase)?requested as StatusAuditCase:'waiting';
 const requestedTaskState=params.get('taskState');
 const taskState:StatusTaskState=STATUS_TASK_STATES.includes(requestedTaskState as StatusTaskState)?requestedTaskState as StatusTaskState:'running';
 const requestedTaskCount=Number(params.get('taskCount')??1);
 const taskCount=variant==='empty'?0:Number.isFinite(requestedTaskCount)?Math.max(1,Math.min(12,Math.floor(requestedTaskCount))):1;
 const elapsed=Number(params.get('statusElapsed')??65),seconds=Number.isFinite(elapsed)?Math.max(0,Math.min(3600,elapsed)):65;
 const when=new Date(now).toISOString(),startedAt=new Date(now-seconds*1000).toISOString();
 const phase=({knowledge:'正在查找已授权知识库',web:'正在查找公开资料',model:'正在等待模型回答',organizing:'已取得工具反馈，正在整理回答'} as Record<string,string>)[params.get('statusPhase')||'knowledge']||'正在查找已授权知识库';
 const userId='preview',workspaceId='preview';
 const messages:any[]=[
  {id:'status-audit-prior-user',role:'user',content:'请把这次 Coffee Chat 里关于 AI 落地的讨论整理成小报童专栏。',createdAt:new Date(now-150000).toISOString()},
  {id:'status-audit-prior-answer',role:'assistant',content:'我会先整理讨论中的关键观点，再写成专栏初稿。',taskIds:variant==='empty'?[]:[STATUS_TASK_ID],createdAt:new Date(now-140000).toISOString()},
  {id:'status-audit-current-user',role:'user',content:'聊天内容在得到大脑里～',createdAt:startedAt},
 ];
 const main={id:'main',workspaceId,userId,modelId:'preview-model',title:'主对话',coordinatorMain:true,archived:false,createdAt:new Date(now-150000).toISOString(),updatedAt:when,messages};
 const conversations:any[]=[],jobs=new Map<string,any[]>();
 const taskTitles=['写小报童专栏：Coffee Chat 对 AI 落地的启发','整理项目资料与待办','核对会议纪要中的决定','准备文章配图说明','整理本周项目复盘'];
 for(let index=0;index<taskCount;index++){
  const id=index===0?STATUS_TASK_ID:`${STATUS_TASK_ID}-${index+1}`,inputId=index===0?'status-audit-task-input':`${id}-input`;
  const updatedAt=new Date(now-index*1000).toISOString();
  const task:any={id,workspaceId,userId,modelId:'preview-model',title:taskTitles[index%taskTitles.length]+(index>=taskTitles.length?` · ${index+1}`:''),executorProfileId:'fixture-worker',archived:false,createdAt:startedAt,updatedAt,messages:[{id:inputId,role:'user',content:'整理讨论里的观点，写一篇专栏初稿。',createdAt:startedAt}]};
  const job:any={id:`${id}-job`,operationId:`${id}-operation`,state:taskState==='running'?'running':'failed',inputMessageId:inputId,instruction:'整理讨论里的观点，写一篇专栏初稿。',kind:'chat',features:[],charges:[]};
  if(taskState==='needs_input'||taskState==='paused'){
   task.workPaused=true;task.workPauseReason=taskState==='needs_input'?'needs_input':'failed';
   job.resultOutcome=taskState==='needs_input'?'needs_input':'failed';
   job.userReport=taskState==='needs_input'?'还缺讨论记录。请补充对应的笔记或录音文字。':'本轮没有完成，已有内容保留，请打开任务核对原因。';
   job.resultMessageId=`${id}-result`;task.messages.push({id:job.resultMessageId,role:'assistant',content:job.userReport,createdAt:updatedAt});
  }else if(taskState==='reconciling')job.verificationPending=true;
  conversations.push(task);jobs.set(id,[job]);
 }
 const localRuns:any[]=variant==='local'?[{id:STATUS_EXECUTION_ID,workspaceId,userId,deviceId:'fixture',conversationId:STATUS_TASK_ID,sourceMessageId:'status-audit-task-input',instruction:'整理演示文件夹内的会议资料。',provider:'codex',status:'running',targetName:'ONE 演示工作区',createdAt:startedAt,startedAt,updatedAt:when}]:[];
 const events:any[]=localRuns.length?[{id:'status-audit-local-status',workspaceId,userId,taskId:STATUS_EXECUTION_ID,kind:'status',text:'正在整理演示资料。',createdAt:startedAt}]:[];
 let mainStatus=variant==='empty'?'completed':'pending';
 const snapshot=()=>{
  // A needs-input outcome is a result receipt, not an invented active meta state.
  const notices=conversations.flatMap(task=>{const job=jobs.get(task.id)![0];return job.state==='cancelled'||job.resultOutcome?[{id:`${job.id}-receipt`,sourceId:job.id,taskId:task.id,title:task.title,state:job.state==='cancelled'?'cancelled':job.resultOutcome,outcome:job.state==='cancelled'?'cancelled':job.resultOutcome,reported:false,read:false,updatedAt:task.updatedAt,resultMessageId:job.resultMessageId}]:[];});
  const metas=conversations.map(task=>{
   const job=jobs.get(task.id)![0],running=job.state==='running'||localRuns.some(run=>run.conversationId===task.id&&run.status==='running');
   const reconciling=Boolean(job.verificationPending&&job.state!=='cancelled');
   return{id:task.id,title:task.title,updatedAt:task.updatedAt,executorId:task.executorProfileId,running,queued:0,paused:Boolean(task.workPaused),reconciling,state:running?'running':reconciling?'reconciling':task.workPaused?'paused':'idle',...(reconciling?{phase:'内容已经交给 Notion，正在自动核对保存结果；不会重复写入。'}:{})};
  });
  return{enabled:true,conversation:main,tasks:metas,transfers:metas.filter(meta=>meta.running||meta.reconciling||meta.paused&&notices.some(notice=>notice.taskId===meta.id&&!notice.reported)),total:conversations.length,notices,links:messages.flatMap(m=>(m.taskIds||[]).map((taskId:string)=>({messageId:m.id,taskId}))),...(mainStatus==='pending'?{pendingOperationId:STATUS_MAIN_OPERATION}:{}),history:{hasMore:false,total:messages.length}};
 };
 const reply=(body:any,status=200)=>({body,status});
 function handle(method:string,url:URL,_body:any={}):{body:any;status:number}|undefined {
  const path=url.pathname;
  if(path==='/api/coordinator'&&method==='GET')return reply(snapshot());
  if(path===`/api/coordinator/messages/${STATUS_MAIN_OPERATION}`&&method==='GET')return reply({status:mainStatus,operationId:STATUS_MAIN_OPERATION,requestId:'coord_status_audit',...(mainStatus==='pending'?{progress:{phase,startedAt}}:{}),...(mainStatus==='interrupted'?{error:'已停止本次回复。'}:{})});
  if(path===`/api/coordinator/messages/${STATUS_MAIN_OPERATION}/stop`&&method==='POST'){
   if(variant==='stop-rejected')return reply({error:'暂时未能确认停止，请重试。'},503);
   mainStatus='interrupted';return reply({status:'interrupted',operationId:STATUS_MAIN_OPERATION});
  }
  const taskRoute=path.match(/^\/api\/coordinator\/tasks\/([^/]+)(?:\/(stop))?$/);
  if(taskRoute){
   const task=conversations.find(task=>task.id===decodeURIComponent(taskRoute[1]));
   if(!task)return reply({error:'合成任务不存在'},404);
   const job=jobs.get(task.id)![0];
   if(taskRoute[2]==='stop'&&method==='POST'){
    if(variant==='stop-task-rejected')return reply({error:'暂时未能确认任务已停止，请重试。'},503);
    job.state='cancelled';task.updatedAt=when;task.workPaused=true;task.workPauseReason='user_stopped';
    for(const local of localRuns)if(local.conversationId===task.id)local.status='cancelled';
    return reply({ok:true});
   }
   if(!taskRoute[2]&&method==='GET')return reply({conversation:task,jobs:[job],recovery:{kind:'none',message:job.state==='running'?'任务正在处理。':job.userReport||'已有内容保留。'}});
  }
  if(path==='/api/executions'&&method==='GET')return variant==='unavailable'?reply({error:'暂时无法读取本机任务状态，请重试。'},503):reply({tasks:localRuns.filter(t=>!url.searchParams.get('conversationId')||t.conversationId===url.searchParams.get('conversationId'))});
  if(path===`/api/executions/${STATUS_EXECUTION_ID}`&&method==='GET')return reply({task:localRuns[0],events});
  if(path==='/api/runtime/update'&&method==='GET')return reply({configured:true,supported:true,available:false,connectionState:variant==='offline'?'reconnecting':'connected',...(variant==='offline'?{}:{current:{platform:'macos',architecture:'arm64',version:'0.0.0-fixture',updateProtocol:1}})});
  if(path==='/api/me/local-device'&&method==='GET')return variant==='offline'?reply({error:'本机连接尚未确认，请检查 ONE Key。'},503):reply({targetName:'ONE 演示工作区'});
  if(path==='/api/me/executor'&&method==='GET')return variant==='offline'?reply({error:'本机连接尚未确认，请检查 ONE Key。'},503):reply({available:true,installedVersion:'0.0.0-fixture',installedSource:'managed',version:'0.0.0-fixture'});
  // Unhandled state mutations must not start a model, device operation or retry.
  if(method!=='GET'&&(path.startsWith('/api/coordinator/')||path.startsWith('/api/executions')||path.startsWith('/api/me/local-device')||path.startsWith('/api/me/executor')||path.startsWith('/api/runtime/')))return reply({error:'此预览仅检查状态与布局，不开始新任务或操作设备。'},409);
  return undefined;
 }
 return {variant,taskState,taskCount,startedAt,phase,conversations,messages,localRuns,jobs,events,handle,snapshot};
}
