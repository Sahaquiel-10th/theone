import {useEffect,useRef,useState} from 'react';
import type {TeachingOperation,TeachingPublicActivity} from '../server/teachingTypes';
import type {StoryScript,StoryTurn} from '../server/teachingStories';
import {uploadTeachingBatch} from './teachingUploads';
import {isTeachingKnowledgeProblem} from './teachingStoryRequest';
import {TeachingStoryScene} from './TeachingStoryScene';
import './teaching-chat.css';

type Request=<T>(path:string,options?:RequestInit)=>Promise<T>;
function read(key:string){try{const raw=localStorage.getItem(key);if(!raw||raw.length>200000)return {};const value=JSON.parse(raw);return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}}
function save(key:string,value:unknown){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}}
const fail=(e:unknown)=>e instanceof Error?e.message:'暂未完成，请核对原回执。';
export function TeachingStoryStudio({activity,base,sessionId,request,shareBase,onPlay,onRepairSources,sourceRepairVersion=0}:{activity:TeachingPublicActivity;base:string;sessionId:string;request:Request;shareBase?:string;onPlay?:(id:string)=>void;onRepairSources?:()=>void;sourceRepairVersion?:number}){
 const key=`one:story-studio:${base}:${sessionId}:${activity.id}`,[saved]=useState(()=>read(key));
 const [script,setScript]=useState<string>(typeof saved.script==='string'?saved.script:''),[files,setFiles]=useState<{id:string;originalName:string}[]>(Array.isArray(saved.files)?saved.files:[]),[operation,setOperation]=useState<TeachingOperation>(),[pending,setPending]=useState<{operationId:string;payload:string}|undefined>(saved.pending),[busy,setBusy]=useState(false),[error,setError]=useState(''),[sourceProblem,setSourceProblem]=useState(false),[uploadStatus,setUploadStatus]=useState('');
 const req=useRef(request);req.current=request;const lock=useRef(false);
 useEffect(()=>{if(!sourceRepairVersion)return;setError('');setSourceProblem(false);setOperation(old=>old?.status==='failed'&&(isTeachingKnowledgeProblem({code:old.errorCode})||/知识授权|已选范围|重新选择.*资料/.test(old.error??''))?undefined:old);},[sourceRepairVersion]);
 useEffect(()=>{save(key,{script,files,pending});},[key,script,files,pending]);
 useEffect(()=>{let live=true;void req.current<{operations:TeachingOperation[]}>(`${base}/operations?activityId=${activity.id}`).then(r=>{if(live){setOperation(r.operations.find(o=>o.kind==='script'));}}).catch(e=>{if(live)setError(fail(e));});return()=>{live=false;};},[base,activity.id]);
 useEffect(()=>{if(operation?.status!=='running')return;let active=true;const timer=setTimeout(()=>void req.current<{operation:TeachingOperation}>(`${base}/operations/${operation.id}`).then(r=>{if(active)setOperation(r.operation);}).catch(e=>{if(active)setError(fail(e));}),1500);return()=>{active=false;clearTimeout(timer);};},[operation,base]);
 async function upload(list:FileList|null){if(!list?.length||lock.current)return;lock.current=true;setBusy(true);setError('');setUploadStatus('准备上传…');try{if(list.length+files.length>3)throw new Error('每份剧本最多3个文件。');await uploadTeachingBatch(req.current,base,Array.from(list),{onProgress:setUploadStatus,onUploaded:f=>{setFiles(v=>[...v,f]);}});}catch(e){setError(fail(e));}finally{lock.current=false;setBusy(false);setUploadStatus('');}}
 async function submit(){
  if(lock.current||operation?.status==='running')return;lock.current=true;setBusy(true);setError('');setSourceProblem(false);
  try{
   if(operation?.status==='uncertain'){
    const old=await req.current<{operation:TeachingOperation}>(`${base}/operations/${operation.id}`);setOperation(old.operation);
    if(old.operation.status==='uncertain')setError('上次审核结果仍待核对，尚未重新调用 AI。请先查看课程用量或核对原回执。');return;
   }
   const attempt=pending??{operationId:crypto.randomUUID(),payload:JSON.stringify({kind:'script',activityId:activity.id,content:script,attachmentIds:files.map(f=>f.id)})};
   setPending(attempt);if(!save(key,{script,files,pending:attempt}))throw new Error('未能保留本次提交编号，尚未调用 AI。请恢复浏览器存储后继续原提交。');
   if(pending){try{const old=await req.current<{operation:TeachingOperation}>(`${base}/operations/${attempt.operationId}`);setOperation(old.operation);setPending(undefined);return;}catch(e){if(!(e&&typeof e==='object'&&'status'in e&&e.status===404))throw e;}}
   const r=await req.current<{operation:TeachingOperation}>(`${base}/questions`,{method:'POST',body:JSON.stringify({...JSON.parse(attempt.payload),operationId:attempt.operationId})});setOperation(r.operation);setPending(undefined);
  }catch(e){const problem=isTeachingKnowledgeProblem(e);setSourceProblem(problem);if((e as {notStarted?:boolean})?.notStarted||problem||e&&typeof e==='object'&&'status'in e&&[400,401,403,413,422,429].includes(Number(e.status)))setPending(undefined);setError(fail(e));}
  finally{lock.current=false;setBusy(false);}
 }

 const review=operation?.result as StoryScript|undefined,ready=operation?.status==='completed'&&review?.approved;
 const shareUrl=new URL(shareBase||location.href);shareUrl.searchParams.set('activityId',activity.id);if(operation)shareUrl.searchParams.set('story',operation.id);
 const link=ready&&(!onPlay||shareBase)?shareUrl.href:'';

 return <section className="teaching-sheet teaching-story-studio"><header><span className="teaching-eyebrow">小人物走进大历史 · 学生创作</span><h2>上传剧本，生成五轮历史游戏</h2><p>先下载研究卡，查阅课程史料后填写并上传。AI会核对普通人身份、年代与史实，给出批注；通过后自动生成作品链接。</p></header><a role="button" href="/templates/hangzhou-history-story.txt" download="杭州历史情境剧本模板.txt">下载剧本模板（TXT）</a><label>剧本文字 / 补充的事件关键词<textarea value={script} maxLength={6000} disabled={busy||!!pending||operation?.status==='running'} onChange={e=>setScript(e.target.value)} placeholder="粘贴填好的研究卡，或上传 TXT、Markdown、Word、PDF 文件；可在这里写事件名称帮助检索。"/></label><label className="teaching-upload">上传填写后的剧本<input type="file" multiple accept=".txt,.md,.docx,.pdf" disabled={busy||!!pending||operation?.status==='running'} onChange={e=>{void upload(e.target.files);e.target.value='';}}/></label>{files.map(f=><div key={f.id}>{f.originalName}<button type="button" disabled={busy||!!pending||operation?.status==='running'} onClick={()=>setFiles(v=>v.filter(x=>x.id!==f.id))}>移除</button></div>)}<small>审核、导演方案、剧情和结局插画使用老师为课程开放的电力，受课程累计保护上限约束。未经证据核对的剧本不会发布。</small><button type="button" className="teaching-primary" disabled={busy||operation?.status==='running'||(!script.trim()&&!files.length&&!pending)} onClick={()=>void submit()}>{busy?(uploadStatus?'正在上传文件…':'正在确认并提交…'):operation?.status==='uncertain'?'核对上次审核回执':pending?'核对并继续原提交':operation?.status==='running'?'正在核对史料并构建游戏…':operation?.status==='completed'?'重新审核此原稿':'提交审核并生成游戏'}</button>{uploadStatus?<p className="teaching-message" role="status">{uploadStatus}</p>:files.length&&!busy&&!pending&&operation?.status!=='running'&&operation?.status!=='completed'&&!error?<p role="status">已上传 {files.length} 份剧本，点击提交开始审核。</p>:null}{error?<p role="alert">{error}</p>:null}{!busy&&!error&&(operation?.status==='failed'||operation?.status==='uncertain')?<p role="status">上次{operation.status==='uncertain'?'审核结果待核对':'审核未完成'}：{operation.error} 上传的原稿仍保留。</p>:null}{onRepairSources&&(sourceProblem||!busy&&!error&&operation?.status==='failed'&&(isTeachingKnowledgeProblem({code:operation.errorCode})||/知识授权|已选范围|重新选择.*资料/.test(operation.error??'')))?<button type="button" disabled={busy} onClick={onRepairSources}>重新确认课程资料</button>:null}{review?<section className="teaching-story-feedback"><h3>{ready?'审核通过 · 作品已生成':review.approved?'史实审核已完成 · 游戏尚未生成':'请修改后再次提交'}</h3><p>{review.feedback}</p>{review.annotations.map((a,i)=><div key={i}><blockquote>{a.excerpt}</blockquote><p>{a.comment}</p></div>)}{review.citations.length?<details><summary>审核参考的课程史料</summary>{review.citations.map((c,i)=><blockquote key={i}>{c.quote}</blockquote>)}</details>:null}{ready&&onPlay?<button type="button" className="teaching-primary" onClick={()=>onPlay(operation!.id)}>开始五轮试玩</button>:null}{link?<><a href={link}>打开《{review.title}》试玩</a><label>作品分享链接<input readOnly value={link}/></label><button type="button" onClick={()=>void navigator.clipboard.writeText(link).catch(()=>setError('请选中上方链接复制。'))}>复制作品链接</button></>:null}</section>:null}</section>;
}
export function TeachingStoryPlayer({storyId,activity,base,sessionId,request,onDirty}:{storyId:string;activity:TeachingPublicActivity;base:string;sessionId:string;request:Request;onDirty?:(dirty:boolean)=>void}){
 const key=`one:story-play:${base}:${sessionId}:${activity.id}:${storyId}`,[initial]=useState(()=>read(key));
 const [runId,setRunId]=useState<string>(typeof initial.runId==='string'&&/^[A-Za-z0-9_-]{16,100}$/.test(initial.runId)?initial.runId:crypto.randomUUID()),[story,setStory]=useState<StoryScript>(),[operations,setOperations]=useState<TeachingOperation[]>([]),[pending,setPending]=useState<{operationId:string;kind:string;content:string}|undefined>(initial.pending),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const req=useRef(request);req.current=request;const lock=useRef(false);
 useEffect(()=>{save(key,{runId,pending});},[key,runId,pending]);
 async function load(){const r=await req.current<{operations:TeachingOperation[]}>(`${base}/operations?activityId=${activity.id}&runId=${runId}&storyId=${encodeURIComponent(storyId)}`);setOperations(r.operations.slice().reverse());return r.operations;}
 useEffect(()=>{let active=true;void req.current<{story:StoryScript}>(`${base}/stories/${encodeURIComponent(storyId)}?activityId=${activity.id}`).then(r=>{if(active)setStory(r.story);}).catch(e=>{if(active)setError(fail(e));});void load().catch(e=>{if(active)setError(fail(e));});return()=>{active=false;};},[storyId,runId]);
 const working=operations.some(o=>o.status==='running');
 useEffect(()=>{onDirty?.(busy||working||!!pending);},[busy,working,pending,onDirty]);
 useEffect(()=>{if(!working)return;const timer=setTimeout(()=>{const running=operations.find(o=>o.status==='running')!;void req.current(`${base}/operations/${running.id}`).then(load).catch(e=>setError(fail(e)));},1500);return()=>clearTimeout(timer);},[operations,working]);
 const turns=operations.filter(o=>o.kind==='story_turn'),last=turns.filter(o=>o.status==='completed').at(-1)?.result as StoryTurn|undefined,image=operations.find(o=>o.kind==='story_image');
 async function send(kind='story_turn',content='开始第一幕'){if(lock.current||working)return;lock.current=true;setBusy(true);setError('');const attempt=pending??{operationId:kind==='story_image'?`${runId}_image`:crypto.randomUUID(),kind,content};setPending(attempt);save(key,{runId,pending:attempt});try{const r=await req.current<{operation:TeachingOperation}>(`${base}/questions`,{method:'POST',body:JSON.stringify({...attempt,activityId:activity.id,storyId,runId})});setOperations(v=>[...v.filter(o=>o.id!==r.operation.id),r.operation]);setPending(undefined);await load();}catch(e){if(e&&typeof e==='object'&&'status'in e&&[400,401,403,404,409,422,429].includes(Number(e.status)))setPending(undefined);setError(fail(e));}finally{lock.current=false;setBusy(false);}}
 // One deterministic image receipt per play; recovering a page never creates a second charge.
 useEffect(()=>{if(last?.ended&&!image&&!pending&&!busy&&!error)void send('story_image','生成本局结局插画');},[last?.ended,image?.id]);
 return <TeachingStoryScene story={story} turns={turns} last={last} image={image} busy={busy} working={working} pending={!!pending} error={error} onAction={choice=>void send('story_turn',choice??'开始第一幕')} onRecover={()=>void send()} onImage={()=>void send('story_image','生成本局结局插画')} onRestart={()=>{setRunId(crypto.randomUUID());setOperations([]);setError('');}}/>;
}
