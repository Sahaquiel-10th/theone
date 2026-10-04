import { useCallback, useEffect, useRef, useState } from "react";
import type { api as Api } from "./oneApi";
import { ApiError } from "./oneApi";
import {chatSubmission,forgetChatSubmission} from './chatSubmission';
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
};
type Notice = {
  id: string;
  taskId: string;
  title?: string;
  state: string;
  resultMessageId?: string;
};
type Snapshot = {
  enabled: boolean;
  conversation: Conversation | null;
  tasks: Meta[];
  total: number;
  notices: Notice[];
  pendingOperationId?: string;
  links?: { messageId: string; taskId: string }[];
};
type Job = {
  id: string;
  operationId: string;
  state: string;
  inputMessageId: string;
  error?: string;
};
type Detail = { conversation: Conversation; jobs: Job[] };
export type CoordinatorSubmission = {
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
    [details, setDetails] = useState<Record<string, Detail>>({}),
    [selected, setSelected] = useState<string | null>(null),
    [bound, setBound] = useState<string | null>(null),
    [localPending, setPending] = useState<string | null>(null),
    [error, setError] = useState(""),
    [page, setPage] = useState(1);
  const live = useRef(true),
    refreshing = useRef(false),
    sending = useRef(false),
    snapshotRef = useRef(snapshot),
    detailsRef = useRef(details),
    selectedRef = useRef(selected),
    pageRef = useRef(1),
    directReceipts = useRef(new Map<string, string>()),
    resumeKey = useRef("");
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
        setError("");
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
          .filter((t) => t.queued > 0)
          .map((t) => `${t.id}:${t.queued}:${t.updatedAt}`)
          .join("|");
        if (next.enabled && queued && queued !== resumeKey.current) {
          resumeKey.current = queued;
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
          let status: {status:string;taskId?:string};
          try { status = await api(`/api/coordinator/messages/${encodeURIComponent(operation)}`); }
          catch(e) {
            if(e instanceof ApiError && e.status===404) {
              try {localStorage.removeItem(pendingKey(userId));}catch{}
              setPending(null);
              setError("暂未找到接收记录，原话仍保留；可重试同一条消息，系统会沿用原提交编号，避免重复执行。");
              return;
            }
            throw e;
          }
          if (status.status !== "pending") {
            try {
              localStorage.removeItem(pendingKey(userId));
            } catch {}
            setPending(null);
            forgetChatSubmission(`coordinator:${userId}`,operation);
            if (status.status !== "completed")
              setError(
                "这条消息未完成，原话和已产生的用量保留；不会自动重跑。",
              );
          }
        } else setPending(null);
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
    setPending(input.operationId);
    setError("");
    try {
      input={...input,operationId:await chatSubmission(`coordinator:${userId}`,{...input,operationId:undefined})};
      setPending(input.operationId);
      try {localStorage.setItem(pendingKey(userId), input.operationId);}catch{}
      await api("/api/coordinator/messages", {
        method: "POST",
        body: JSON.stringify(input),
      });
      await refresh();
    } catch (e) {
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
  ) {
    setError("");
    const receiptKey = JSON.stringify([userId,id,text,attachmentIds]);
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
      body: JSON.stringify({ operationId, text, attachmentIds }),
    });
    await load(id);
    await refresh();
    directReceipts.current.delete(receiptKey);
    try { localStorage.removeItem(storageKey); } catch {}
  }
  async function acknowledge(taskId?: string) {
    const ids = (snapshotRef.current?.notices ?? [])
      .filter((n) => !taskId || n.taskId === taskId)
      .map((n) => n.id);
    if (!ids.length) return;
    await api("/api/coordinator/notices/read", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    setSnapshot((old) =>
      old
        ? { ...old, notices: old.notices.filter((n) => !ids.includes(n.id)) }
        : old,
    );
  }
  async function resumeTask(id: string) {
    await api("/api/coordinator/resume", {
      method: "POST",
      body: JSON.stringify({ continueTaskId: id, confirmed: true }),
    });
    await load(id);
    await refresh();
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
  const metas = [...(snapshot?.tasks ?? [])];
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
        id: m.id!,
        role: m.role === "user" ? "user" : "assistant",
        text: m.content,
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
        : notice?.state === "failed" || notice?.state === "interrupted"
          ? "failed"
          : jobs.some((j) => j.state === "completed")
            ? "completed"
            : "idle",
      result: "",
      unread: !!notice,
    };
  });
  const state: PreviewState = {
    tasks,
    dialogue: (snapshot?.conversation?.messages ?? []).map((m) => ({
      id: m.id!,
      role: m.role === "user" ? "user" : "assistant",
      text: m.content,
      files: m.attachments?.map((file) => ({
        id: file.id,
        originalName: file.originalName,
      })),
      taskId: snapshot?.links?.find((l) => l.messageId === m.id)?.taskId,
    })),
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
    resumeTask,
    error,
    clearError: () => setError(""),
    snapshot,
    details,
    page,
    loadMore: () => refresh(page + 1),
  };
}
