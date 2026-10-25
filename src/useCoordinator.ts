import { useCallback, useEffect, useMemo, useRef } from "react";
import type { api as Api } from "./oneApi";
import { ApiError } from "./oneApi";
import { approveFeaturePrices } from './FeatureBudgetSettings';
import { coordinatorMessage } from './coordinatorMessage';
import {coordinatorRecoveryCopy} from './coordinatorRecovery';
import {chatSubmission,forgetChatSubmission} from './chatSubmission';
import {receiptMayBeMissing} from './responseProgressState';
import {applyReviewedReceipts} from './taskTransferLifecycle';
import {mergeCoordinatorMessages, mergeCoordinatorLinks, mergeCoordinatorReceipt, seedCoordinatorReceipt, coordinatorHistoryCursor, type CoordinatorReceipt} from './coordinatorHistory';
import {coordinatorPendingKey,coordinatorRequest, createCoordinatorRefreshQueue, forgetStoredCoordinatorOperation} from './coordinatorTransport';
import {useCoordinatorScopedState} from './coordinatorScopedState';
import {coordinatorDetailReadIsCurrent,coordinatorDetailRefreshPlan,coordinatorDetailVersion,type CoordinatorDetailVersion} from './coordinatorDetailRefresh';
import {viewCoordinatorTask} from './coordinatorTaskView';
import type { Conversation } from "../server/types";
import type {
  Action,
  PreviewState,
  Task,
} from "./preview/dispatchPreviewState";

type Meta = {
  id: string;
  title: string;
  updatedAt: string;
  executorId?: string;
  queued: number;
  running: boolean;
  paused?: boolean;
  state?: string;
  localPrepared?: boolean;
  phase?: string;
  reconciling?:boolean;
};
type Notice = {
  id: string;
  updatedAt?: string;
  taskId: string;
  title?: string;
  state: string;
  resultMessageId?: string;
  reported?: boolean;
  read?: boolean;
  outcome?: string;
  notionReceipt?:import('./taskRecovery').NotionReceiptView;
};
type Snapshot = {
  clientScope?: string;
  history?: {hasMore:boolean;before?:string;total:number};
  enabled: boolean;
  conversation: Conversation | null;
  tasks: Meta[];
  total: number;
  notices: Notice[];
  pendingOperationId?: string;
  links?: { messageId: string; taskId: string }[];
  transfers?: Meta[];
  recentReportedReceiptIds?: string[];
};
type Job = {
  budget?:number;
  kind?:string;
  retryPower?:number;
  notionReceipt?:import('./taskRecovery').NotionReceiptView;
  id: string;
  operationId: string;
  state: string;
  inputMessageId: string;
  instruction?: string;
  error?: string;
  userReport?:string;
  dependencyBlocked?:boolean;
  verificationPending?:boolean;
  dependenciesReady?:boolean;
  waitingFor?:{taskId:string;title:string}[];
  progress?:{completed:string[];pending:string[]};
};
type Detail = { conversation: Conversation; jobs: Job[]; recovery?: import('./taskRecovery').TaskRecovery };
export type CoordinatorSubmission = {
  outputDestination?: 'chat' | 'notion';
  featureApprovals?: import('../server/featurePricing').FeatureApproval[];
  localExecution?: boolean;
  operationId: string;
  text: string;
  modelId?: string;
  boundTaskId?: string;
  featureIds?: string[];
  attachmentIds?: string[];
  confirmedExternal?: boolean;
  webSearch?: boolean;
};
export function useCoordinator(
  api: typeof Api,
  userId: string,
  enabled: boolean,
  workspaceId = '',
) {
  const scope=useMemo(()=>({userId,api,workspaceId}),[userId,api,workspaceId]);
  const boundedApi=useMemo(()=>(<T,>(path:string,options?:RequestInit)=>coordinatorRequest<T>(api,path,options)),[api]);
  const pendingKey=useCallback((user:string)=>coordinatorPendingKey(user,workspaceId),[workspaceId]);
  const submissionScope=`coordinator:${userId}${workspaceId?':'+encodeURIComponent(workspaceId):''}`;
  const [storedSnapshot, setSnapshot] = useCoordinatorScopedState<Snapshot | null>(scope,null),
    [ready,setReady] = useCoordinatorScopedState(scope,false),
    [loadingHistory,setLoadingHistory] = useCoordinatorScopedState(scope,false),
    [historyError,setHistoryError] = useCoordinatorScopedState(scope,''),
    [outgoing, setOutgoing] = useCoordinatorScopedState<{id:string;text:string;priorIds:string[];failed?:boolean} | null>(scope,null),
    [progress, setProgress] = useCoordinatorScopedState<{phase:string;startedAt:string} | null>(scope,null),
    [details, setDetails] = useCoordinatorScopedState<Record<string, Detail>>(scope,{}),
    [selected, setSelected] = useCoordinatorScopedState<string | null>(scope,null),
    [bound, setBound] = useCoordinatorScopedState<string | null>(scope,null),
    [localPending, setPending] = useCoordinatorScopedState<string | null>(scope,null),
    [error, setError] = useCoordinatorScopedState(scope,""),
    [failureReply,setFailureReply]=useCoordinatorScopedState<{scope:string;operationId:string;text:string}|null>(scope,null),
    [settlement, setSettlement] = useCoordinatorScopedState<{operationId:string;status:string;taskId?:string;taskIds?:string[]} | null>(scope,null),
    [page, setPage] = useCoordinatorScopedState(scope,1);
  const snapshot=storedSnapshot?.clientScope===userId?storedSnapshot:null;
  const scopeRef=useRef(scope);scopeRef.current=scope;
  const live = useRef(true),
    sending = useRef<string|null>(null),
    pendingRef = useRef<string|null>(null),
    snapshotRef = useRef(snapshot),
    detailsRef = useRef(details),
    selectedRef = useRef(selected),
    pageRef = useRef(1),
    submissionError = useRef(""),
    resumeKey = useRef("");
  const settledReceipts=useMemo(()=>new Map<string,CoordinatorReceipt>(),[scope]);
  const directReceipts=useMemo(()=>({current:new Map<string,string>()}),[scope]);
  const receiptReads=useMemo(()=>new Map<string,Promise<void>>(),[scope]);
  const detailReads=useMemo(()=>new Map<string,Promise<Detail>>(),[scope]);
  const detailVersions=useMemo(()=>new Map<string,CoordinatorDetailVersion>(),[scope]);
  const detailReadRevisions=useMemo(()=>new Map<string,number>(),[scope]);
  const viewedTask=useMemo(()=>({current:undefined as string|null|undefined}),[scope]);
  const refreshRevision=useRef(0);
  const isCurrent=useCallback(()=>live.current&&scopeRef.current===scope,[scope]);
  const setCurrentPending=useCallback((value:string|null)=>{if(!isCurrent())return;pendingRef.current=value;setPending(value);},[isCurrent,setPending]);
  const resumeAt = useRef(0);
  const retrying=useMemo(()=>({current:new Set<string>()}),[scope]);
  const [retryingTasks,setRetryingTasks]=useCoordinatorScopedState<string[]>(scope,[]);
  const [removedTask,setRemovedTask] = useCoordinatorScopedState<string|null>(scope,null);
  snapshotRef.current = snapshot;
  detailsRef.current = details;
  selectedRef.current = selected;
  const load = useCallback(
    async (id: string,force=false,observed?:CoordinatorDetailVersion) => {
      if(!isCurrent())throw new ApiError('登录账号已切换，旧页面的操作已取消',undefined,409,'SESSION_CHANGED');
      const existing=detailReads.get(id);
      if(existing&&!force)return existing;
      const version=observed??coordinatorDetailVersion(id,[...(snapshotRef.current?.tasks??[]),...(snapshotRef.current?.transfers??[])],snapshotRef.current?.notices??[]);
      const revision=(detailReadRevisions.get(id)??0)+1;detailReadRevisions.set(id,revision);
      const request=(async()=>{
        let detail: Detail;
        try {
          detail = await coordinatorRequest<Detail>(api,`/api/coordinator/tasks/${encodeURIComponent(id)}`);
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 400 || !isCurrent()) throw e;
          detail = {...(await coordinatorRequest<{conversation:Conversation}>(api,`/api/conversations/${encodeURIComponent(id)}`)),jobs: []};
        }
        if(!isCurrent())throw new ApiError('登录账号已切换，旧页面的操作已取消',undefined,409,'SESSION_CHANGED');
        if(coordinatorDetailReadIsCurrent(detailReadRevisions,id,revision)){
          detailVersions.set(id,version);
          setDetails((old) => coordinatorDetailReadIsCurrent(detailReadRevisions,id,revision)?({ ...old, [id]: detail }):old);
        }
        return detail;
      })();
      detailReads.set(id,request);
      try{return await request;}finally{if(detailReads.get(id)===request)detailReads.delete(id);}
    },
    [api,detailReads,detailVersions,detailReadRevisions,isCurrent,setDetails],
  );
  const viewTask=useCallback((id:string|null)=>viewCoordinatorTask(id,{isCurrent,load,select:taskId=>{viewedTask.current=taskId;}}),[isCurrent,load,viewedTask]);
  const acceptReceipt=useCallback((operation:string,status:CoordinatorReceipt)=>{
    if(!isCurrent())return;
    if(status.conversation&&(status.conversation.userId!==userId||workspaceId&&status.conversation.workspaceId!==workspaceId))return;
    if(status.status==='pending'){
      if(settledReceipts.has(operation)||pendingRef.current&&pendingRef.current!==operation)return;
      setCurrentPending(operation);
      setProgress(old=>status.progress||old||{phase:'正在等待处理结果',startedAt:snapshotRef.current?.conversation?.messages.at(-1)?.createdAt||new Date().toISOString()});
      return;
    }
    settledReceipts.set(operation,{...status,...(status.conversation?{conversation:{...status.conversation,messages:status.conversation.messages.slice(-40)}}:{})});
    if(settledReceipts.size>100)settledReceipts.delete(settledReceipts.keys().next().value!);
    if(sending.current===operation)sending.current=null;
    if(pendingRef.current===operation){setCurrentPending(null);setProgress(null);}
    setSettlement({operationId:operation,status:status.status,taskId:status.taskId,taskIds:status.taskIds});
    forgetStoredCoordinatorOperation(localStorage,pendingKey(userId),operation);
    forgetChatSubmission(submissionScope,operation);
    setSnapshot(old=>{
      if(old?.clientScope===userId)return mergeCoordinatorReceipt(old,operation,status);
      // A recovered server receipt is enough to show its saved answer while the
      // first snapshot is offline. An explicitly empty server conversation is not.
      if(old===null&&status.status==='completed'&&status.conversation){
        return seedCoordinatorReceipt(userId,operation,status);
      }
      return old;
    });
    if(status.status!=='completed'){
      setOutgoing(old=>old?.id===operation?{...old,failed:true}:old);
      setFailureReply({scope:userId,operationId:operation,text:coordinatorRecoveryCopy(status.error??'',status.status==='interrupted')});
      submissionError.current='';setError('');
    }else setFailureReply(old=>old?.scope===userId&&old.operationId===operation?null:old);
  },[isCurrent,setCurrentPending,settledReceipts,userId,workspaceId,pendingKey,submissionScope,setSnapshot,setSettlement,setProgress,setOutgoing,setFailureReply,setError]);
  const readReceipt=useCallback((operation:string,serverOperation?:string)=>{
    const existing=receiptReads.get(operation);
    if(existing)return existing;
    const request=(async()=>{
      try{
        const status=await coordinatorRequest<CoordinatorReceipt>(api,`/api/coordinator/messages/${encodeURIComponent(operation)}`);
        acceptReceipt(operation,status);
      }catch(e){
        if(!isCurrent())return;
        if(e instanceof ApiError&&e.status===404){
          if(!receiptMayBeMissing(sending.current===operation,serverOperation,operation)||pendingRef.current&&pendingRef.current!==operation)return;
          forgetStoredCoordinatorOperation(localStorage,pendingKey(userId),operation);
          if(pendingRef.current===operation){setCurrentPending(null);setProgress(null);}
          setOutgoing(old=>old?.id===operation?{...old,failed:true}:old);
          setFailureReply({scope:userId,operationId:operation,text:coordinatorRecoveryCopy('暂未找到接收记录')});
          submissionError.current='';setError('');
          return;
        }
        throw e;
      }
    })();
    receiptReads.set(operation,request);
    void request.finally(()=>{if(receiptReads.get(operation)===request)receiptReads.delete(operation);}).catch(()=>{});
    return request;
  },[acceptReceipt,api,isCurrent,receiptReads,setCurrentPending,userId,pendingKey,setProgress,setOutgoing,setFailureReply,setError]);
  const performRefresh = useCallback(
    async (nextPage = 1) => {
      if (!enabled || !isCurrent()) return;
      const revision=++refreshRevision.current;
      let persisted:string|null=null;
      try{persisted=localStorage.getItem(pendingKey(userId));}catch{}
      const operation=pendingRef.current||persisted||snapshotRef.current?.pendingOperationId;
      // Receipt recovery must not wait behind task details, history pages or even a stalled snapshot.
      const receipt=operation&&!settledReceipts.has(operation)?readReceipt(operation,snapshotRef.current?.pendingOperationId):Promise.resolve();
      const snapshotRead=(async()=>{
        const next=await coordinatorRequest<Snapshot>(api,'/api/coordinator?page=1');
        if (!isCurrent()) return;
        setReady(true);
        if(next.pendingOperationId&&settledReceipts.has(next.pendingOperationId))next.pendingOperationId=undefined;
        setSnapshot((old) => {
          let merged:Snapshot={
          ...next,
          clientScope:userId,
          ...(old?.clientScope===userId&&old.conversation?.id===next.conversation?.id&&next.conversation?{
            conversation:{...next.conversation,messages:mergeCoordinatorMessages(old.conversation!.messages,next.conversation.messages)},
            links:mergeCoordinatorLinks(old.links??[],next.links??[]),
            history:coordinatorHistoryCursor(old.conversation!.messages,next.conversation.messages,old.history,next.history),
          }:{}),
          tasks:pageRef.current>1||nextPage>1?[...next.tasks,...(old?.clientScope===userId?old.tasks:[]).filter(t=>!next.tasks.some(n=>n.id===t.id))]:next.tasks,
          };
          for(const [id,result] of settledReceipts)merged=mergeCoordinatorReceipt(merged,id,result);
          return merged;
        });
        pageRef.current = Math.max(nextPage, pageRef.current);
        setPage(pageRef.current);
        setError(submissionError.current);
        const affected=coordinatorDetailRefreshPlan({selected:viewedTask.current===undefined?selectedRef.current:viewedTask.current,tasks:[...next.tasks,...(next.transfers??[])],notices:next.notices,details:detailsRef.current,loadedVersions:detailVersions});
        // A slow/offline detail must never freeze sending feedback or the whole polling loop.
        void Promise.all(
          affected.map(({id,version}) => load(id,false,version).catch(() => undefined)),
        );
        const additionalPages=Array.from({length:pageRef.current-1},(_,i)=>coordinatorRequest<Snapshot>(api,`/api/coordinator?page=${i+2}`).catch(()=>null));
        if(additionalPages.length)void Promise.all(additionalPages).then(pages=>{
          if(!isCurrent()||refreshRevision.current!==revision)return;
          const incoming=pages.flatMap(p=>p?.tasks??[]);
          setSnapshot(old=>old?.clientScope===userId?{...old,tasks:[...new Map([...(pages.some(p=>!p)?old.tasks:[]),...next.tasks,...incoming].map(t=>[t.id,t])).values()]}:old);
        });
        const queued = next.tasks
          .filter((t) => t.queued > 0 && !t.paused)
          .map((t) => `${t.id}:${t.queued}:${t.updatedAt}`)
          .join("|");
        if (next.enabled && queued && (queued !== resumeKey.current || Date.now()-resumeAt.current >= 15000)) {
          resumeKey.current = queued;
          resumeAt.current = Date.now();
          void coordinatorRequest(api,"/api/coordinator/resume", {
            method: "POST",
            body: "{}",
          }).catch(() => {
            if(isCurrent())resumeKey.current = "";
          });
        }
        if(next.pendingOperationId&&!settledReceipts.has(next.pendingOperationId))await readReceipt(next.pendingOperationId,next.pendingOperationId);
      })();
      const results=await Promise.allSettled([snapshotRead,receipt]);
      if(!isCurrent())return;
      const failed=results.find(result=>result.status==='rejected');
      if(failed?.status==='rejected')setError(failed.reason instanceof Error?failed.reason.message:'连接暂时不可用');
    },
    [api, enabled, isCurrent, load, readReceipt, settledReceipts, detailVersions, viewedTask, userId, pendingKey,setSnapshot,setReady,setPage,setError],
  );
  const refreshQueue=useMemo(()=>createCoordinatorRefreshQueue(performRefresh),[performRefresh]);
  const refresh=useCallback((nextPage=1)=>{
    // A prior snapshot may still be waiting when a new submission is accepted.
    // Probe its receipt now, rather than waiting for that older refresh's deadline.
    let persisted:string|null=null;
    try{persisted=localStorage.getItem(pendingKey(userId));}catch{}
    const operation=pendingRef.current||persisted||snapshotRef.current?.pendingOperationId;
    if(enabled&&isCurrent()&&operation&&!settledReceipts.has(operation))void readReceipt(operation,snapshotRef.current?.pendingOperationId).catch(e=>{if(isCurrent())setError(e instanceof Error?e.message:'连接暂时不可用');});
    return refreshQueue.request(nextPage);
  },[enabled,isCurrent,readReceipt,refreshQueue,settledReceipts,userId,pendingKey,setError]);
  useEffect(()=>{
    pendingRef.current=null;sending.current=null;snapshotRef.current=null;detailsRef.current={};selectedRef.current=null;
    pageRef.current=1;resumeKey.current='';submissionError.current='';
    setSnapshot(null);setReady(false);setDetails({});setSelected(null);setBound(null);setPending(null);setProgress(null);
    setOutgoing(null);setFailureReply(null);setSettlement(null);setError('');setHistoryError('');setLoadingHistory(false);setPage(1);
  },[scope]);
  useEffect(() => {
    live.current = true;
    if (!enabled) return;
    refreshQueue.activate();
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    const focus = () => void refresh();
    const visibility = () => {if(document.visibilityState==='visible')void refresh();};
    const storage = (event:StorageEvent) => {if(event.key===pendingKey(userId))void refresh();};
    window.addEventListener("focus", focus);
    window.addEventListener('online',focus);
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('storage',storage);
    return () => {
      live.current = false;
      refreshQueue.dispose();
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener('online',focus);
      document.removeEventListener('visibilitychange',visibility);
      window.removeEventListener('storage',storage);
    };
  }, [enabled, refresh, refreshQueue, userId,pendingKey]);
  async function loadHistory() {
    const current=snapshotRef.current;
    if(loadingHistory||current?.clientScope!==userId||!current.history?.hasMore||!current.history.before||!current.conversation)return;
    setLoadingHistory(true);setHistoryError('');
    try {
      const page=await coordinatorRequest<{conversationId:string;messages:Conversation['messages'];history:NonNullable<Snapshot['history']>;links:{messageId:string;taskId:string}[]}>(api,`/api/coordinator/history?before=${encodeURIComponent(current.history.before)}`);
      if(!isCurrent())return;
      setSnapshot(old=>old?.clientScope===userId&&old.conversation?.id===page.conversationId?{...old,conversation:{...old.conversation,messages:mergeCoordinatorMessages(page.messages,old.conversation.messages)},history:page.history,links:mergeCoordinatorLinks(page.links,old.links??[])}:old);
    }catch(e){if(isCurrent())setHistoryError(e instanceof Error?e.message:'更早的记录暂时没打开，可以再试一次');}
    finally{if(isCurrent())setLoadingHistory(false);}
  }
  async function submit(input: CoordinatorSubmission) {
    if (
      sending.current ||
      pendingRef.current ||
      snapshotRef.current?.pendingOperationId&&!settledReceipts.has(snapshotRef.current.pendingOperationId)
    )
      throw Error("ONE 正在承接上一句话，请稍候");
    sending.current = input.operationId;
    setOutgoing({id:input.operationId,text:input.text,priorIds:snapshotRef.current?.conversation?.messages.map(m=>m.id!)||[]});
    setProgress({phase:'正在发送你的要求',startedAt:new Date().toISOString()});
    setCurrentPending(input.operationId);
    submissionError.current = "";
    setFailureReply(null);
    setError("");
    try {
      input={...input,operationId:await chatSubmission(submissionScope,{...input,operationId:undefined})};
      if(!isCurrent())throw new ApiError('登录账号已切换，旧页面的操作已取消',undefined,409,'SESSION_CHANGED');
      sending.current=input.operationId;
      setCurrentPending(input.operationId);
      setOutgoing(old=>old?{...old,id:input.operationId}:old);
      try {localStorage.setItem(pendingKey(userId), input.operationId);}catch{}
      const result=await coordinatorRequest<CoordinatorReceipt>(api,"/api/coordinator/messages", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if(!isCurrent())throw new ApiError('登录账号已切换，旧页面的操作已取消',undefined,409,'SESSION_CHANGED');
      acceptReceipt(input.operationId,result);
      submissionError.current='';setError('');
      await refresh();
      return input.operationId;
    } catch (e) {
      if(!isCurrent()||e instanceof ApiError&&e.code==='SESSION_CHANGED')throw e;
      if(settledReceipts.get(input.operationId)?.status==='completed')return input.operationId;
      await refresh();
      if(!isCurrent())throw e;
      // A response may be lost after the server saved the reply. Reconcile the
      // same receipt before adding a fallback; never send the request again.
      try {
        const receipt=await coordinatorRequest<CoordinatorReceipt>(api,`/api/coordinator/messages/${encodeURIComponent(input.operationId)}`);
        if(!isCurrent())throw e;
        acceptReceipt(input.operationId,receipt);
        if(receipt.status==='completed'){setFailureReply(null);submissionError.current='';setError('');return input.operationId;}
        if(receipt.status==='pending'){submissionError.current='';setError('');if(input.localExecution)throw e;return input.operationId;}
      } catch {if(!isCurrent())throw e;}
      setOutgoing(old=>old?.id===input.operationId?{...old,failed:true}:old);
      setFailureReply({scope:userId,operationId:input.operationId,text:coordinatorRecoveryCopy(e instanceof Error?e.message:'')});
      submissionError.current='';setError('');
      if(input.localExecution)throw e;
      return input.operationId;
    } finally {
      if(isCurrent()&&sending.current===input.operationId)sending.current = null;
    }
  }
  async function direct(
    id: string,
    text: string,
    attachmentIds: string[] = [],
    outputDestination?: 'chat' | 'notion',
  ) {
    setError("");
    const receiptKey = JSON.stringify([userId,workspaceId,id,text,attachmentIds,outputDestination]);
    const featureApprovals=await approveFeaturePrices(boundedApi,[],id);
    if(!isCurrent())throw new ApiError('登录账号已切换，旧页面的操作已取消',undefined,409,'SESSION_CHANGED');
    const storageKey = `one-task-operation:${userId}:${encodeURIComponent(workspaceId)}:${id}`;
    let operationId = directReceipts.current.get(receiptKey);
    if(!operationId) {
      try { const saved=JSON.parse(localStorage.getItem(storageKey)||"null");
        const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(receiptKey));
        const fingerprint=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,"0")).join("");
        operationId=saved?.fingerprint===fingerprint?saved.operationId:crypto.randomUUID();
        localStorage.setItem(storageKey,JSON.stringify({fingerprint,operationId}));
      } catch { operationId=crypto.randomUUID(); }
      directReceipts.current.set(receiptKey,operationId!);
    }
    if(!isCurrent())throw new ApiError('登录账号已切换，旧页面的操作已取消',undefined,409,'SESSION_CHANGED');
    try{
      await coordinatorRequest(api,`/api/coordinator/tasks/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ operationId, text, attachmentIds, featureApprovals, outputDestination }),
      });
    }catch(e){
      if(!isCurrent())throw e;
      let accepted=false;
      try{const detail=await load(id,true);accepted=detail.jobs.some(job=>job.operationId===operationId);}catch{/* Keep the original request identifier when its outcome is unknown. */}
      if(!isCurrent())throw e;
      if(!accepted){
        const message='这次续写是否收到还没确认，原话和原提交都保留着；先查看任务进展，不用重发。';
        setError(message);void refresh();
        throw new ApiError(message,undefined,undefined,'COORDINATOR_DIRECT_UNCONFIRMED',false);
      }
    }
    // A slow details panel must not keep an accepted follow-up stuck forever.
    void load(id,true).catch(e=>{if(isCurrent())setError(e instanceof Error?e.message:'任务进度暂时没连上，可以稍后查看。');});
    await refresh();
    if(!isCurrent())return;
    directReceipts.current.delete(receiptKey);
    try { localStorage.removeItem(storageKey); } catch {}
  }
  async function acknowledge(taskId?: string, receiptIds?: string[]) {
    const ids = (snapshotRef.current?.notices ?? [])
      .filter((n) => !n.read && (!taskId || n.taskId === taskId) && (!receiptIds || receiptIds.includes(n.id)))
      .map((n) => n.id);
    if (!ids.length) return;
    await api("/api/coordinator/notices/read", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    if(!isCurrent())return;
    setSnapshot((old) =>
      old
        ? { ...old, notices: applyReviewedReceipts(old.notices,ids) }
        : old,
    );
  }
  async function readAll() {
    const result=await api<{ids:string[];count:number}>("/api/coordinator/notices/read-all",{method:"POST",body:"{}"});
    if(!isCurrent())return;
    setSnapshot(old=>old?{...old,notices:applyReviewedReceipts(old.notices,result.ids)}:old);
    await refresh();
  }
  async function resumeTask(id: string, latestOnly = false) {
    await api("/api/coordinator/resume", {
      method: "POST",
      body: JSON.stringify({ continueTaskId: id, confirmed: true, latestOnly }),
    });
    await load(id);
    await refresh();
  }
  async function retryTask(id:string,budget?:number,confirmedJobId?:string) {
    if(retrying.current.has(id))return;
    retrying.current.add(id);
    setRetryingTasks([...retrying.current]);
    try{
    const detail=await load(id),job=detail.jobs.at(-1);
    if(!job)throw new Error('此任务没有可重新处理的要求');
    if(confirmedJobId&&job.id!==confirmedJobId)throw new Error('任务已有新要求或进展，请重新看一眼再确认。');
    if(!detail.recovery||!['retry','resume','review_image'].includes(detail.recovery.kind))throw new Error(detail.recovery?.message||'请刷新后查看任务恢复方式');
    const featureApprovals=await approveFeaturePrices(boundedApi,[],id);
    await api(`/api/coordinator/tasks/${encodeURIComponent(id)}/retry`,{method:'POST',body:JSON.stringify({sourceJobId:job.id,confirmed:true,featureApprovals,budget})});
    await load(id);await refresh();
    }finally{retrying.current.delete(id);if(isCurrent())setRetryingTasks([...retrying.current]);}
  }
  function dispatch(action: Action) {
    if (action.type === "select") {
      setSelected(action.taskId);
      const id = action.taskId;
      if (id)
        void load(id)
          .then(() => acknowledge(id))
          .catch((e) => {if(isCurrent())setError(e.message);});
    } else if (action.type === "bind") setBound(action.taskId);
  }
  const metas = [...new Map([...(snapshot?.tasks ?? []),...(snapshot?.transfers ?? [])].map(t=>[t.id,t])).values()];
  for(const notice of snapshot?.notices ?? []) {
    const c=details[notice.taskId]?.conversation;
    if(c&&!metas.some(t=>t.id===c.id)) metas.push({id:c.id,title:c.title,updatedAt:c.updatedAt,queued:0,running:false});
  }
  const tasks: Task[] = metas.map((meta) => {
    const detail = details[meta.id],
      notice = snapshot?.notices.find((n) => n.taskId === meta.id),
      jobs = detail?.jobs ?? [];
    return {
      id: meta.id,
      title: meta.title,
      messages: (detail?.conversation.messages ?? []).map((m) => ({
        ...coordinatorMessage(m),
        status:
          jobs.find((j) => j.inputMessageId === m.id)?.state === "queued"
            ? "queued"
            : "done",
      })),
      active: [],
      queue: jobs
        .filter((j) => j.state === "queued")
        .map((j) => j.inputMessageId),
      dueAt: null,
      round: jobs.length,
      status: meta.running
        ? "running"
        : meta.paused ? "failed"
        : notice?.state === "failed" || notice?.state === "interrupted"
          ? "failed"
          : jobs.some((j) => j.state === "completed")
            ? "completed"
            : "idle",
      result: "",
      unread: (snapshot?.notices ?? []).some(n=>n.taskId===meta.id&&!n.read),
    };
  });
  const state: PreviewState = {
    tasks,
    dialogue: [...(snapshot?.conversation?.messages ?? []).map((m) => ({
      ...coordinatorMessage(m),
      taskId: snapshot?.links?.find((l) => l.messageId === m.id)?.taskId,
      taskIds: [...new Set(snapshot?.links?.filter(l => l.messageId === m.id).map(l => l.taskId) ?? [])],
    })), ...(outgoing && !snapshot?.conversation?.messages.some(m=>m.role==='user'&&!outgoing.priorIds.includes(m.id!)&&m.content===outgoing.text) ? [{id:`outgoing_${outgoing.id}`,role:'user' as const,text:outgoing.text,status:outgoing.failed?'failed' as const:undefined,featureName:outgoing.failed?'发送状态待确认 · 原话保留':'发送中'}] : []),...(failureReply?.scope===userId?[{id:`feedback_${failureReply.operationId}`,role:'assistant' as const,text:failureReply.text}]:[])],
    pending:
      (localPending&&!settledReceipts.has(localPending)) || (snapshot?.pendingOperationId&&!settledReceipts.has(snapshot.pendingOperationId))
        ? {
            id: localPending || snapshot!.pendingOperationId!,
            text: "",
            target: null,
            dueAt: 0,
            notices: [],
          }
        : null,
    notices: [],
    selected,
    boundTask: bound,
    lastTarget: null,
    draft: "",
    schedulerMs: 0,
    workerMs: 0,
    manual: false,
  };
  return {
    enabled: enabled && snapshot?.enabled === true,
    ready,
    state,
    dispatch,
    submit,
    direct,
    load,
    viewTask,
    refresh,
    acknowledge,
    readAll,
    report: async (ids: string[]) => { const result=await api<{deferred?:boolean}>("/api/coordinator/reports", { method: "POST", body: JSON.stringify({ ids }) }); await refresh(); return !result.deferred; },
    resumeTask,
    retryTask,
    retryingTasks,
    removedTask,
    removeTask: async (id:string) => {
      await api(`/api/coordinator/tasks/${encodeURIComponent(id)}`,{method:'DELETE'});
      if(!isCurrent())return;
      setRemovedTask(id); if(selectedRef.current===id)setSelected(null);if(bound===id)setBound(null);
      setDetails(old=>{const next={...old};delete next[id];return next;});await refresh();
    },
    restoreTask: async () => {if(!removedTask)return;await api(`/api/coordinator/tasks/${encodeURIComponent(removedTask)}/restore`,{method:'POST',body:'{}'});if(!isCurrent())return;setRemovedTask(null);await refresh();},
    error:error||historyError,
    settlement,
    clearError: () => {setError("");setHistoryError('');},
    progress,
    stop: async () => {const id=localPending||snapshotRef.current?.pendingOperationId;if(!id)return;await api(`/api/coordinator/messages/${encodeURIComponent(id)}/stop`,{method:'POST',body:'{}'});await refresh();},
    stopTask: async (id:string) => {await api(`/api/coordinator/tasks/${encodeURIComponent(id)}/stop`,{method:'POST',body:'{}'});await refresh();},
    snapshot,
    details,
    page,
    loadMore: () => refresh(page + 1),
    loadHistory,
    loadingHistory,
    historyError,
    hasEarlierHistory:snapshot?.clientScope===userId&&snapshot.history?.hasMore===true,
  };
}
