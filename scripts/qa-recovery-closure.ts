/** Opt-in browser checks of real recovery components. All data and replies are
 * synthetic; service-side effect/budget guarantees are tested separately. */
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';

if(process.env.ONE_SYNTHETIC_QA!=='1')throw Error('Set ONE_SYNTHETIC_QA=1. This fixture never connects to production.');
const client=`
import React,{useState,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {NotionReceiptNotice} from '/src/DocumentDestination.tsx';
import {TaskRecoveryGuidance} from '/src/TaskRecoveryGuidance.tsx';
import {TaskTransferRail} from '/src/TaskTransferRail.tsx';
import {CoordinatorConversation} from '/src/preview/CoordinatorConversation.tsx';
import {recoveryGuidance} from '/src/recoveryGuidance.ts';
import '/src/styles.css';
import '/src/preview/workspace-preview.css';
const scenarios={
 connection:{kind:'connection',message:'文章已经写好。保存前 Key 连接中断，这一步尚未发出。'},
 page:{kind:'review_notion',message:'文章已经写好，保存响应没有带回页号，需要这次的原页链接。'},
 automatic:{kind:'reconciling',message:'文章已保存，正在后台核对正文。'},
 support:{kind:'support',message:'ONE 没能修好这一步的工具参数，内部纠正次数已用完。已有文章保留。',requestId:'work_synthetic'},
 input:{kind:'input',message:'还缺需要填写的原 Excel 模板。请上传这份 XLSX 文件。'},
 late:{kind:'review_notion',message:'合成旧任务的保存结果等待只读核对。'},
};
function App(){
 const [scenario,setScenario]=useState('connection'),[taskId,setTaskId]=useState('synthetic-A'),[completed,setCompleted]=useState(false),[metrics,setMetrics]=useState({reads:0,direct:0,refresh:0,models:0,writes:0}),[lastRequest,setLastRequest]=useState('尚未提交任何操作'),[detail,setDetail]=useState(false);
 const deferred=useRef(null),[pendingOld,setPendingOld]=useState(false);
 const recovery=completed?{kind:'none',message:'正文已核对，任务完成。'}:scenarios[scenario];
 const workflow={version:1,phase:completed?'completed':'failed',steps:[{id:'draft',title:'撰写专栏',state:'completed'},{id:'save',title:'保存并核对正文',state:completed?'completed':scenario==='automatic'?'waiting':'failed',...(scenario==='automatic'?{waitingFor:'result',recovery:{state:'scheduled',attempt:1}}:{})}]};
 const guide=recoveryGuidance({recovery,workflow});
 const api=async(path,options)=>{
  setLastRequest(path+' '+(options?.body||''));
  if(path.endsWith('/notion/verify')){
   setMetrics(m=>({...m,reads:m.reads+1}));
   if(scenario==='late'){setPendingOld(true);return new Promise(resolve=>{deferred.current=()=>resolve({state:'verified'});});}
   if(!JSON.parse(options?.body||'{}').pageUrl)throw Error('本场景必须提供原页链接');
   return {state:'verified'};
  }
  if(path.endsWith('/messages')){setMetrics(m=>({...m,direct:m.direct+1}));setCompleted(true);return {ok:true};}
  throw Error('Fixture refuses an unreviewed API action');
 };
 const continueTask=()=>api('/api/coordinator/tasks/'+taskId+'/messages',{method:'POST',body:JSON.stringify({text:'按原要求继续'})});
 const notice=()=>['page','automatic','late'].includes(scenario)?<NotionReceiptNotice api={api} taskId={taskId} sourceJobId={taskId+'-job'} expectedUpdatedAt="2026-11-03T01:00:00.000Z" receipt={scenario==='page'?{state:'uncertain',delivery:'unknown',recoveryInput:'page_url'}:{state:'uncertain',url:'https://www.notion.so/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',verification:{state:scenario==='automatic'?'scheduled':'exhausted',attempt:3,version:1,lastReason:'read_failed'}}} onRefresh={async()=>{setMetrics(m=>({...m,refresh:m.refresh+1}));if(scenario==='page')setCompleted(true);}}/>:null;
 const content=()=>completed?<p role="status">✅ 全部完成。原有文章保留，没有重新生成。</p>:<><TaskRecoveryGuidance recovery={recovery} workflow={workflow}/>{scenario==='connection'?<button type="button" onClick={continueTask}>继续这件事</button>:scenario==='input'?<button type="button" onClick={()=>setDetail(true)}>补充所需资料</button>:null}{notice()}</>;
 const choose=next=>{setScenario(next);setTaskId('synthetic-A');setCompleted(false);setDetail(false);setLastRequest('尚未提交任何操作');setMetrics({reads:0,direct:0,refresh:0,models:0,writes:0});};
 const messages=[{id:'input',role:'user',text:'把合成资料写成文章，保存到已授权位置。'},{id:'report_current',role:'assistant',text:completed?'合成专栏：已完成。正文已核对，原稿没有重写。\\n[查看这件事](/?task='+taskId+')':'合成专栏：未完成。旧的暂停汇报保留在完整记录。\\n[查看这件事](/?task='+taskId+')',taskIds:[taskId]}];
 return <main className="one-studio coordinator-preview" style={{minHeight:'100vh',padding:28,background:'#dce5e9',color:'#203947'}}>
 <style>{'.qa-controls{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 24px}.qa-grid{display:grid;grid-template-columns:minmax(400px,1.3fr) minmax(330px,1fr) 290px;gap:22px}.qa-pane{padding:22px;border:1px solid #aebcc4;border-radius:24px;background:#edf2f4;min-width:0}.qa-pane button,.qa-controls button{padding:10px 14px;border:1px solid #aebcc4;border-radius:10px;background:#fff;color:#203947;cursor:pointer}.qa-controls button[aria-pressed=true]{background:#f7d95d}.qa-pane .task-transfer-rail{position:static!important;inset:auto!important;width:100%!important}.qa-pane .coordinator-conversation{height:auto}.qa-pane .coordinator-message{max-width:100%;width:100%}.qa-pane h2{font-size:17px}.qa-pane p{line-height:1.65}.qa-metrics{white-space:pre-wrap;font-size:13px;margin-top:22px}.qa-pane .notion-writing-settings{margin-top:12px}'} </style>
 <h1 style={{fontSize:24}}>恢复出口 · 合成界面验收</h1><p>只检查真实组件与动作路由；不连接用户账号，不调用模型或写入文档。后端恢复与效果保证另有服务故障测试。</p>
 <nav className="qa-controls">{Object.entries({connection:'连接恢复',page:'补原页链接',automatic:'后台自动核对',support:'内部纠正耗尽',input:'真缺模板',late:'旧请求晚回'}).map(([key,title])=><button key={key} aria-pressed={scenario===key} onClick={()=>choose(key)}>{title}</button>)}</nav>
 <div className="qa-grid"><section className="qa-pane"><h2>主对话</h2><CoordinatorConversation messages={messages} tasks={[{id:taskId,title:'合成专栏'}]} pending={false} onOpen={()=>setDetail(true)} renderTaskRecovery={()=>completed?undefined:{label:guide.statusLabel,content:content()}}/>{completed?<p>✅ 原任务完成，未再次生成文章。</p>:null}</section>
 <section className="qa-pane"><h2>任务详情 · {taskId}</h2>{detail||scenario==='late'?<><h3>{completed?'任务已完成':guide.statusLabel}</h3>{content()}{scenario==='input'?<input aria-label="上传原 Excel 模板" type="file" accept=".xlsx"/>:null}</>:<><p>点主对话的“查看任务”或右侧任务动态，核对详情事实一致。</p><button onClick={()=>setDetail(true)}>显示任务详情</button></>}
 {scenario==='late'?<div className="qa-controls"><button onClick={()=>setTaskId('synthetic-B')}>切换为任务 B</button><button disabled={!pendingOld} onClick={()=>{deferred.current?.();deferred.current=null;setPendingOld(false);}}>返回旧任务结果</button></div>:null}</section>
 <aside className="qa-pane"><h2>任务动态</h2><TaskTransferRail tasks={completed?[]:[{id:'receipt-'+taskId,taskId,title:'合成专栏',state:'failed',outcome:'failed',workflow,recovery}]} busy={false} onOpen={()=>setDetail(true)} animateNotes={false}/>
 <pre className="qa-metrics" aria-label="验收计数">{JSON.stringify(metrics,null,2)}</pre><p style={{fontSize:12,overflowWrap:'anywhere'}} aria-label="最后请求">{lastRequest}</p></aside></div></main>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);
`;
const vite=await createServer({configFile:false,plugins:[react(),{
 name:'recovery-closure-qa',resolveId(id){if(id==='/__qa/recovery.tsx')return id;},load(id){if(id==='/__qa/recovery.tsx')return client;},
 configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(req.url!=='/__qa/recovery/')return next();
  res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,'<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>ONE 恢复出口合成验收</title></head><body><div id="root"></div><script type="module" src="/__qa/recovery.tsx"></script></body></html>'));
 });}
}],server:{host:'127.0.0.1',port:4411,strictPort:true}});
await vite.listen();
process.stdout.write('Recovery browser QA: http://127.0.0.1:4411/__qa/recovery/\n');
