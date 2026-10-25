/** Local-only synthetic browser acceptance. No credentials, upstream calls or production data. */
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import type { Database } from '../server/types.js';
import type { Store } from '../server/db.js';
import { CoordinatorService } from '../server/coordinatorService.js';

if(process.env.ONE_SYNTHETIC_QA!=='1')throw Error('Set ONE_SYNTHETIC_QA=1 for this isolated local fixture.');
const scope={workspaceId:'qa-workspace',userId:'qa-user'},stamp=()=>new Date().toISOString();
const main={...scope,id:'qa-main',modelId:'qa-model',title:'隔离对话',coordinatorMain:true,archived:false,messages:[],createdAt:stamp(),updatedAt:stamp()};
const db={users:[{id:scope.userId,enabled:true}],workspaces:[{id:scope.workspaceId,status:'active'}],workspaceMembers:[scope],conversations:[main],messages:[],chatOperations:[],attachments:[],executionTasks:[],settings:{aiTasks:{coordinator:{published:{enabled:true}}}}} as unknown as Database;
let mutation:Promise<unknown>=Promise.resolve(),posts=0,holdDetail=true,holdSnapshot=false,staleSnapshots=0;
const store={read:async()=>structuredClone(db),mutate:<T>(fn:(d:Database)=>T)=>{
 const next=mutation.then(()=>fn(db));mutation=next.catch(()=>{});return next;
}} as unknown as Store;
const service=new CoordinatorService(store,{recallWithDiagnostics:async()=>{throw Error('No private recall in this fixture.');}});
const client=`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useCoordinator} from '/src/useCoordinator.ts';
import {coordinatorPendingKey} from '/src/coordinatorTransport.ts';
import {api,expectUser} from '/src/oneApi.ts';
import {CoordinatorConversation} from '/src/preview/CoordinatorConversation.tsx';
import {TaskTransferRail,visibleTransfers} from '/src/TaskTransferRail.tsx';
import '/src/styles.css';
expectUser('qa-user','qa-workspace');
function App(){
 const c=useCoordinator(api,'qa-user',true,'qa-workspace'),[draft,setDraft]=useState('帮我用昨天的思考写一篇专栏'),[notice,setNotice]=useState('');
 const tasks=[...(c.snapshot?.transfers||[]).filter(t=>t.running).map(t=>({id:'work:'+t.id,taskId:t.id,title:t.title,state:'running',reportable:false})),...(c.snapshot?.notices||[])];
 const act=async action=>{await fetch('/__qa/'+action,{method:'POST'});await c.refresh();};
 return <main className="one-studio coordinator-preview" style={{height:'100vh',display:'grid',gridTemplateColumns:'minmax(500px,1fr) 320px',gap:24,padding:24,background:'#dce5e9',color:'#203947'}}>
 <section style={{display:'flex',flexDirection:'column',minHeight:0}}><h1>任务回流 · 隔离验收</h1><small>合成资料，本页不连接生产环境、不调用供应商。</small>
 <CoordinatorConversation messages={c.state.dialogue} tasks={c.state.tasks} pending={!!c.state.pending} progress={c.progress} completed={c.settlement?.status==='completed'} onStop={c.stop} onOpen={()=>{}}/>
 <form onSubmit={async e=>{e.preventDefault();try{await c.submit({operationId:crypto.randomUUID(),text:draft});setNotice('原提交已核对');}catch(e){setNotice(e.message);}}}>
 <label>下一条草稿<input aria-label="下一条草稿" value={draft} onChange={e=>setDraft(e.target.value)}/></label><button disabled={!!c.state.pending}>发送隔离任务</button></form>
 <p role="status">{c.state.pending?'等待主回复':'主回复已同步'} · {notice}</p>{c.error?<p role="alert">{c.error}</p>:null}</section>
 <aside><TaskTransferRail tasks={tasks} busy={!!c.state.pending} onOpen={()=>{}} recentReportedReceiptIds={c.snapshot?.recentReportedReceiptIds}/>
 <button onClick={()=>act('finish')}>模拟缺昨日素材</button><button onClick={()=>act('release-detail')}>恢复任务详情</button>
 <button onClick={async()=>{const r=await(await fetch('/__qa/hold-snapshot',{method:'POST'})).json();if(r.operationId)localStorage.setItem(coordinatorPendingKey('qa-user','qa-workspace'),r.operationId);setNotice('列表已阻断，请刷新当前窗口验收原回执');}}>阻断首屏列表</button>
 <button onClick={()=>act('release-snapshot')}>恢复首屏列表</button>
 <button onClick={()=>{void c.refresh();}}>只读刷新原回执</button>
 <pre aria-label="验收计数">{JSON.stringify({pending:!!c.state.pending,messages:c.state.dialogue.length,visibleTasks:visibleTransfers(tasks).length,reported:c.snapshot?.recentReportedReceiptIds},null,2)}</pre></aside></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const vite=await createServer({configFile:false,plugins:[react(),{
 name:'isolated-task-feedback-qa',
 resolveId(id){if(id==='/__qa/client.tsx')return id;},
 load(id){if(id==='/__qa/client.tsx')return client;},
 configureServer(server){server.middlewares.use(async(req,res,next)=>{
  const url=new URL(req.url!,'http://localhost');
  if(url.pathname==='/__qa/'){
   res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml('/__qa/','<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>ONE 隔离任务回流验收</title></head><body><div id="root"></div><script type="module" src="/__qa/client.tsx"></script></body></html>'));return;
  }
  if(!url.pathname.startsWith('/api/coordinator')&&!url.pathname.startsWith('/__qa/'))return next();
  if(url.pathname==='/__qa/client.tsx')return next();
  const json=(data:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));};
  try{
   if(req.method==='POST'&&url.pathname==='/api/coordinator/messages'){
    let body='';for await(const part of req)body+=part;const input=JSON.parse(body);posts++;
    if(db.chatOperations!.some(o=>o.operationId===input.operationId))return json({status:'completed'});
    const user={id:'qa-question',role:'user' as const,content:input.text,createdAt:stamp()},reply={id:'qa-ack',role:'assistant' as const,content:'我先查昨天的素材，再整理成专栏。有结果或需要补充时，会在这里告诉你。',createdAt:stamp()};
    main.messages.push(user as never,reply as never);
    const task={...scope,id:'qa-article',modelId:'qa-model',title:'昨天思考的专栏',archived:false,messages:[user],createdAt:stamp(),updatedAt:stamp()};db.conversations.push(task);
    db.chatOperations!.push({...scope,id:'qa-dispatch',operationId:input.operationId,requestId:'coord_qa',payloadHash:'synthetic',status:'completed',conversationId:main.id,assistantMessageId:reply.id,dispatchedTaskId:task.id,createdAt:stamp(),updatedAt:stamp()},
     {...scope,id:'qa-work',operationId:'qa_work_operation',requestId:'work_qa',payloadHash:'synthetic',status:'pending',conversationId:task.id,workRun:{state:'running',kind:'text',inputMessageId:user.id,instruction:input.text,unread:false} as never,createdAt:stamp(),updatedAt:stamp()});
    staleSnapshots=2;return json({status:'pending',operationId:input.operationId});
   }
   if(req.method==='POST'&&url.pathname==='/__qa/finish'){
    const op=db.chatOperations!.find(o=>o.id==='qa-work'),task=db.conversations.find(c=>c.id==='qa-article');
    if(op?.workRun&&task&&op.workRun.state==='running'){
     const message={id:'qa-blocked',role:'assistant' as const,createdAt:stamp(),content:'还没有找到能确认属于昨天的思考素材，文章尚未写成。\n\n需要你补充：贴一段昨天的原始记录，或告诉我它在哪篇笔记里。已有说明已保存到 Notion，这不代表专栏已完成。'};
     task.messages.push(message);task.updatedAt=stamp();task.workPaused=true;
     op.workRun.state='failed';op.workRun.resultOutcome='needs_input';op.workRun.resultMessageId=message.id;op.workRun.unread=true;op.workRun.notionReceipt={state:'verified',url:'https://www.notion.so/00000000000000000000000000000000'};op.status='completed';op.updatedAt=stamp();
    }
    return json({ok:true});
   }
   if(req.method==='POST'&&url.pathname==='/__qa/release-detail'){holdDetail=false;return json({ok:true});}
   if(req.method==='POST'&&url.pathname==='/__qa/hold-snapshot'){holdSnapshot=true;return json({operationId:db.chatOperations!.find(o=>o.id==='qa-dispatch')?.operationId});}
   if(req.method==='POST'&&url.pathname==='/__qa/release-snapshot'){holdSnapshot=false;return json({ok:true});}
   if(url.pathname==='/__qa/metrics')return json({posts,markers:db.chatOperations!.filter(o=>o.requestId==='result_notice').length,main:db.conversations[0].messages});
   if(url.pathname==='/api/coordinator'){
    if(holdSnapshot){req.on('close',()=>res.end());return;}
    const snapshot=await service.state(scope);
    if(staleSnapshots-->0)snapshot.pendingOperationId=db.chatOperations!.find(o=>o.id==='qa-dispatch')?.operationId;
    return json(snapshot);
   }
   if(url.pathname.startsWith('/api/coordinator/messages/')){
    const op=db.chatOperations!.find(o=>o.operationId===decodeURIComponent(url.pathname.split('/').at(-1)!));
    if(!op){res.statusCode=404;return json({error:'No fixture receipt'});}
    return json({status:op.status,operationId:op.operationId,conversation:main,message:main.messages.find(m=>m.id===op.assistantMessageId),taskId:op.dispatchedTaskId});
   }
   if(url.pathname.startsWith('/api/coordinator/tasks/')){
    if(holdDetail){req.on('close',()=>res.end());return;}
    return json(await service.task(scope,decodeURIComponent(url.pathname.split('/').at(-1)!)));
   }
   if(req.method==='POST')return json({ok:true});
   res.statusCode=404;return json({error:'Unknown fixture route'});
  }catch(error){res.statusCode=500;json({error:error instanceof Error?error.message:'Fixture failure'});}
 });}
}],server:{host:'127.0.0.1',port:4399,strictPort:true}});
await vite.listen();
process.stdout.write('Synthetic browser QA: http://127.0.0.1:4399/__qa/\n');
