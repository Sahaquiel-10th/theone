import { useCallback, useEffect, useRef, useState } from "react";
import type { api as Api } from "./oneApi";
import { ApiError } from "./oneApi";
import { approveFeaturePrices } from './FeatureBudgetSettings';
import { coordinatorMessage } from './coordinatorMessage';
import {chatSubmission,forgetChatSubmission} from './chatSubmission';
import {receiptMayBeMissing} from './responseProgressState';
import {applyReviewedReceipts} from './taskTransferLifecycle';
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
};
type Snapshot = {
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
  notionReceipt?: { state: 'pending' | 'verified' | 'uncertain'; url?: string; error?: string };
  id: string;
  operationId: string;
  state: string;
  inputMessageId: string;
  instruction?: string;
  error?: string;
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
const pendingKey = (user: string) => `one-coordinator-operation:${user}`;
export function useCoordinator(
  api: typeof Api,
  userId: string,
  enabled: boolean,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [outgoing, setOutgoing] = useState<{id:string;text:string;priorIds:string[];failed?:boolean} | null>(null),
    [progress, setProgress] = useState<{phase:string;startedAt:string} | null>(null),
    [details, setDetails] = useState<Record<string, Detail>>({}),
    [selected, setSelected] = useState<string | null>(null),
    [bound, setBound] = useState<string | null>(null),
    [localPending, setPending] = useState<string | null>(null),
    [error, setError] = useState(""),
    [settlement, setSettlement] = useState<{operationId:string;status:string;taskId?:string;taskIds?:string[]} | null>(null),
    [page, setPage] = useState(1);
  const live = useRef(true),
    refreshing = useRef(false),
    sending = useRef(false),
    snapshotRef = useRef(snapshot),
    detailsRef = useRef(details),
    selectedRef = useRef(selected),
    pageRef = useRef(1),
    directReceipts = useRef(new Map<string, string>()),
    submissionError = useRef(""),
    resumeKey = useRef("");
  const resumeAt = useRef(0);
  const retrying=useRef(new Set<string>());
  const [retryingTasks,setRetryingTasks]=useState<string[]>([]);
  const [removedTask,setRemovedTask] = useState<string|null>(null);
  snapshotRef.current = snapshot;
  detailsRef.current = details;
  selectedRef.current = selected;
  const load = useCallback(
    async (id: string) => {
      let detail: Detail;
      try {
        detail = await api<Detail>(
          `/api/coordinator/tasks/${encodeURIComponent(id)}`,
        );
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 400) throw e;
        detail = {
          ...(await api<{ conversation: Conversation }>(
            `/api/conversations/${encodeURIComponent(id)}`,
          )),
          jobs: [],
        };
      }
      if (live.current) setDetails((old) => ({ ...old, [id]: detail }));
      return detail;
    },
    [api],
  );
  const refresh = useCallback(
    async (nextPage = 1) => {
      if (!enabled || refreshing.current) return;
      refreshing.current = true;
      try {
        const pages = await Promise.all(Array.from({length: Math.max(nextPage, pageRef.current)}, (_, i) => api<Snapshot>(`/api/coordinator?page=${i+1}`)));
        const next = {...pages[0], tasks: [...new Map(pages.flatMap(p=>p.tasks).map(t=>[t.id,t])).values()]};
        if (!live.current) return;
        setSnapshot((old) => ({
          ...next,
          tasks:
            nextPage === 1
              ? next.tasks
              : [
                  ...(old?.tasks ?? []).filter(
                    (t) => !next.tasks.some((n) => n.id === t.id),
                  ),
                  ...next.tasks,
                ],
        }));
        pageRef.current = Math.max(nextPage, pageRef.current);
        setPage(pageRef.current);
        setError(submissionError.current);
        const affected = [
          ...new Set(
            [
              selectedRef.current,
              ...next.tasks
                .filter(
                  (t) =>
                    t.running ||
                    t.queued ||
                    (detailsRef.current[t.id] &&
                      detailsRef.current[t.id].conversation.updatedAt !==
                        t.updatedAt),
                )
                .map((t) => t.id),
              ...next.notices.map((n) => n.taskId),
            ].filter((id): id is string => !!id),
          ),
        ];
        await Promise.all(
          affected.map((id) => load(id).catch(() => undefined)),
        );
        const queued = next.tasks
          .filter((t) => t.queued > 0 && !t.paused)
          .map((t) => `${t.id}:${t.queued}:${t.updatedAt}`)
          .join("|");
        if (next.enabled && queued && (queued !== resumeKey.current || Date.now()-resumeAt.current >= 15000)) {
          resumeKey.current = queued;
          resumeAt.current = Date.now();
          void api("/api/coordinator/resume", {
            method: "POST",
            body: "{}",
          }).catch(() => {
            resumeKey.current = "";
          });
        }
        let persisted: string | null = null;
        try {
          persisted = localStorage.getItem(pendingKey(userId));
        } catch {}
        const operation = next.pendingOperationId || persisted;
        if (operation) {
          setPending(operation);
          let status: {status:string;error?:string;taskId?:string;taskIds?:string[];progress?:{phase:string;startedAt:string}};
          try { status = await api(`/api/coordinator/messages/${encodeURIComponent(operation)}`); }
          catch(e) {
            if(e instanceof ApiError && e.status===404) {
              if(!receiptMayBeMissing(sending.current,next.pendingOperationId,operation))return;
              try {localStorage.removeItem(pendingKey(userId));}catch{}
              setPending(null);
              setProgress(null);
              submissionError.current = "暂未找到接收记录，原话仍保留；可重试同一条消息，系统会沿用原提交编号，避免重复执行。";
              setError(submissionError.current);
              return;
            }
            throw e;
          }
          if (status.status !== "pending") {
            setProgress(null);
            setSettlement({operationId:operation,...status});
            try {
              localStorage.removeItem(pendingKey(userId));
            } catch {}
            setPending(null);
            forgetChatSubmission(`coordinator:${userId}`,operation);
            if (status.status !== "completed") {
              submissionError.current = status.status==='interrupted' ? "回复已停止，原话保留；已经交出的任务可在任务区单独停止，不会自动重跑。" : status.error ? `${status.error}。原话和已产生的用量保留；不会自动重跑。` : "这条消息未完成，原话和已产生的用量保留；不会自动重跑。";
              setError(submissionError.current);
            }
          } else setProgress(status.progress || {phase:'正在等待处理结果',startedAt:next.conversation?.messages.at(-1)?.createdAt || new Date().toISOString()});
        } else {setPending(null);setProgress(null);}
      } catch (e) {
        if (live.current)
          setError(e instanceof Error ? e.message : "连接暂时不可用");
      } finally {
        refreshing.current = false;
      }
    },
    [api, enabled, load, userId],
  );
  useEffect(() => {
    live.current = true;
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    return () => {
      live.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [enabled, refresh]);
  async function submit(input: CoordinatorSubmission) {
    if (
      sending.current ||
      localPending ||
      snapshotRef.current?.pendingOperationId
    )
      throw Error("ONE 正在承接上一句话，请稍候");
    sending.current = true;
    setOutgoing({id:input.operationId,text:input.text,priorIds:snapshotRef.current?.conversation?.messages.map(m=>m.id!)||[]});
    setProgress({phase:'正在发送你的要求',startedAt:new Date().toISOString()});
    setPending(input.operationId);
    submissionError.current = "";
    setError("");
    try {
      input={...input,operationId:await chatSubmission(`coordinator:${userId}`,{...input,operationId:undefined})};
      setPending(input.operationId);
      try {localStorage.setItem(pendingKey(userId), input.operationId);}catch{}
      await api("/api/coordinator/messages", {
        method: "POST",
        body: JSON.stringify(input),
      });
      submissionError.current='';setError('');
      await refresh();
      return input.operationId;
    } catch (e) {
      setOutgoing(old=>old?{...old,failed:true}:null);
      if (e instanceof ApiError && e.status && e.status < 500) {
        try {
          localStorage.removeItem(pendingKey(userId));
        } catch {}
        setPending(null);
      }
      await refresh();
      throw e;
    } finally {
      sending.current = false;
    }
  }
  async function direct(
    id: string,
    text: string,
    attachmentIds: string[] = [],
    outputDestination?: 'chat' | 'notion',
  ) {
    setError("");
    const receiptKey = JSON.stringify([userId,id,text,attachmentIds,outputDestination]);
    const featureApprovals=await approveFeaturePrices(api,[],id);
    const storageKey = `one-task-operation:${userId}:${id}`;
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
    await api(`/api/coordinator/tasks/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ operationId, text, attachmentIds, featureApprovals, outputDestination }),
    });
    await load(id);
    await refresh();
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
    setSnapshot((old) =>
      old
        ? { ...old, notices: applyReviewedReceipts(old.notices,ids) }
        : old,
    );
  }
  async function readAll() {
    const result=await api<{ids:string[];count:number}>("/api/coordinator/notices/read-all",{method:"POST",body:"{}"});
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
  async function retryTask(id:string) {
    if(retrying.current.has(id))return;
    retrying.current.add(id);
    setRetryingTasks([...retrying.current]);
    try{
    const detail=await load(id),job=detail.jobs.at(-1);
    if(!job)throw new Error('此任务没有可重新处理的要求');
    if(!detail.recovery||!['retry','resume','review_image'].includes(detail.recovery.kind))throw new Error(detail.recovery?.message||'请刷新后查看任务恢复方式');
    const featureApprovals=await approveFeaturePrices(api,[],id);
    await api(`/api/coordinator/tasks/${encodeURIComponent(id)}/retry`,{method:'POST',body:JSON.stringify({sourceJobId:job.id,confirmed:true,featureApprovals})});
    await load(id);await refresh();
    }finally{retrying.current.delete(id);if(live.current)setRetryingTasks([...retrying.current]);}
  }
  function dispatch(action: Action) {
    if (action.type === "select") {
      setSelected(action.taskId);
      const id = action.taskId;
      if (id)
        void load(id)
          .then(() => acknowledge(id))
          .catch((e) => setError(e.message));
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
    })), ...(outgoing && !snapshot?.conversation?.messages.some(m=>m.role==='user'&&!outgoing.priorIds.includes(m.id!)&&m.content===outgoing.text) ? [{id:`outgoing_${outgoing.id}`,role:'user' as const,text:outgoing.text,status:outgoing.failed?'failed' as const:undefined,featureName:outgoing.failed?'发送状态待确认 · 原话保留':'发送中'}] : [])],
    pending:
      localPending || snapshot?.pendingOperationId
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
    state,
    dispatch,
    submit,
    direct,
    load,
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
      setRemovedTask(id); if(selectedRef.current===id)setSelected(null);if(bound===id)setBound(null);
      setDetails(old=>{const next={...old};delete next[id];return next;});await refresh();
    },
    restoreTask: async () => {if(!removedTask)return;await api(`/api/coordinator/tasks/${encodeURIComponent(removedTask)}/restore`,{method:'POST',body:'{}'});setRemovedTask(null);await refresh();},
    error,
    settlement,
    clearError: () => setError(""),
    progress,
    stop: async () => {const id=localPending||snapshotRef.current?.pendingOperationId;if(!id)return;await api(`/api/coordinator/messages/${encodeURIComponent(id)}/stop`,{method:'POST',body:'{}'});await refresh();},
    stopTask: async (id:string) => {await api(`/api/coordinator/tasks/${encodeURIComponent(id)}/stop`,{method:'POST',body:'{}'});await refresh();},
    snapshot,
    details,
    page,
    loadMore: () => refresh(page + 1),
  };
}
