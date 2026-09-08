import React, { FormEvent, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArrowLeft,
  Brain,
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  FileSpreadsheet,
  Folder,
  FolderInput,
  Globe2,
  Image,
  KeyRound,
  LockKeyhole,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  Paperclip,
  Plus,
  RotateCcw,
  ReceiptText,
  Search,
  Save,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Trash2,
  Square,
  UserRound,
  UserPlus,
  Users,
  Usb,
  Wallet,
  X,
  Zap
} from "lucide-react";
import "./styles.css";

type Role = "admin" | "user";

type User = {
  id: string;
  defaultWorkspaceId: string;
  username: string;
  role: Role;
  enabled: boolean;
  createdAt: string;
  preferredModelId?: string;
  balanceMicros?: number;
  totalChargedMicros?: number;
};

type Model = {
  id: string;
  name: string;
  provider: string;
  kind: "chat" | "image";
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  model: string;
  systemPrompt: string;
  enabled: boolean;
  isDefault: boolean;
  inputPowerPerMillion: number;
  outputPowerPerMillion: number;
  costInputPowerPerMillion: number;
  costOutputPowerPerMillion: number;
  hasApiKey: boolean;
  createdAt: string;
};

type Message = {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  imageUrl?: string;
  attachments?: AttachmentSummary[];
  sources?: SearchSource[];
  createdAt: string;
  modelId?: string;
};

type AttachmentSummary = {
  id: string;
  originalName: string;
  mimeType: string;
  kind: "image" | "document" | "spreadsheet" | "presentation" | "text";
  size: number;
};

type SearchSource = {
  title: string;
  url: string;
  snippet: string;
};

type AppCapabilities = {
  attachments: { enabled: boolean; maxFiles: number; maxBytes: number; extensions: string[] };
  webSearch: { enabled: boolean; provider: string };
};

type KnowledgeConnection = {
  provider: "getnote";
  status: "disconnected" | "pending" | "connected" | "error" | "revoked";
  credentialExpiresAt?: string;
  lastCheckedAt?: string;
  lastError?: string;
};

type ExecutionTask = {
  id: string;
  workspaceId: string;
  userId: string;
  conversationId: string;
  sourceMessageId: string;
  provider: "codex" | "local_agent";
  status: "queued" | "selecting_target" | "running" | "completed" | "failed" | "cancelled";
  targetName?: string;
  providerThreadId?: string;
  finalResponse?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

type ExecutionEvent = {
  id: string;
  taskId: string;
  kind: "status" | "user_message" | "message" | "command" | "file_change" | "error";
  text: string;
  createdAt: string;
};

type GetNoteDeviceFlow = {
  flowId: string;
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  interval: number;
};

type Conversation = {
  id: string;
  userId: string;
  modelId: string;
  agentId?: string;
  folderId?: string;
  archived: boolean;
  title: string;
  messages: Message[];
  messageCount?: number;
  messagesLoaded?: boolean;
  createdAt: string;
  updatedAt: string;
};

type ConversationFolder = {
  id: string;
  userId: string;
  name: string;
  createdAt: string;
};

type Agent = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  modelId: string;
  group: string;
  avatar: string;
  color: string;
  favoriteCount: number;
  favorited: boolean;
  useCount: number;
  allowFileUpload: boolean;
  allowImageInput: boolean;
  allowWebSearch: boolean;
  published: boolean;
  publicSlug: string;
  authorName: string;
  authorRole: Role;
  createdAt: string;
  updatedAt: string;
};

type MemoryItem = {
  id: string;
  text: string;
  createdAt?: string;
  updatedAt?: string;
};

type MemoryLimits = {
  maxItems: number;
  maxCharsPerItem: number;
  maxTotalChars: number;
  usedItems: number;
  usedChars: number;
};

type PowerLedgerEntry = { id: string; type: "gift" | "recharge" | "usage" | "adjustment" | "refund"; amountMicros: number; balanceAfterMicros: number; title: string; createdAt: string; username?: string };
type RechargeOrder = { id: string; userId: string; requestedMicros: number; amountCny: number; status: "pending" | "paid" | "cancelled"; createdAt: string; username?: string };
type UsageRecord = { id: string; userId: string; modelId: string; inputTokens: number; outputTokens: number; totalTokens: number; chargedMicros?: number; costMicros?: number; requestId?: string; createdAt: string; username?: string; modelName?: string };
type AuditItem = { id: string; actorName?: string; action: string; targetType: string; requestId?: string; createdAt: string };
type OneKeyDevice = { id: string; serialNumber: string; workspaceId: string; userId: string; username: string; status: "active" | "revoked"; createdAt: string; lastUsedAt?: string; revokedAt?: string };
type ContextTraceSummary = { id: string; workspaceId: string; userId: string; username: string; conversationId: string; conversationTitle: string; modelName: string; requestId?: string; query: string; responsePreview: string; createdAt: string };
type ContextTraceDetail = ContextTraceSummary & { assistantMessageId: string; modelId: string; sections: { key: string; title: string; content: string }[] };
type OneKeyCredential = { version: 1; deviceId: string; privateKeyRaw: string; publicKeyRaw: string; serverBaseUrl?: string };

class ApiError extends Error {
  constructor(message: string, readonly requestId?: string, readonly status?: number) {
    super(message);
  }
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(!isFormData ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const requestId = payload.requestId || response.headers.get("x-request-id") || undefined;
    const message = payload.error || (response.status === 504 ? "模型响应超时，请稍后重试" : `请求失败（${response.status}）`);
    throw new ApiError(requestId ? `${message} · 编号 ${requestId}` : message, requestId, response.status);
  }
  return payload as T;
}

function dateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function power(value = 0, digits = 4) { return (value / 1_000_000).toFixed(digits).replace(/\.?0+$/, ""); }

function localId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function titleFrom(content: string) {
  return content.replace(/\s+/g, " ").slice(0, 32) || "新对话";
}

function publicAgentUrl(slug: string) {
  return `${window.location.origin}/agents/${slug}`;
}

function readableFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

type OneEyeMood = "idle" | "attentive" | "thinking" | "pleased" | "cozy" | "angry" | "surprised" | "curious";

function OneEye({
  mood = "idle",
  size = "md",
  decorative = false,
  className = ""
}: {
  mood?: OneEyeMood;
  size?: "xs" | "sm" | "md" | "lg" | "hero";
  decorative?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`one-eye one-eye-${size} mood-${mood} ${className}`.trim()}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "ONE 猫眼标志"}
      aria-hidden={decorative || undefined}
    >
      <span className="one-eye-white"><span className="one-eye-pupil" /></span>
      <span className="one-eye-lid one-eye-lid-top" />
      <span className="one-eye-lid one-eye-lid-bottom" />
    </span>
  );
}

function OnePupilMark({ className = "" }: { className?: string }) {
  return (
    <svg className={`one-pupil-mark ${className}`.trim()} viewBox="0 0 12 28" aria-hidden="true">
      <path d="M8.1 2.4C5.7 10.8 4.9 18.7 5.5 25.5" />
    </svg>
  );
}

type HeroEyeState = "idle" | "tracking" | "blink" | "thinking" | "alert";

function OneHeroEye({ mood }: { mood: OneEyeMood }) {
  const [tracking, setTracking] = useState(false);
  const [blinking, setBlinking] = useState(false);
  const [look, setLook] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!blinking) return;
    const timer = window.setTimeout(() => setBlinking(false), 170);
    return () => window.clearTimeout(timer);
  }, [blinking]);

  const state: HeroEyeState = blinking
    ? "blink"
    : (mood === "thinking"
      ? "thinking"
      : mood === "angry"
        ? "alert"
        : tracking
          ? "tracking"
          : "idle");

  function trackPointer(event: React.PointerEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width - .5) * 10;
    const y = ((event.clientY - bounds.top) / bounds.height - .5) * 5;
    setLook({ x, y });
  }

  return (
    <button
      className="one-presence"
      type="button"
      aria-label="逗一下 ONE"
      data-eye-state={state}
      onPointerEnter={() => setTracking(true)}
      onPointerMove={trackPointer}
      onPointerLeave={() => { setTracking(false); setLook({ x: 0, y: 0 }); }}
      onClick={() => setBlinking(true)}
    >
      <svg className="one-hero-eye" viewBox="0 0 100 100" role="img" aria-label="ONE 猫眼">
        <rect className="one-hero-eye-shell" x="2" y="2" width="96" height="96" rx="25" />
        <g className="one-hero-expression">
          <path className="one-hero-aperture aperture-a2" d="M13 50C15 31 32 22 50 22C70 22 85 32 88 49C89 64 72 74 50 75C29 75 12 65 13 50Z" />
          <path className="one-hero-aperture aperture-a3" d="M14 52C20 40 37 36 54 37C72 38 84 45 87 52C83 62 67 66 49 66C31 66 17 61 14 52Z" />
          <path className="one-hero-aperture aperture-a5" d="M13 51C17 33 34 25 52 25C72 26 86 37 88 51C85 65 69 72 49 72C29 72 13 63 13 51Z" />
          <path className="one-hero-pupil" style={{ transform: `translate(${look.x}px, ${look.y}px)` }} d="M53 33C50.5 43.5 49.8 56.3 50.8 67" />
        </g>
      </svg>
    </button>
  );
}

function OneWordmark({ inverse = false }: { inverse?: boolean }) {
  return (
    <span className={`one-wordmark ${inverse ? "inverse" : ""}`} aria-label="ONE">
      <OneEye size="sm" decorative />
      <span className="one-wordmark-letters">ne</span>
    </span>
  );
}

function AttachmentIcon({ kind, size = 15 }: { kind: AttachmentSummary["kind"]; size?: number }) {
  if (kind === "image") return <Image size={size} />;
  if (kind === "spreadsheet") return <FileSpreadsheet size={size} />;
  return <FileText size={size} />;
}

function AttachmentList({ attachments, removable, onRemove }: {
  attachments: AttachmentSummary[];
  removable?: boolean;
  onRemove?: (attachment: AttachmentSummary) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className={`attachment-list ${removable ? "pending" : ""}`}>
      {attachments.map((attachment) => (
        <div className="attachment-chip" key={attachment.id}>
          {attachment.kind === "image" ? (
            <img src={`/api/attachments/${encodeURIComponent(attachment.id)}/content`} alt="" />
          ) : <span className="attachment-file-icon"><AttachmentIcon kind={attachment.kind} /></span>}
          <span className="attachment-meta">
            <strong title={attachment.originalName}>{attachment.originalName}</strong>
            <small>{readableFileSize(attachment.size)}</small>
          </span>
          {removable ? (
            <button type="button" title="移除附件" onClick={() => onRemove?.(attachment)}><X size={13} /></button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function MessageSources({ sources }: { sources?: SearchSource[] }) {
  if (!sources?.length) return null;
  return (
    <div className="message-sources">
      <span><Globe2 size={13} />参考来源</span>
      <div>
        {sources.map((source, index) => (
          <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer" title={source.snippet}>
            <strong>{index + 1}</strong>{source.title}
          </a>
        ))}
      </div>
    </div>
  );
}

function Login({ onDone }: { onDone: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    try {
      const result = await api<{ user: User }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      onDone(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-brand">
          <OneWordmark />
          <div className="login-divider" />
          <div>
            <h1>个人 AI 工作台</h1>
            <p>把你的知识和 AI 放在同一个地方</p>
          </div>
        </div>
        <label>
          账号
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            name="workspace-account"
            spellCheck={false}
          />
        </label>
        <label>
          密码
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="off"
            name="workspace-passcode"
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <button className="primary" type="submit">
          <KeyRound size={18} />
          登录
        </button>
      </form>
    </main>
  );
}

function ChatApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const conversationPageSize = 30;
  const [models, setModels] = useState<Model[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationPage, setConversationPage] = useState(1);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [folders, setFolders] = useState<ConversationFolder[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [draftModelId, setDraftModelId] = useState("");
  const [draftAgentId, setDraftAgentId] = useState("");
  const [defaultModelId, setDefaultModelId] = useState("");
  const [draftWorkspaceId, setDraftWorkspaceId] = useState("");
  const [content, setContent] = useState("");
  const [loadingByConversation, setLoadingByConversation] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"chat" | "admin" | "memories" | "knowledge" | "account" | "agents" | "agentEditor">("chat");
  const [editingAgentId, setEditingAgentId] = useState<string | "new">("new");
  const [showArchived, setShowArchived] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [waitIndex, setWaitIndex] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [failedMessage, setFailedMessage] = useState("");
  const [workspaceSectionOpen, setWorkspaceSectionOpen] = useState(true);
  const [conversationSectionOpen, setConversationSectionOpen] = useState(true);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() => new Set());
  const [capabilities, setCapabilities] = useState<AppCapabilities>({
    attachments: { enabled: true, maxFiles: 4, maxBytes: 10 * 1024 * 1024, extensions: [] },
    webSearch: { enabled: false, provider: "tavily" }
  });
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentSummary[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [knowledgeConnection, setKnowledgeConnection] = useState<KnowledgeConnection>({
    provider: "getnote",
    status: "disconnected"
  });
  const [knowledgeConfigured, setKnowledgeConfigured] = useState(false);
  const [executionTask, setExecutionTask] = useState<ExecutionTask | null>(null);
  const [executionEvents, setExecutionEvents] = useState<ExecutionEvent[]>([]);
  const [executionTraceText, setExecutionTraceText] = useState("");
  const [executionMode, setExecutionMode] = useState(false);
  const [preparingExecution, setPreparingExecution] = useState(false);

  const active = useMemo(() => conversations.find((item) => item.id === activeId), [activeId, conversations]);
  const activeModelId = active?.modelId || draftModelId;
  const activeLoadingKey = active?.id || "draft";
  const activeLoading = Boolean(loadingByConversation[activeLoadingKey]);
  const executionBusy = executionTask?.status === "queued" || executionTask?.status === "selecting_target" || executionTask?.status === "running";
  const activeExecutionMode = Boolean(executionMode && active && (preparingExecution || executionTask?.conversationId === active.id));
  const currentModel = models.find((model) => model.id === activeModelId);
  const activeAgentId = active?.agentId || draftAgentId;
  const activeAgent = agents.find((agent) => agent.id === activeAgentId);
  const canAttach = Boolean(currentModel) && (!activeAgent || activeAgent.allowFileUpload);
  const attachmentAccept = currentModel?.kind === "image"
    ? ".png,.jpg,.jpeg,.webp"
    : capabilities.attachments.extensions.map((extension) => `.${extension}`).join(",");
  const canSearch = currentModel?.kind === "chat" && capabilities.webSearch.enabled && (!activeAgent || activeAgent.allowWebSearch);
  const visibleConversations = conversations.filter((conversation) => conversation.archived === showArchived);
  const ungroupedConversations = visibleConversations.filter((conversation) => !conversation.folderId);
  const waitMessages = [
    "AI 疯狂翻书中 (ง •̀_•́)ง",
    "什么？刚睡醒，等我找找 (。-ω-)zzz",
    "答案正在路上，请勿催单 ( •̀ ω •́ )✧",
    "正在知识库里东翻西找 (￣▽￣)~*",
    "脑子转得有点快，先别打断我 (¬‿¬)",
    "让我再想得像样一点 ( • ̀ω•́ )",
    "正在努力避免一本正经地胡说八道 (._.)",
    "这个问题有点东西，我再琢磨琢磨 (˘･_･˘)",
    "AI 临时加班中，马上回来 (ง'̀-'́)ง",
    "正在组织语言，争取不像机器人 (￣﹃￣)",
    "别急，好的答案值得多等两秒 (๑•̀ㅂ•́)و",
    "上下文有点多，我正在认真捋顺 (＠_＠;)"
  ];

  async function refresh() {
    const [modelResult, conversationResult, workspaceResult, agentResult, capabilityResult, knowledgeResult] = await Promise.all([
      api<{ models: Model[]; defaultModelId: string }>("/api/models"),
      api<{ conversations: Conversation[]; pagination: { page: number; hasMore: boolean } }>(
        `/api/conversations?summary=1&page=1&pageSize=${conversationPageSize}&archived=${showArchived}`
      ),
      api<{ folders: ConversationFolder[] }>("/api/folders"),
      api<{ agents: Agent[] }>("/api/agents"),
      api<AppCapabilities>("/api/capabilities"),
      api<{ connection: KnowledgeConnection; configured: boolean }>("/api/knowledge/connections/getnote")
    ]);
    setModels(modelResult.models);
    setDefaultModelId(modelResult.defaultModelId);
    setConversations((current) => {
      const firstPage = conversationResult.conversations.map((summary) => {
        const loaded = current.find((item) => item.id === summary.id && item.messagesLoaded);
        return loaded
          ? { ...summary, messages: loaded.messages, messagesLoaded: true }
          : { ...summary, messagesLoaded: false };
      });
      const activeLoaded = current.find(
        (item) => item.id === activeId && item.messagesLoaded && item.archived === showArchived
      );
      return activeLoaded && !firstPage.some((item) => item.id === activeLoaded.id)
        ? [...firstPage, activeLoaded]
        : firstPage;
    });
    setConversationPage(1);
    setHasMoreConversations(conversationResult.pagination.hasMore);
    setFolders(workspaceResult.folders);
    setAgents(agentResult.agents);
    setCapabilities(capabilityResult);
    setKnowledgeConnection(knowledgeResult.connection);
    setKnowledgeConfigured(knowledgeResult.configured);
    setDraftModelId((current) => (
      modelResult.models.some((model) => model.id === current)
        ? current
        : modelResult.defaultModelId || modelResult.models[0]?.id || ""
    ));
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, [showArchived]);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") refresh().catch(() => undefined);
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [showArchived, activeId]);

  useEffect(() => {
    if (!executionTask?.id) return;
    if (!executionBusy) return;
    const stream = new EventSource(`/api/executions/${encodeURIComponent(executionTask.id)}/stream`);
    stream.onmessage = (event) => {
      const result = JSON.parse(event.data) as { task: ExecutionTask; events: ExecutionEvent[] };
      setExecutionTask(result.task);
      setExecutionEvents(result.events);
      if (!["queued", "selecting_target", "running"].includes(result.task.status)) stream.close();
    };
    return () => stream.close();
  }, [executionTask?.id, executionTask?.status, executionBusy]);

  async function loadLatestExecution(conversationId: string) {
    try {
      const result = await api<{ tasks: ExecutionTask[] }>(`/api/executions?conversationId=${encodeURIComponent(conversationId)}`);
      const latest = result.tasks[0];
      if (!latest) return;
      setExecutionTask(latest);
      const detail = await api<{ task: ExecutionTask; events: ExecutionEvent[] }>(`/api/executions/${encodeURIComponent(latest.id)}`);
      setExecutionTask(detail.task);
      setExecutionEvents(detail.events);
    } catch { /* Execution history is an enhancement to the chat view. */ }
  }

  async function loadMoreConversations() {
    if (loadingMoreConversations || !hasMoreConversations) return;
    const nextPage = conversationPage + 1;
    setLoadingMoreConversations(true);
    try {
      const result = await api<{ conversations: Conversation[]; pagination: { page: number; hasMore: boolean } }>(
        `/api/conversations?summary=1&page=${nextPage}&pageSize=${conversationPageSize}&archived=${showArchived}`
      );
      setConversations((current) => {
        const byId = new Map(current.map((item) => [item.id, item]));
        for (const summary of result.conversations) {
          if (!byId.has(summary.id)) byId.set(summary.id, { ...summary, messagesLoaded: false });
        }
        return [...byId.values()];
      });
      setConversationPage(result.pagination.page);
      setHasMoreConversations(result.pagination.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载对话失败");
    } finally {
      setLoadingMoreConversations(false);
    }
  }

  async function openConversation(conversation: Conversation) {
    setActiveId(conversation.id);
    setView("chat");
    setError("");
    setSidebarOpen(false);
    setHistoryOpen(false);
    setExecutionMode(false);
    void loadLatestExecution(conversation.id);
    if (conversation.messagesLoaded) return;
    setLoadingByConversation((items) => ({ ...items, [conversation.id]: true }));
    try {
      const result = await api<{ conversation: Conversation }>(
        `/api/conversations/${encodeURIComponent(conversation.id)}`
      );
      setConversations((items) => items.map((item) => (
        item.id === conversation.id ? { ...result.conversation, messagesLoaded: true } : item
      )));
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载对话失败");
    } finally {
      setLoadingByConversation((items) => ({ ...items, [conversation.id]: false }));
    }
  }

  useEffect(() => {
    const hasLoading = Object.values(loadingByConversation).some(Boolean);
    if (!hasLoading) return;
    const timer = window.setInterval(() => setWaitIndex((index) => index + 1), 3200);
    return () => window.clearInterval(timer);
  }, [loadingByConversation]);

  function startNewChat() {
    setActiveId("");
    setDraftAgentId("");
    setDraftModelId(defaultModelId || models[0]?.id || "");
    setContent("");
    setError("");
    setPendingAttachments([]);
    setWebSearch(false);
    setView("chat");
    setSidebarOpen(false);
    setHistoryOpen(false);
    setExecutionMode(false);
  }

  function startAgentChat(agent: Agent) {
    setActiveId("");
    setDraftAgentId(agent.id);
    setDraftModelId(agent.modelId);
    setContent("");
    setError("");
    setPendingAttachments([]);
    setWebSearch(false);
    setView("chat");
    setSidebarOpen(false);
  }

  async function uploadAttachments(files: FileList | File[] | null) {
    if (!files?.length || uploadingAttachments) return;
    const remaining = capabilities.attachments.maxFiles - pendingAttachments.length;
    if (remaining <= 0) {
      setError(`每次最多上传 ${capabilities.attachments.maxFiles} 个附件`);
      return;
    }
    const selected = Array.from(files).slice(0, remaining);
    if (currentModel?.kind === "image" && selected.some((file) => !["image/png", "image/jpeg", "image/webp"].includes(file.type))) {
      setError("图生图仅支持 PNG、JPG、JPEG 或 WebP 图片");
      return;
    }
    if (activeAgent && !activeAgent.allowFileUpload) {
      setError("这个智能体没有开启文件上传");
      return;
    }
    if (activeAgent && !activeAgent.allowImageInput && selected.some((file) => file.type.startsWith("image/"))) {
      setError("这个智能体没有开启图片理解");
      return;
    }
    const form = new FormData();
    selected.forEach((file) => form.append("files", file));
    setUploadingAttachments(true);
    setError("");
    try {
      const result = await api<{ attachments: AttachmentSummary[] }>("/api/attachments", { method: "POST", body: form });
      setPendingAttachments((items) => [...items, ...result.attachments].slice(0, capabilities.attachments.maxFiles));
    } catch (err) {
      setError(err instanceof Error ? err.message : "附件上传失败");
    } finally {
      setUploadingAttachments(false);
    }
  }

  async function removePendingAttachment(attachment: AttachmentSummary) {
    setPendingAttachments((items) => items.filter((item) => item.id !== attachment.id));
    await api(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: "DELETE" }).catch(() => undefined);
  }

  async function sendMessage(rawText: string) {
    const modelId = active?.modelId || draftModelId;
    const text = rawText.trim();
    const attachments = [...pendingAttachments];
    const useWebSearch = canSearch;
    if ((!text && !attachments.length) || !modelId) return;
    const isNewConversation = !active;
    const tempId = isNewConversation ? localId("tmp") : "";
    const loadingKey = active?.id || tempId;
    if (loadingByConversation[loadingKey]) return;
    setLoadingByConversation((items) => ({ ...items, [loadingKey]: true }));
    setError("");
    setFailedMessage("");
    const userMessage: Message = {
      id: localId("msg"),
      role: "user",
      content: text || (currentModel?.kind === "image" ? "请基于上传的图片进行编辑。" : "请分析上传的附件。"),
      attachments,
      modelId,
      createdAt: new Date().toISOString()
    };
    setContent("");
    setPendingAttachments([]);
    if (isNewConversation) {
      const optimistic: Conversation = {
        id: tempId,
        userId: user.id,
        modelId,
        folderId: draftWorkspaceId || undefined,
        agentId: draftAgentId || undefined,
        archived: false,
        title: activeAgent ? `${activeAgent.name} · ${titleFrom(text || attachments[0]?.originalName || "附件")}` : titleFrom(text || attachments[0]?.originalName || "附件"),
        messages: [userMessage],
        messagesLoaded: true,
        createdAt: userMessage.createdAt,
        updatedAt: userMessage.createdAt
      };
      setConversations((items) => [optimistic, ...items]);
      setActiveId(tempId);
    } else {
      setConversations((items) =>
        items.map((item) =>
          item.id === active.id
            ? { ...item, messages: [...item.messages, userMessage], updatedAt: userMessage.createdAt }
            : item
        )
      );
    }
    try {
      const result = await api<{ conversation: Conversation; memoryNotice?: string; knowledgeWarning?: string }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          content: text,
          modelId,
          conversationId: isNewConversation ? "" : active.id,
          folderId: draftWorkspaceId,
          agentId: isNewConversation ? draftAgentId : active.agentId,
          attachmentIds: attachments.map((attachment) => attachment.id),
          webSearch: useWebSearch
        })
      });
      setConversations((items) => {
        const rest = items.filter((item) => item.id !== result.conversation.id && item.id !== tempId);
        return [{ ...result.conversation, messagesLoaded: true }, ...rest];
      });
      setActiveId((current) => (current === tempId || current === active?.id ? result.conversation.id : current));
      setPendingAttachments([]);
      setWebSearch(false);
      if (result.knowledgeWarning) {
        setNotice("知识来源暂时不可用，本次已使用 AI 直接回答。");
        window.setTimeout(() => setNotice(""), 4200);
      }
      if (result.memoryNotice) {
        setNotice(result.memoryNotice);
        window.setTimeout(() => setNotice(""), 2800);
      }
    } catch (err) {
      setPendingAttachments(attachments);
      setFailedMessage(text || " ");
      setConversations((items) =>
        tempId
          ? items.filter((item) => item.id !== tempId)
          : items.map((item) =>
              item.id === active?.id
                ? { ...item, messages: item.messages.filter((message) => message.id !== userMessage.id) }
                : item
            )
      );
      if (tempId) setActiveId("");
      setError(err instanceof Error ? err.message : "发送失败");
    } finally {
      setLoadingByConversation((items) => ({ ...items, [loadingKey]: false }));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = content;
    if (activeExecutionMode) {
      if (!text.trim()) return;
      await sendExecutionMessage(text);
      return;
    }
    if (!text.trim() && !pendingAttachments.length) return;
    setContent("");
    await sendMessage(text);
  }

  async function retryFailedMessage() {
    const text = failedMessage;
    if ((!text && !pendingAttachments.length) || activeLoading) return;
    await sendMessage(text);
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !isComposing && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardFiles = Array.from(event.clipboardData.files);
    const pastedFiles = clipboardFiles.length
      ? clipboardFiles
      : Array.from(event.clipboardData.items)
          .filter((item) => item.kind === "file")
          .map((item) => item.getAsFile())
          .filter((file): file is File => Boolean(file));
    if (!pastedFiles.length) return;

    event.preventDefault();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const normalizedFiles = pastedFiles.map((file, index) => {
      if (file.name && file.name !== "image.png") return file;
      const extension = file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png";
      return new File([file], `剪贴板图片-${timestamp}-${index + 1}.${extension}`, { type: file.type || `image/${extension}` });
    });
    void uploadAttachments(normalizedFiles);
  }

  async function archiveConversation(conversation: Conversation) {
    const result = await api<{ conversation: Conversation }>(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: !conversation.archived })
    });
    setConversations((items) => items.map((item) => (item.id === conversation.id ? result.conversation : item)));
    if (activeId === conversation.id && !showArchived) setActiveId("");
  }

  async function deleteConversation(conversation: Conversation) {
    if (!confirm(`确认删除对话「${conversation.title}」？`)) return;
    await api(`/api/conversations/${conversation.id}`, { method: "DELETE" });
    setConversations((items) => items.filter((item) => item.id !== conversation.id));
    if (activeId === conversation.id) setActiveId("");
  }

  async function moveConversation(conversation: Conversation, folderId: string) {
    const result = await api<{ conversation: Conversation }>(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ folderId })
    });
    setConversations((items) => items.map((item) => (item.id === conversation.id ? result.conversation : item)));
  }

  async function createWorkspace() {
    const name = prompt("对话文件夹名称");
    if (!name?.trim()) return;
    const result = await api<{ folder: ConversationFolder }>("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() })
    });
    setFolders((items) => [...items, result.folder]);
    setDraftWorkspaceId(result.folder.id);
  }

  function toggleWorkspace(workspaceId: string) {
    setCollapsedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  }

  async function copyMarkdown(content: string) {
    await navigator.clipboard.writeText(content);
  }

  async function executeFromMessage(message: Message) {
    if (!active?.id || !message.id || preparingExecution) return;
    setPreparingExecution(true);
    setExecutionMode(true);
    setExecutionTask(null);
    setExecutionEvents([]);
    setExecutionTraceText("");
    setError("");
    try {
      const result = await api<{ task: ExecutionTask; events: ExecutionEvent[] }>("/api/executions/from-message", {
        method: "POST",
        body: JSON.stringify({ conversationId: active.id, sourceMessageId: message.id })
      });
      setExecutionTask(result.task);
      setExecutionEvents(result.events);
      setContent("");
    } catch (err) {
      setExecutionMode(false);
      setError(err instanceof Error ? err.message : "无法交给本机执行");
    } finally {
      setPreparingExecution(false);
    }
  }

  async function sendExecutionMessage(rawText: string) {
    const text = rawText.trim();
    if (!executionTask || !text || executionBusy) return;
    setContent("");
    setError("");
    try {
      const result = await api<{ task: ExecutionTask }>(`/api/executions/${encodeURIComponent(executionTask.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: text })
      });
      setExecutionTask(result.task);
      setExecutionEvents((items) => [...items, { id: localId("exe"), taskId: executionTask.id, kind: "user_message", text, createdAt: new Date().toISOString() }]);
    } catch (err) {
      setContent(text);
      setError(err instanceof Error ? err.message : "无法继续本机任务");
    }
  }

  async function cancelExecution() {
    if (!executionTask || !executionBusy) return;
    try {
      await api(`/api/executions/${encodeURIComponent(executionTask.id)}/cancel`, { method: "POST" });
    } catch (err) { setError(err instanceof Error ? err.message : "无法停止执行"); }
  }

  const heroMood: OneEyeMood = error
    ? "angry"
    : notice
      ? "pleased"
      : activeLoading
        ? "thinking"
        : content.trim()
          ? "curious"
          : "idle";

  return (
    <main className={`app-shell one-shell ${activeExecutionMode ? "execution-shell" : ""}`}>
      <header className="one-chrome">
        <button className="one-brand-button" type="button" onClick={startNewChat} title="回到 ONE">
          <OneWordmark inverse />
          <span className="one-live-signal" />
        </button>
        <button className="one-current-space" type="button" onClick={startNewChat}>
          {view === "chat" ? active?.title || "Ask ONE" : view === "knowledge" ? "Knowledge" : view === "admin" ? "Control" : "Account"}
        </button>
        <div className="one-chrome-actions">
          {active && executionTask?.conversationId === active.id ? (
            <button className={`one-chrome-button execution-entry ${executionMode ? "active" : ""}`} type="button" title="本机执行" onClick={() => setExecutionMode(true)}>
              <span className={`execution-dot ${executionTask.status}`} />
              <span>{executionBusy ? "本机执行中" : "本机任务"}</span>
            </button>
          ) : null}
          <button className="one-chrome-button knowledge" type="button" title="知识来源" onClick={() => { setView("knowledge"); setActiveId(""); setHistoryOpen(false); }}>
            <span className={`connection-dot ${knowledgeConnection.status}`} />
            <span>{knowledgeConnection.status === "connected" ? "知识已连接" : "连接知识"}</span>
          </button>
          <button className={`one-chrome-button icon-only ${historyOpen ? "active" : ""}`} type="button" title="最近任务" onClick={() => setHistoryOpen((open) => !open)}>
            <Archive size={16} />
          </button>
          {user.role === "admin" ? <button className="one-chrome-button icon-only" type="button" title="超管后台" onClick={() => { setView("admin"); setHistoryOpen(false); }}><ShieldCheck size={16} /></button> : null}
          <button className="one-chrome-button icon-only" type="button" title="设置" onClick={() => { setView("account"); setActiveId(""); setHistoryOpen(false); }}><Settings size={16} /></button>
          <button className="one-user-button" type="button" title="账号" onClick={() => { setView("account"); setActiveId(""); setHistoryOpen(false); }}>
            {user.username.slice(0, 1).toUpperCase()}
          </button>
        </div>
      </header>

      {historyOpen ? (
        <>
          <button className="one-popover-scrim" aria-label="关闭最近任务" onClick={() => setHistoryOpen(false)} />
          <section className="one-history-popover">
            <div className="one-popover-heading">
              <div><small>YOUR FLOW</small><h3>{showArchived ? "已归档" : "最近任务"}</h3></div>
              <button type="button" onClick={startNewChat}><Plus size={16} />新任务</button>
            </div>
            <div className="one-popover-list">
              {visibleConversations.length ? visibleConversations.slice(0, 18).map((conversation) => (
                <div className={`one-history-row ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
                  <button type="button" onClick={() => openConversation(conversation)}>
                    <span>{conversation.title}</span>
                    <small>{dateTime(conversation.updatedAt)}</small>
                  </button>
                  <button type="button" title={conversation.archived ? "取消归档" : "归档"} onClick={() => archiveConversation(conversation)}><Archive size={14} /></button>
                </div>
              )) : <div className="one-popover-empty">这里还没有任务。<br />问 ONE 一个问题，就从这里开始。</div>}
            </div>
            {hasMoreConversations ? <button className="one-load-more" type="button" disabled={loadingMoreConversations} onClick={loadMoreConversations}>{loadingMoreConversations ? "加载中…" : "加载更多"}</button> : null}
            <footer className="one-popover-footer">
              <button type="button" onClick={() => setShowArchived(!showArchived)}>{showArchived ? "返回最近任务" : "查看归档"}</button>
              <button type="button" onClick={onLogout}><LogOut size={14} />退出</button>
            </footer>
          </section>
        </>
      ) : null}

      {view === "admin" && user.role === "admin" ? (
        <AdminPanel refreshModels={refresh} onOpenSidebar={() => setSidebarOpen(true)} />
      ) : view === "memories" ? (
        <MemoriesPage onOpenSidebar={() => setSidebarOpen(true)} />
      ) : view === "knowledge" ? (
        <KnowledgePage
          onOpenSidebar={() => setSidebarOpen(true)}
          onConnectionChange={(next, configured) => {
            setKnowledgeConnection(next);
            setKnowledgeConfigured(configured);
          }}
        />
      ) : view === "account" ? (
        <AccountPage user={user} models={models} defaultModelId={defaultModelId} onModelChange={refresh} onOpenSidebar={() => setSidebarOpen(true)} />
      ) : (
      <section className={`chat one-chat ${(active?.messages ?? []).length ? "conversation-mode" : "home-mode"} ${activeExecutionMode ? "execution-mode" : ""}`}>
        <div className="messages">
          {activeExecutionMode && executionTask ? (
            <div className="execution-workspace">
              <header className="execution-header">
                <button type="button" onClick={() => setExecutionMode(false)}><ArrowLeft size={16} />返回对话</button>
                <div><small>{executionTask.provider === "local_agent" ? "ONE LOCAL AGENT" : "CODEX EXECUTION"}</small><strong>{executionTask.targetName || "本机任务"}</strong></div>
                {executionBusy ? <button className="execution-stop" type="button" onClick={cancelExecution}><Square size={13} />停止</button> : <span className={`execution-state ${executionTask.status}`}>{executionTask.status === "completed" ? "已完成" : executionTask.status === "failed" ? "失败" : executionTask.status === "cancelled" ? "已停止" : "执行中"}</span>}
              </header>
              <div className="execution-feed">
                <details onToggle={async (event) => {
                  if (!event.currentTarget.open) return;
                  setExecutionTraceText("正在读取本次交接记录…");
                  try {
                    const trace = await api<{ instruction: string; messages: { role: string; content: string }[]; contextLimitChars: number }>(`/api/executions/${executionTask.id}/trace`);
                    setExecutionTraceText(`发给本机执行器的实际指令\n\n${trace.instruction}\n\n截至所选消息的原对话\n\n${trace.messages.map((item) => `${item.role}: ${item.content}`).join("\n\n")}\n\n编译输入上限：${trace.contextLimitChars} 字符；超出时当前实现保留尾部。`);
                  } catch (error) { setExecutionTraceText(error instanceof Error ? error.message : "读取失败"); }
                }}>
                  <summary>查看执行上下文（调试）</summary>
                  <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{executionTraceText}</pre>
                </details>
                {executionEvents.map((event) => event.kind === "message" || event.kind === "user_message" ? (
                  <article className={`execution-message ${event.kind === "user_message" ? "user" : "codex"}`} key={event.id}>
                    <div className="execution-speaker">{event.kind === "user_message" ? "YOU" : executionTask.provider === "local_agent" ? "ONE" : "CODEX"}</div>
                    <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{event.text}</ReactMarkdown></div>
                  </article>
                ) : (
                  <div className={`execution-event ${event.kind}`} key={event.id}><span />{event.text}</div>
                ))}
                {executionBusy ? <div className="execution-live"><span />ONE 正在本机工作，你可以切回对话，任务会继续运行。</div> : null}
              </div>
            </div>
          ) : activeExecutionMode && preparingExecution ? (
            <div className="execution-workspace execution-preparing">
              <div className="execution-live"><span />正在连接本机，ONE 会在后台整理任务。</div>
            </div>
          ) : (active?.messages ?? []).length ? (
            active!.messages.map((message, index) => (
              <article key={`${message.createdAt}-${index}`} className={`message ${message.role}`}>
                {message.role === "assistant" ? (
                  <div className="avatar"><OneEye size="xs" mood="attentive" decorative /></div>
                ) : null}
                <div className="bubble">
                  {message.attachments?.length ? <AttachmentList attachments={message.attachments} /> : null}
                  {message.role === "assistant" ? (
                    <>
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                      </div>
                      <div className="message-actions">
                        <button title="复制" onClick={() => copyMarkdown(message.content)}>
                          <Copy size={14} />
                        </button>
                        {active && message.id ? (
                          <button title="执行这个方案" disabled={preparingExecution} onClick={() => executeFromMessage(message)}>
                            <Zap size={14} />
                          </button>
                        ) : null}
                      </div>
                      <MessageSources sources={message.sources} />
                    </>
                  ) : (
                    <>
                      <pre>{message.content}</pre>
                      {active && message.id ? (
                        <div className="message-actions user-actions">
                          <button title="执行这个需求" disabled={preparingExecution} onClick={() => executeFromMessage(message)}><Zap size={14} /></button>
                        </div>
                      ) : null}
                    </>
                  )}
                  {message.imageUrl ? <img className="generated-image" src={message.imageUrl} alt={message.content} /> : null}
                  <small className="message-time">{dateTime(message.createdAt)}</small>
                </div>
              </article>
            ))
          ) : (
            <div className="empty-state one-hero">
              <OneHeroEye mood={heroMood} />
              <div className="one-hero-kicker"><OnePupilMark /> ONE IS WITH YOU</div>
              <h2>{activeAgent?.name || `今天，想一起做点什么，${user.username}？`}</h2>
              <p>{activeAgent?.description || "说出你想知道、想完成，或者只是隐约想到的事。"}</p>
            </div>
          )}
          {activeLoading && !activeExecutionMode ? <div className="typing">{waitMessages[waitIndex % waitMessages.length]}</div> : null}
        </div>

        <form className="composer" onSubmit={send}>
          {notice ? <div className="notice">{notice}</div> : null}
          {error ? (
            <div className="chat-error" role="status">
              <span>{error}</span>
              {failedMessage ? (
                <button type="button" onClick={retryFailedMessage} disabled={activeLoading}>
                  <RotateCcw size={14} />
                  重试
                </button>
              ) : null}
            </div>
          ) : null}
          {pendingAttachments.length && !activeExecutionMode ? (
            <div className="composer-attachments">
              <AttachmentList attachments={pendingAttachments} removable onRemove={removePendingAttachment} />
            </div>
          ) : null}
          <div className="composer-row">
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              placeholder={activeExecutionMode ? (preparingExecution ? "正在连接本机…" : executionBusy ? "ONE 正在执行当前步骤…" : "继续给 ONE 指令") : currentModel?.kind === "image" ? "输入修改要求，也可直接粘贴图片" : "输入消息，Enter 发送，Shift+Enter 换行"}
              disabled={activeExecutionMode && (preparingExecution || executionBusy)}
              rows={2}
            />
            <button className="primary send" type="submit" disabled={activeExecutionMode ? preparingExecution || executionBusy || !content.trim() : !activeModelId || activeLoading || (!content.trim() && !pendingAttachments.length)}>
              <Send size={18} />
            </button>
          </div>
          {!active && !activeExecutionMode ? (
            <div className="dia-prompts">
              <button type="button" onClick={() => setContent("帮我回想最近反复提到的重要想法")}><small>01 · RECALL</small><span>我最近在反复想什么？</span><i aria-hidden="true">↗</i></button>
              <button type="button" onClick={() => setContent("结合我的知识，把现在最重要的事情整理成一个行动方案")}><small>02 · MAKE</small><span>把想法变成行动方案</span><i aria-hidden="true">↗</i></button>
              <button type="button" onClick={() => setContent("从我的个人知识中，找出现在最值得重新关注的内容")}><small>03 · DISCOVER</small><span>从过去发现新线索</span><i aria-hidden="true">↗</i></button>
            </div>
          ) : null}
        </form>
      </section>
      )}
    </main>
  );
}

function AgentCard({
  agent,
  official,
  canEdit,
  onStartChat,
  onCopyLink,
  onEdit,
  onDelete
  , onFavorite
}: {
  agent: Agent;
  official?: boolean;
  canEdit: boolean;
  onStartChat: (agent: Agent) => void;
  onCopyLink: (agent: Agent) => void;
  onEdit: (agent: Agent) => void;
  onDelete: (agent: Agent) => void;
  onFavorite: (agent: Agent) => void;
}) {
  return (
    <article className={`agent-card ${official ? "official" : ""}`}>
      <div className="agent-card-top">
        <span className="agent-mark" style={{ background: agent.color }}>{agent.avatar || "🤖"}</span>
        <div>
          <h3>{agent.name}</h3>
          <small>{official ? "官方发布" : agent.published ? "已发布链接" : "仅自己可见"} · {agent.authorName}</small>
        </div>
      </div>
      <p className="agent-description">{agent.description}</p>
      <div className="agent-capabilities">
        {agent.allowFileUpload ? <span><Paperclip size={12} />文件</span> : null}
        {agent.allowImageInput ? <span><Image size={12} />图片</span> : null}
        {agent.allowWebSearch ? <span><Globe2 size={12} />联网</span> : null}
      </div>
      <div className="agent-card-actions">
        <button className="agent-action primary-action" onClick={() => onStartChat(agent)}><Send size={14} />使用</button>
        {agent.published ? <button className="agent-action" onClick={() => onCopyLink(agent)}><Copy size={14} />复制链接</button> : null}
        {canEdit ? <button className="agent-icon-action" title="编辑" onClick={() => onEdit(agent)}><Edit3 size={14} /></button> : null}
        {canEdit ? <button className="agent-icon-action danger-icon-action" title="删除" onClick={() => onDelete(agent)}><Trash2 size={14} /></button> : null}
        <button className={`agent-icon-action favorite-action ${agent.favorited ? "active" : ""}`} title={agent.favorited ? "取消收藏" : "收藏"} onClick={() => onFavorite(agent)}><Star size={14} fill={agent.favorited ? "currentColor" : "none"} /></button>
      </div>
      <div className="agent-stats"><span><Star size={12} />{agent.favoriteCount}</span><span><MessageSquare size={12} />{agent.useCount} 次使用</span></div>
    </article>
  );
}

function AgentsPage({
  user,
  agents,
  reload,
  onStartChat,
  onEdit,
  onOpenSidebar
}: {
  user: User;
  agents: Agent[];
  reload: () => Promise<void>;
  onStartChat: (agent: Agent) => void;
  onEdit: (id: string | "new") => void;
  onOpenSidebar: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState("全部");
  const [notice, setNotice] = useState("");
  const groups = ["全部", "收藏", ...Array.from(new Set(agents.map((agent) => agent.group || "未分组")))];
  const filteredAgents = agents.filter((agent) => {
    const matchesGroup = activeGroup === "全部" || (activeGroup === "收藏" ? agent.favorited : (agent.group || "未分组") === activeGroup);
    const needle = query.trim().toLowerCase();
    return matchesGroup && (!needle || `${agent.name} ${agent.description} ${agent.group}`.toLowerCase().includes(needle));
  });
  const officialAgents = filteredAgents.filter((agent) => agent.published && agent.authorRole === "admin");
  const myAgents = user.role === "admin"
    ? []
    : filteredAgents.filter((agent) => agent.authorName === user.username && agent.authorRole !== "admin");

  function startCreate() {
    onEdit("new");
  }

  function startEdit(agent: Agent) {
    onEdit(agent.id);
  }

  async function makePrivate(agent: Agent) {
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", body: JSON.stringify({ published: false }) });
      setNotice("已转为私有，旧分享链接已作废");
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "操作失败");
    }
  }

  async function toggleFavorite(agent: Agent) {
    try { await api(`/api/agents/${agent.id}/favorite`, { method: "POST" }); await reload(); }
    catch (err) { setNotice(err instanceof Error ? err.message : "收藏失败"); }
  }

  async function deleteAgent(agent: Agent) {
    if (!confirm(`确认删除智能体「${agent.name}」？`)) return;
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function copyAgentLink(agent: Agent) {
    await navigator.clipboard.writeText(publicAgentUrl(agent.publicSlug));
    setNotice("公开链接已复制");
  }

  function canEdit(agent: Agent) {
    return agent.authorName === user.username || user.role === "admin";
  }

  return (
    <section className="agents-page">
      <header className="admin-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div>
          <h2>智能体</h2>
          <p>把常用任务封装成固定角色、流程和输出风格</p>
        </div>
      </header>
      <div className="agent-toolbar">
        <label className="agent-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索智能体、描述或分组" /></label>
        <button className="primary" onClick={startCreate}><Plus size={16} />创建智能体</button>
      </div>
      <div className="agent-group-tabs">{groups.map((group) => <button key={group} className={activeGroup === group ? "active" : ""} onClick={() => setActiveGroup(group)}>{group}</button>)}</div>
      {notice ? <div className={notice.includes("失败") || notice.includes("不存在") ? "error agent-notice" : "notice agent-notice"}>{notice}</div> : null}
      <div className="agents-board">
        <section className="agent-section">
          <div className="agent-section-title"><h3>官方发布</h3><span>{officialAgents.length} 个</span></div>
          <div className="agent-grid">
            {officialAgents.length ? officialAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                official
                canEdit={canEdit(agent)}
                onStartChat={onStartChat}
                onCopyLink={copyAgentLink}
                onEdit={startEdit}
                onDelete={deleteAgent}
                onFavorite={toggleFavorite}
              />
            )) : null}
            {user.role === "admin" ? (
              <button className="agent-card create-card" onClick={startCreate}>
                <Plus size={24} />
                <strong>创建官方智能体</strong>
                <span>发布后所有员工可见，并自动生成分享链接</span>
              </button>
            ) : null}
            {!officialAgents.length && user.role !== "admin" ? <div className="agent-empty">暂无官方智能体</div> : null}
          </div>
        </section>
        {user.role !== "admin" ? <section className="agent-section">
          <div className="agent-section-title"><h3>我的智能体</h3><span>{myAgents.length} 个</span></div>
          <div className="agent-grid">
            {myAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                canEdit={canEdit(agent)}
                onStartChat={onStartChat}
                onCopyLink={copyAgentLink}
                onEdit={startEdit}
                onDelete={deleteAgent}
                onFavorite={toggleFavorite}
              />
            ))}
            <button className="agent-card create-card" onClick={startCreate}>
              <Plus size={24} />
              <strong>创建智能体</strong>
              <span>保存一套常用提示词和使用入口</span>
            </button>
          </div>
        </section> : null}
      </div>
    </section>
  );
}

function AgentEditorPage({ agent, agents, models, onCancel, onSaved }: {
  agent?: Agent;
  agents: Agent[];
  models: Model[];
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const chatModels = models.filter((model) => model.kind === "chat" && model.enabled);
  const [draft, setDraft] = useState({
    name: agent?.name || "",
    description: agent?.description || "",
    prompt: agent?.prompt || "",
    modelId: agent?.modelId || chatModels.find((model) => model.isDefault)?.id || chatModels[0]?.id || "",
    group: agent?.group || "未分组",
    avatar: agent?.avatar || "🤖",
    color: agent?.color || "#E8F1FB",
    allowFileUpload: agent?.allowFileUpload ?? true,
    allowImageInput: agent?.allowImageInput ?? true,
    allowWebSearch: agent?.allowWebSearch ?? false
  });
  const [debugInput, setDebugInput] = useState("");
  const [debugMessages, setDebugMessages] = useState<Message[]>([]);
  const [debugging, setDebugging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [groupOptionsOpen, setGroupOptionsOpen] = useState(false);
  const [groupQuery, setGroupQuery] = useState("");
  const emojis = ["🤖", "✍️", "📊", "🧠", "🔍", "🎨", "💼", "🚀"];
  const colors = ["#E8F1FB", "#F1EAFE", "#E5F5EC", "#FFF1D8", "#FDE9EC", "#E6F4F4"];
  const groupOptions = useMemo(() => Array.from(new Set(
    agents.map((item) => item.group.trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b, "zh-CN")), [agents]);
  const filteredGroupOptions = groupOptions.filter((group) => group.toLocaleLowerCase().includes(groupQuery.trim().toLocaleLowerCase()));
  const hasExactGroup = groupOptions.some((group) => group.toLocaleLowerCase() === draft.group.trim().toLocaleLowerCase());

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.name.trim() || !draft.description.trim() || !draft.modelId) return;
    setSaving(true); setError("");
    try {
      await api(agent ? `/api/agents/${agent.id}` : "/api/agents", {
        method: agent ? "PATCH" : "POST",
        body: JSON.stringify({ ...draft, name: draft.name.trim(), description: draft.description.trim(), prompt: draft.prompt.trim(), published: true })
      });
      await onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : "保存失败"); }
    finally { setSaving(false); }
  }

  async function debug(event: FormEvent) {
    event.preventDefault();
    const content = debugInput.trim();
    if (!content || !draft.modelId || debugging) return;
    const userMessage: Message = { role: "user", content, modelId: draft.modelId, createdAt: new Date().toISOString() };
    setDebugMessages((items) => [...items, userMessage]); setDebugInput(""); setDebugging(true); setError("");
    try {
      const result = await api<{ message: Message }>("/api/agents/debug", { method: "POST", body: JSON.stringify({ content, prompt: draft.prompt, modelId: draft.modelId }) });
      setDebugMessages((items) => [...items, result.message]);
    } catch (err) { setError(err instanceof Error ? err.message : "调试失败"); }
    finally { setDebugging(false); }
  }

  return <section className="agent-workbench">
    <header className="agent-workbench-header">
      <button className="secondary" type="button" onClick={onCancel}><ChevronLeft size={16} />返回</button>
      <div><h2>{agent ? "编辑智能体" : "创建智能体"}</h2><p>配置和调试同步进行，保存后模型将对使用者锁定</p></div>
      <div className="workbench-actions"><button className="secondary" type="button" onClick={onCancel}>取消</button><button className="primary" type="submit" form="agent-config" disabled={saving || !draft.name.trim() || !draft.description.trim() || !draft.modelId}><Save size={16} />{saving ? "保存中" : "保存智能体"}</button></div>
    </header>
    <div className="agent-workbench-body">
      <form id="agent-config" className="agent-config" onSubmit={save}>
        <section><h3>基本信息</h3><div className="agent-identity-preview"><span style={{ background: draft.color }}>{draft.avatar}</span><div><strong>{draft.name || "未命名智能体"}</strong><small>{draft.group || "未分组"}</small></div></div>
          <label>名称<input maxLength={40} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：详情页策划助手" /></label>
          <label>描述<textarea maxLength={220} rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="告诉使用者它擅长什么、该怎么用" /></label>
          <div className="agent-group-field">
            <label htmlFor="agent-group">分组</label>
            <div className="agent-group-combobox" onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setGroupOptionsOpen(false);
            }}>
              <input
                id="agent-group"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={groupOptionsOpen}
                aria-controls="agent-group-options"
                autoComplete="off"
                maxLength={24}
                value={draft.group}
                onFocus={() => { setGroupQuery(""); setGroupOptionsOpen(true); }}
                onChange={(event) => { setDraft({ ...draft, group: event.target.value }); setGroupQuery(event.target.value); setGroupOptionsOpen(true); }}
                placeholder="搜索现有分组或输入新分组"
              />
              <button type="button" className="agent-group-toggle" aria-label="展开分组选项" onClick={() => { setGroupQuery(""); setGroupOptionsOpen((open) => !open); }}><ChevronDown size={16} /></button>
              {groupOptionsOpen ? (
                <div className="agent-group-options" id="agent-group-options" role="listbox">
                  {filteredGroupOptions.map((group) => (
                    <button type="button" role="option" aria-selected={draft.group === group} key={group} onClick={() => { setDraft({ ...draft, group }); setGroupOptionsOpen(false); }}>{group}</button>
                  ))}
                  {groupQuery.trim() && !hasExactGroup ? <button type="button" className="create-group-option" onClick={() => setGroupOptionsOpen(false)}><Plus size={14} />使用新分组“{draft.group.trim()}”</button> : null}
                  {!filteredGroupOptions.length && (!groupQuery.trim() || hasExactGroup) ? <span>暂无匹配的分组</span> : null}
                </div>
              ) : null}
            </div>
            <small>可选择已有分组，也可直接输入新分组</small>
          </div>
          <label>固定模型<select value={draft.modelId} onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}><option value="">请选择聊天模型</option>{chatModels.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.model}</option>)}</select><small>保存后，使用者无法更改此智能体的模型</small></label>
        </section>
        <section><h3>外观</h3><div className="appearance-options"><div>{emojis.map((emoji) => <button type="button" key={emoji} className={draft.avatar === emoji ? "active" : ""} onClick={() => setDraft({ ...draft, avatar: emoji })}>{emoji}</button>)}</div><div>{colors.map((color) => <button type="button" aria-label={color} key={color} className={draft.color === color ? "active" : ""} style={{ background: color }} onClick={() => setDraft({ ...draft, color })} />)}</div></div></section>
        <section><h3>指令</h3><label>系统提示词<textarea rows={10} maxLength={6000} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder="定义角色、工作流程、边界和输出格式。右侧可随时调试。" /><small>{draft.prompt.length} / 6000</small></label></section>
        <fieldset className="agent-tool-settings"><legend>可用能力</legend><label><input type="checkbox" checked={draft.allowFileUpload} onChange={(e) => setDraft({ ...draft, allowFileUpload: e.target.checked, allowImageInput: e.target.checked ? draft.allowImageInput : false })} /><span><Paperclip size={16} />文件上传</span></label><label><input type="checkbox" checked={draft.allowImageInput} disabled={!draft.allowFileUpload} onChange={(e) => setDraft({ ...draft, allowImageInput: e.target.checked })} /><span><Image size={16} />图片理解</span></label><label><input type="checkbox" checked={draft.allowWebSearch} onChange={(e) => setDraft({ ...draft, allowWebSearch: e.target.checked })} /><span><Globe2 size={16} />联网搜索</span></label></fieldset>
        {error ? <div className="error">{error}</div> : null}
      </form>
      <section className="agent-debug"><header><div><strong>预览与调试</strong><small>{chatModels.find((model) => model.id === draft.modelId)?.name || "尚未选择模型"}</small></div><button className="secondary" onClick={() => setDebugMessages([])}>清空</button></header><div className="debug-messages">{debugMessages.length ? debugMessages.map((message, index) => <div key={index} className={`debug-message ${message.role}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>) : <div className="debug-empty"><span style={{ background: draft.color }}>{draft.avatar}</span><h3>{draft.name || "你的智能体"}</h3><p>{draft.description || "在左侧填写描述，然后发一条消息测试提示词和模型效果。"}</p></div>}{debugging ? <div className="typing">正在生成测试回答…</div> : null}</div><form className="debug-composer" onSubmit={debug}><textarea rows={2} value={debugInput} onChange={(e) => setDebugInput(e.target.value)} placeholder="输入一条测试消息" /><button className="primary send" disabled={!debugInput.trim() || !draft.modelId || debugging}><Send size={17} /></button></form></section>
    </div>
  </section>;
}

function AccountPage({ user, models, defaultModelId, onModelChange, onOpenSidebar }: { user: User; models: Model[]; defaultModelId: string; onModelChange: () => Promise<void>; onOpenSidebar: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [billing, setBilling] = useState<{ balanceMicros: number; ledger: PowerLedgerEntry[]; orders: RechargeOrder[]; usage: UsageRecord[]; rechargeCnyPerPower: number } | null>(null);
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);
  const [rechargePower, setRechargePower] = useState("50");

  async function loadBilling() { setBilling(await api("/api/me/billing")); }
  useEffect(() => { loadBilling().catch((error) => setNotice(error.message)); }, []);
  useEffect(() => { setSelectedModelId(defaultModelId); }, [defaultModelId]);

  async function chooseModel(modelId: string) {
    setSelectedModelId(modelId); setNotice("");
    try { await api("/api/me/model", { method: "PATCH", body: JSON.stringify({ modelId }) }); await onModelChange(); setNotice("默认模型已更新"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "模型更新失败"); }
  }

  async function recharge(event: FormEvent) {
    event.preventDefault(); setNotice("");
    try { const result = await api<{ message: string }>("/api/me/recharge-orders", { method: "POST", body: JSON.stringify({ power: Number(rechargePower) }) }); setNotice(result.message); await loadBilling(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "充值申请失败"); }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    if (newPassword !== confirmPassword) {
      setNotice("两次输入的新密码不一致");
      return;
    }
    try {
      await api("/api/me/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword })
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice("密码已更新");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "密码修改失败");
    }
  }

  return (
    <section className="account-page">
      <header className="admin-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div>
          <h2>账号设置</h2>
          <p>{user.username} · {user.role === "admin" ? "管理员" : "ONE 用户"}</p>
        </div>
      </header>
      <div className="account-body">
        <section className="account-panel account-balance-card">
          <div className="account-panel-title"><Wallet size={18} /><h3>我的电力</h3></div>
          <strong className="power-balance">{power(billing?.balanceMicros)} <small>电力</small></strong>
          <p className="hint">每次 AI 工作按模型实际 Token 用量结算。</p>
          <form className="recharge-inline" onSubmit={recharge}>
            <select value={rechargePower} onChange={(event) => setRechargePower(event.target.value)}><option value="10">10 电力</option><option value="50">50 电力</option><option value="100">100 电力</option><option value="500">500 电力</option></select>
            <span>约 ¥{((Number(rechargePower) || 0) * (billing?.rechargeCnyPerPower || 0)).toFixed(2)}</span>
            <button className="primary" type="submit">充值</button>
          </form>
          <small className="hint">当前支付通道尚未接入；点击后生成待处理订单，便于后续联调支付。</small>
        </section>
        <section className="account-panel">
          <div className="account-panel-title"><Bot size={18} /><h3>默认模型</h3></div>
          <p className="hint">ONE 已经替你选好默认模型。只有需要时，才在这里切换。</p>
          <select value={selectedModelId} onChange={(event) => chooseModel(event.target.value)}>{models.filter((model) => model.kind === "chat").map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
        </section>
        <form className="account-panel" onSubmit={changePassword}>
          <div className="account-panel-title"><LockKeyhole size={18} /><h3>修改密码</h3></div>
          <label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <label>新密码<input type="password" autoComplete="new-password" placeholder="至少 8 个字符" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label>确认新密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
          <button className="primary" type="submit" disabled={!currentPassword || newPassword.length < 8 || !confirmPassword}>更新密码</button>
        </form>
        <section className="account-panel account-ledger-panel">
          <div className="account-panel-title"><ReceiptText size={18} /><h3>最近账单</h3></div>
          <div className="mini-ledger">{billing?.ledger.length ? billing.ledger.slice(0, 12).map((entry) => <div key={entry.id}><span><strong>{entry.title}</strong><small>{dateTime(entry.createdAt)}</small></span><b className={entry.amountMicros >= 0 ? "positive" : "negative"}>{entry.amountMicros > 0 ? "+" : ""}{power(entry.amountMicros, 6)}</b></div>) : <p className="hint">还没有账单记录</p>}</div>
        </section>
        {notice ? <div className="notice account-wide-notice">{notice}</div> : null}
      </div>
    </section>
  );
}

function KnowledgePage({
  onOpenSidebar,
  onConnectionChange
}: {
  onOpenSidebar: () => void;
  onConnectionChange?: (connection: KnowledgeConnection, configured: boolean) => void;
}) {
  const [connection, setConnection] = useState<KnowledgeConnection>({ provider: "getnote", status: "disconnected" });
  const [configured, setConfigured] = useState(false);
  const [testConnectAvailable, setTestConnectAvailable] = useState(false);
  const [flow, setFlow] = useState<GetNoteDeviceFlow | null>(null);
  const [polling, setPolling] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    const result = await api<{ connection: KnowledgeConnection; configured: boolean; testConnectAvailable?: boolean }>("/api/knowledge/connections/getnote");
    setConnection(result.connection);
    setConfigured(result.configured);
    setTestConnectAvailable(Boolean(result.testConnectAvailable));
    onConnectionChange?.(result.connection, result.configured);
  }

  useEffect(() => { load().catch((err) => setNotice(err.message)); }, []);

  useEffect(() => {
    if (!flow || !polling) return;
    let cancelled = false;
    const delay = Math.max(5, flow.interval || 5) * 1000;
    const expiresAt = Date.now() + flow.expiresIn * 1000;
    let retries = 0;
    let timer: number;
    async function poll() {
      if (cancelled) return;
      if (Date.now() >= expiresAt) { setFlow(null); setPolling(false); setNotice("授权已过期，请重新连接。"); return; }
      try {
        const result = await api<{ status?: "pending"; retryAfterSeconds?: number; connection?: KnowledgeConnection }>(`/api/knowledge/connections/getnote/device-flow/${encodeURIComponent(flow!.flowId)}/poll`, { method: "POST" });
        if (cancelled) return;
        if (result.connection) {
          setConnection(result.connection);
          onConnectionChange?.(result.connection, configured);
          setFlow(null);
          setPolling(false);
          setNotice("连接成功，ONE 现在可以读取你的得到大脑知识。");
        } else {
          retries = 0;
          timer = window.setTimeout(poll, Math.max(delay, (result.retryAfterSeconds || 0) * 1000));
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && [400, 401, 403, 404, 410, 428].includes(err.status || 0)) {
          setFlow(null); setPolling(false); setNotice(err.message);
        } else {
          setNotice("连接暂时不稳定，正在自动重试；你可以继续完成官方授权。");
          timer = window.setTimeout(poll, Math.min(30000, delay * 2 ** ++retries));
        }
      }
    }
    timer = window.setTimeout(poll, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [flow, polling]);

  async function connect() {
    setNotice("");
    try {
      if (testConnectAvailable) {
        const result = await api<{ connection: KnowledgeConnection }>("/api/knowledge/connections/getnote/test-connect", { method: "POST" });
        setConnection(result.connection);
        onConnectionChange?.(result.connection, configured);
        setNotice("测试知识已连接，现在可以直接提问。");
        return;
      }
      const result = await api<GetNoteDeviceFlow>("/api/knowledge/connections/getnote/device-flow", { method: "POST" });
      setFlow(result);
      setPolling(true);
      window.open(result.verificationUri, "_blank", "noopener,noreferrer");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "无法发起授权");
    }
  }

  async function disconnect() {
    if (!confirm("确认断开当前工作区与得到大脑的连接？")) return;
    await api("/api/knowledge/connections/getnote", { method: "DELETE" });
    setFlow(null);
    setPolling(false);
    await load();
  }

  return (
    <section className="account-page">
      <header className="admin-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div><h2>知识来源</h2><p>授权一次，之后由 ONE 自动读取并交给 AI</p></div>
      </header>
      <div className="account-body">
        <section className="account-panel knowledge-panel">
          <div className="knowledge-provider-head">
            <div className="provider-icon"><Database size={19} /></div>
            <div><h3>得到大脑</h3><p>首个支持的个人知识来源</p></div>
            <span className={`provider-status ${connection.status}`}>{connection.status === "connected" ? "已连接" : "未连接"}</span>
          </div>
          {connection.status === "connected" ? (
            <>
              <div className="notice">已连接得到大脑</div>
              <p className="hint">聊天时会自动检索你账号下的相关知识，用来帮助 AI 回答。</p>
              <button className="danger" type="button" onClick={disconnect}>断开连接</button>
            </>
          ) : (
            <>
              <p className="hint">连接前请先注册得到大脑并开通会员。首次连接会打开官方授权页；确认一次后，ONE 即可在后台调用你的知识。</p>
              <button className="primary" type="button" disabled={!configured || Boolean(flow)} onClick={connect}>{testConnectAvailable ? "一键连接测试知识" : "连接得到大脑"}</button>
              {testConnectAvailable ? <div className="notice">测试模式：将连接管理员预置的 Get 笔记账号，仅用于当前 MVP 验证。</div> : null}
              {!configured ? <div className="error">服务端尚未配置 GETNOTE_CLIENT_ID。</div> : null}
              {flow ? (
                <div className="notice">
                  授权码：<strong>{flow.userCode}</strong>。授权页已打开，系统正在自动确认…
                  <a href={flow.verificationUri} target="_blank" rel="noreferrer">重新打开授权页</a>
                  <button type="button" onClick={() => { setFlow(null); setPolling(false); setNotice(""); }}>取消等待 / 重新开始</button>
                </div>
              ) : null}
            </>
          )}
          {notice ? <div className={connection.status === "connected" ? "notice" : "error"}>{notice}</div> : null}
        </section>
      </div>
    </section>
  );
}

function MemoriesPage({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [limits, setLimits] = useState<MemoryLimits>({
    maxItems: 10,
    maxCharsPerItem: 200,
    maxTotalChars: 2000,
    usedItems: 0,
    usedChars: 0
  });
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true);
    try {
      const result = await api<{ memories: MemoryItem[]; limits: MemoryLimits }>("/api/memories");
      setMemories(result.memories);
      setLimits(result.limits);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function addMemory(event: FormEvent) {
    event.preventDefault();
    if (!content.trim()) return;
    try {
      await api("/api/memories", {
        method: "POST",
        body: JSON.stringify({ content: content.trim() })
      });
      setContent("");
      setNotice("记忆已添加");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "添加失败");
    }
  }

  async function saveMemory(memory: MemoryItem) {
    const value = editing[memory.id]?.trim();
    if (!value) return;
    try {
      await api(`/api/memories/${encodeURIComponent(memory.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ content: value })
      });
      setEditing(({ [memory.id]: _removed, ...rest }) => rest);
      setNotice("记忆已更新");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "更新失败");
    }
  }

  async function deleteMemory(memory: MemoryItem) {
    if (!confirm("确认删除这条个人记忆？")) return;
    try {
      await api(`/api/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
      setNotice("记忆已删除");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <section className="memory-page">
      <header className="admin-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}>
          <Menu size={20} />
        </button>
        <div>
          <h2>我的记忆</h2>
          <p>{limits.usedItems}/{limits.maxItems} 条 · {limits.usedChars}/{limits.maxTotalChars} 字</p>
        </div>
        <button className="secondary" onClick={load}>
          <Brain size={16} />
          刷新
        </button>
      </header>
      {notice ? <div className="notice">{notice}</div> : null}
      <form className="memory-create" onSubmit={addMemory}>
        <textarea
          value={content}
          maxLength={limits.maxCharsPerItem}
          rows={3}
          placeholder="添加一条希望 AI 长期记住的内容"
          onChange={(event) => setContent(event.target.value)}
        />
        <div className="memory-create-actions">
          <small>{content.length}/{limits.maxCharsPerItem}</small>
          <button className="primary" type="submit" disabled={!content.trim() || limits.usedItems >= limits.maxItems}>
            <Plus size={16} />
            添加
          </button>
        </div>
      </form>
      {loading ? (
        <div className="empty-state compact">加载中...</div>
      ) : memories.length ? (
        <div className="memory-list">
          {memories.map((memory) => (
            <article className="memory-card" key={memory.id}>
              {editing[memory.id] !== undefined ? (
                <textarea
                  value={editing[memory.id]}
                  maxLength={limits.maxCharsPerItem}
                  rows={3}
                  onChange={(event) => setEditing({ ...editing, [memory.id]: event.target.value })}
                />
              ) : (
                <pre>{memory.text}</pre>
              )}
              <div className="memory-meta">
                <small>{memory.updatedAt ? dateTime(memory.updatedAt) : memory.createdAt ? dateTime(memory.createdAt) : ""}</small>
                {editing[memory.id] !== undefined ? <small>{editing[memory.id].length}/{limits.maxCharsPerItem}</small> : null}
              </div>
              <div className="memory-card-actions">
                {editing[memory.id] !== undefined ? (
                  <button className="secondary" onClick={() => saveMemory(memory)}>
                    <Save size={15} />
                    保存
                  </button>
                ) : (
                  <button className="secondary" onClick={() => setEditing({ ...editing, [memory.id]: memory.text })}>
                    <Edit3 size={15} />
                    编辑
                  </button>
                )}
                <button className="danger" onClick={() => deleteMemory(memory)}>
                  <Trash2 size={15} />
                  删除
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state compact">
          <Brain size={36} />
          <h2>暂无个人记忆</h2>
        </div>
      )}
    </section>
  );
}

function AdminPanel({ refreshModels, onOpenSidebar }: { refreshModels: () => Promise<void>; onOpenSidebar: () => void }) {
  const [tab, setTab] = useState<"overview" | "users" | "keys" | "models" | "billing" | "usage" | "contexts" | "logs">("overview");
  const [users, setUsers] = useState<User[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [devices, setDevices] = useState<OneKeyDevice[]>([]);
  const [contextTraces, setContextTraces] = useState<ContextTraceSummary[]>([]);
  const [operations, setOperations] = useState<{ pendingOrders: RechargeOrder[]; usage: UsageRecord[]; ledger: PowerLedgerEntry[]; logs: AuditItem[]; settings: { rechargeCnyPerPower: number }; summary: { users: number; balanceMicros: number; chargedMicros: number; costMicros: number } } | null>(null);
  const [notice, setNotice] = useState("");

  async function load() {
    const [userResult, modelResult, deviceResult, operationResult, contextResult] = await Promise.all([
      api<{ users: User[] }>("/api/admin/users"),
      api<{ models: Model[] }>("/api/admin/models"),
      api<{ devices: OneKeyDevice[] }>("/api/admin/one-keys"),
      api<typeof operations>("/api/admin/operations"),
      api<{ traces: ContextTraceSummary[] }>("/api/admin/context-traces")
    ]);
    setUsers(userResult.users);
    setModels(modelResult.models);
    setDevices(deviceResult.devices);
    setOperations(operationResult);
    setContextTraces(contextResult.traces);
  }

  useEffect(() => {
    load().catch((err) => setNotice(err.message));
  }, []);

  return (
      <section className="admin-page">
        <header className="admin-header">
          <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}>
            <Menu size={20} />
          </button>
          <div>
            <h2>ONE 超管</h2>
            <p>模型、用户、电力与运行状态</p>
          </div>
        </header>
        <nav className="tabs">
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><ShieldCheck size={16} />总览</button>
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><Users size={16} />账号</button>
          <button className={tab === "keys" ? "active" : ""} onClick={() => setTab("keys")}><Usb size={16} />ONE Key</button>
          <button className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}><Bot size={16} />模型</button>
          <button className={tab === "billing" ? "active" : ""} onClick={() => setTab("billing")}><Wallet size={16} />电力</button>
          <button className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}><ReceiptText size={16} />账单</button>
          <button className={tab === "contexts" ? "active" : ""} onClick={() => setTab("contexts")}><Eye size={16} />上下文</button>
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}><FileText size={16} />日志</button>
        </nav>
        {notice ? <div className="notice">{notice}</div> : null}
        <div className="admin-body">
          {tab === "overview" ? <AdminOverview operations={operations} /> : null}
          {tab === "users" ? <UsersTab users={users} reload={load} /> : null}
          {tab === "keys" ? <OneKeysTab users={users} devices={devices} reload={load} /> : null}
          {tab === "models" ? <ModelsTab models={models} reload={async () => { await load(); await refreshModels(); }} /> : null}
          {tab === "billing" ? <AdminBilling users={users} operations={operations} reload={load} /> : null}
          {tab === "usage" ? <AdminUsage usage={operations?.usage || []} /> : null}
          {tab === "contexts" ? <AdminContexts traces={contextTraces} /> : null}
          {tab === "logs" ? <AdminLogs logs={operations?.logs || []} /> : null}
        </div>
      </section>
  );
}

function AdminOverview({ operations }: { operations: { summary: { users: number; balanceMicros: number; chargedMicros: number; costMicros: number }; pendingOrders: RechargeOrder[] } | null }) {
  const summary = operations?.summary;
  return <div className="ops-dashboard">
    <section className="ops-metric"><small>USERS</small><strong>{summary?.users ?? 0}</strong><span>独立账户</span></section>
    <section className="ops-metric"><small>POWER</small><strong>{power(summary?.balanceMicros)}</strong><span>用户余额</span></section>
    <section className="ops-metric"><small>REVENUE</small><strong>{power(summary?.chargedMicros)}</strong><span>累计消耗电力</span></section>
    <section className="ops-metric"><small>MARGIN</small><strong>{power((summary?.chargedMicros || 0) - (summary?.costMicros || 0))}</strong><span>模型毛利估算</span></section>
    <section className="ops-panel span-all"><h3>待处理</h3><p>{operations?.pendingOrders.length ? `${operations.pendingOrders.length} 笔充值订单等待入账` : "当前没有需要人工处理的事项"}</p></section>
  </div>;
}

function AdminBilling({ users, operations, reload }: { users: User[]; operations: { pendingOrders: RechargeOrder[]; ledger: PowerLedgerEntry[]; settings: { rechargeCnyPerPower: number } } | null; reload: () => Promise<void> }) {
  const [userId, setUserId] = useState(users[0]?.id || ""); const [gift, setGift] = useState("10"); const [rate, setRate] = useState(String(operations?.settings.rechargeCnyPerPower || 7)); const [notice, setNotice] = useState("");
  useEffect(() => { if (!userId && users[0]) setUserId(users[0].id); }, [users]);
  async function give(event: FormEvent) { event.preventDefault(); try { await api(`/api/admin/users/${userId}/power`, { method: "POST", body: JSON.stringify({ power: Number(gift) }) }); setNotice("电力已到账"); await reload(); } catch (error) { setNotice(error instanceof Error ? error.message : "赠送失败"); } }
  async function saveRate(event: FormEvent) { event.preventDefault(); try { await api("/api/admin/settings/billing", { method: "PATCH", body: JSON.stringify({ rechargeCnyPerPower: Number(rate) }) }); setNotice("充值汇率已更新"); await reload(); } catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); } }
  async function approve(order: RechargeOrder) { await api(`/api/admin/recharge-orders/${order.id}/approve`, { method: "POST" }); setNotice("充值已入账"); await reload(); }
  return <div className="admin-grid">
    <div className="admin-form-stack"><form className="admin-form" onSubmit={give}><h3><Wallet size={17} />赠送电力</h3><select value={userId} onChange={(event) => setUserId(event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.username} · {power(user.balanceMicros)} 电力</option>)}</select><input type="number" min="0.000001" step="0.000001" value={gift} onChange={(event) => setGift(event.target.value)} /><button className="primary">确认赠送</button></form><form className="admin-form" onSubmit={saveRate}><h3>充值汇率</h3><label>1 电力 = 人民币<input type="number" min="0.01" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} /></label><button className="secondary">保存汇率</button></form>{notice ? <div className="notice">{notice}</div> : null}</div>
    <div className="table"><h3>待入账充值</h3>{operations?.pendingOrders.length ? operations.pendingOrders.map((order) => <div className="table-row" key={order.id}><span>{order.username}<small>{dateTime(order.createdAt)}</small></span><span>{power(order.requestedMicros)} 电力 · ¥{order.amountCny.toFixed(2)}</span><button className="primary" onClick={() => approve(order)}>确认入账</button></div>) : <div className="empty-state compact">暂无待处理充值</div>}</div>
  </div>;
}

function AdminUsage({ usage }: { usage: UsageRecord[] }) { return <div className="ops-table"><div className="ops-table-head"><span>用户 / 模型</span><span>Token</span><span>收入 / 成本</span><span>时间 / 请求</span></div>{usage.map((item) => <div className="ops-table-row" key={item.id}><span><strong>{item.username}</strong><small>{item.modelName}</small></span><span>{item.inputTokens.toLocaleString()} in<br />{item.outputTokens.toLocaleString()} out</span><span>{power(item.chargedMicros, 6)} / {power(item.costMicros, 6)}</span><span>{dateTime(item.createdAt)}<small>{item.requestId || "-"}</small></span></div>)}</div>; }
function AdminContexts({ traces }: { traces: ContextTraceSummary[] }) {
  const [selectedId, setSelectedId] = useState(traces[0]?.id || "");
  const [detail, setDetail] = useState<ContextTraceDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!selectedId && traces[0]?.id) setSelectedId(traces[0].id);
  }, [selectedId, traces]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setError("");
    api<{ trace: ContextTraceDetail }>(`/api/admin/context-traces/${selectedId}`)
      .then((result) => setDetail(result.trace))
      .catch((err) => setError(err.message));
  }, [selectedId]);

  if (!traces.length) return <div className="empty-state compact"><Eye size={36} /><h2>还没有上下文记录</h2><p>部署后完成一次新问答，这里就会出现。</p></div>;
  return <div className="context-debugger">
    <aside className="context-trace-list">
      <div className="context-private-note"><LockKeyhole size={15} /><span>仅超管可见，包含用户私密对话与召回原文。</span></div>
      {traces.map((trace) => <button key={trace.id} className={selectedId === trace.id ? "active" : ""} onClick={() => setSelectedId(trace.id)}>
        <strong>{trace.query}</strong>
        <span>{trace.username} · {trace.modelName}</span>
        <small>{dateTime(trace.createdAt)}</small>
      </button>)}
    </aside>
    <section className="context-detail">
      {error ? <div className="error">{error}</div> : null}
      {detail ? <>
        <header><div><small>{detail.username} · {detail.modelName}</small><h3>{detail.query}</h3></div><span>{dateTime(detail.createdAt)}<small>{detail.requestId || "-"}</small></span></header>
        {detail.sections.map((section) => <article key={section.key} className="context-section"><h4>{section.title}</h4><pre>{section.content}</pre></article>)}
      </> : <div className="empty-state compact">正在读取…</div>}
    </section>
  </div>;
}
function AdminLogs({ logs }: { logs: AuditItem[] }) { return <div className="ops-table"><div className="ops-table-head"><span>操作人</span><span>事件</span><span>对象</span><span>时间 / 请求</span></div>{logs.map((item) => <div className="ops-table-row" key={item.id}><span>{item.actorName}</span><span>{item.action}</span><span>{item.targetType}</span><span>{dateTime(item.createdAt)}<small>{item.requestId || "-"}</small></span></div>)}</div>; }

function OneKeysTab({ users, devices, reload }: { users: User[]; devices: OneKeyDevice[]; reload: () => Promise<void> }) {
  const [userId, setUserId] = useState(users.find((user) => user.role === "user")?.id || users[0]?.id || "");
  const [serialNumber, setSerialNumber] = useState(`ONE-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-001`);
  const [notice, setNotice] = useState("");

  useEffect(() => { if (!userId && users[0]) setUserId(users[0].id); }, [users]);

  function downloadCredential(credential: OneKeyCredential, serial: string) {
    const value = { ...credential, serverBaseUrl: window.location.origin };
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${serial}.one-key.json`; link.click(); URL.revokeObjectURL(link.href);
  }

  async function provision(event: FormEvent) {
    event.preventDefault(); setNotice("");
    const user = users.find((item) => item.id === userId); if (!user) return;
    try {
      const result = await api<{ device: OneKeyDevice; deviceConfig: OneKeyCredential }>("/api/admin/one-keys", { method: "POST", body: JSON.stringify({ workspaceId: user.defaultWorkspaceId, userId: user.id, serialNumber }) });
      downloadCredential(result.deviceConfig, serialNumber);
      setNotice("设备已初始化，私钥配置已下载且不会再次显示。请把文件放入 U 盘 .one 文件夹。");
      await reload();
    } catch (error) { setNotice(error instanceof Error ? error.message : "初始化失败"); }
  }

  async function revoke(device: OneKeyDevice) { if (!confirm(`确认挂失 ${device.serialNumber}？`)) return; await api(`/api/admin/one-keys/${device.id}/revoke`, { method: "POST" }); await reload(); }

  return <div className="admin-grid">
    <form className="admin-form" onSubmit={provision}><h3><Usb size={17} />初始化 ONE Key</h3><label>绑定用户<select value={userId} onChange={(event) => setUserId(event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}</select></label><label>设备序列号<input value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} /></label><p className="hint">创建后只下载一次私钥。服务端仅保存公钥；普通 U 盘凭证可以被复制，首版不宣传为安全芯片。</p><button className="primary" disabled={!userId || !serialNumber.trim()}>生成并下载凭证</button>{notice ? <div className="notice">{notice}</div> : null}</form>
    <div className="table">{devices.map((device) => <div className="table-row" key={device.id}><span><strong>{device.serialNumber}</strong><small>{device.username} · {device.lastUsedAt ? `最近使用 ${dateTime(device.lastUsedAt)}` : "尚未使用"}</small></span><span>{device.status === "active" ? "正常" : "已挂失"}</span>{device.status === "active" ? <button className="danger" onClick={() => revoke(device)}>挂失</button> : <span />}</div>)}</div>
  </div>;
}

function UsersTab({ users, reload }: { users: User[]; reload: () => Promise<void> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [editing, setEditing] = useState<Record<string, { username: string; role: Role; enabled: boolean; password: string }>>({});
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState("");

  async function createUser(event: FormEvent) {
    event.preventDefault();
    if (password.length < 8) {
      setCreateNotice("初始密码至少需要 8 个字符");
      return;
    }
    setCreating(true);
    setCreateNotice("");
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username, password, role: "user" }) });
      setUsername("");
      setPassword("");
      setCreateNotice("账号已开通");
      await reload();
    } catch (err) {
      setCreateNotice(err instanceof Error ? err.message : "账号开通失败");
    } finally {
      setCreating(false);
    }
  }

  async function toggle(user: User) {
    await api(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !user.enabled }) });
    await reload();
  }

  async function saveUser(user: User) {
    const draft = editing[user.id];
    if (!draft) return;
    await api(`/api/admin/users/${user.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        username: draft.username,
        role: draft.role,
        enabled: draft.enabled,
        password: draft.password
      })
    });
    setEditing(({ [user.id]: _removed, ...rest }) => rest);
    await reload();
  }

  async function deleteUser(user: User) {
    if (!confirm(`确认删除账号 ${user.username}？该账号的聊天记录也会删除。`)) return;
    await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
    await reload();
  }


  return (
    <div className="admin-grid">
      <div className="admin-form-stack">
        <form className="admin-form" onSubmit={createUser}>
          <h3><UserPlus size={17} />开通账号</h3>
          <input placeholder="用户名" value={username} onChange={(event) => setUsername(event.target.value)} />
          <input type="password" autoComplete="new-password" placeholder="初始密码（至少 8 位）" value={password} onChange={(event) => setPassword(event.target.value)} />
          {createNotice ? <div className={createNotice === "账号已开通" ? "notice import-notice" : "error import-notice"}>{createNotice}</div> : null}
          <button className="primary" type="submit" disabled={!username.trim() || !password || creating}>
            <Plus size={16} />{creating ? "正在创建" : "创建"}
          </button>
        </form>
      </div>
      <div className="table">
        {users.map((user) => (
          <div className="table-row editable-row" key={user.id}>
            {editing[user.id] ? (
              <>
                <label className="field-label">用户名<input value={editing[user.id].username} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], username: event.target.value } })} /></label>
                <label className="field-label">角色<select value={editing[user.id].role} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], role: event.target.value as Role } })}>
                    <option value="user">普通用户</option>
                    <option value="admin">管理员</option>
                  </select></label>
                <label className="field-label">新密码<input type="password" autoComplete="new-password" placeholder="留空不改，至少 8 位" value={editing[user.id].password} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], password: event.target.value } })} /></label>
                <label className="inline-check"><input type="checkbox" checked={editing[user.id].enabled} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], enabled: event.target.checked } })} />启用</label>
                <button className="secondary" onClick={() => saveUser(user)}><Save size={15} />保存</button>
              </>
            ) : (
              <>
                <span>{user.username}<small>{user.enabled ? "启用" : "停用"}</small></span>
                <span>{user.role === "admin" ? "管理员" : "普通用户"}</span>
                <button className="secondary" onClick={() => setEditing({ ...editing, [user.id]: { username: user.username, role: user.role, enabled: user.enabled, password: "" } })}><Edit3 size={15} />编辑</button>
                <button className="secondary" onClick={() => toggle(user)}>{user.enabled ? "停用" : "启用"}</button>
                <button className="danger" onClick={() => deleteUser(user)}><Trash2 size={15} />删除</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelsTab({ models, reload }: { models: Model[]; reload: () => Promise<void> }) {
  const [form, setForm] = useState({
    name: "",
    kind: "chat" as "chat" | "image",
    protocol: "openai" as "openai" | "anthropic",
    baseUrl: "https://app.yylx.io/v1",
    apiKey: "",
    model: "",
    systemPrompt: "",
    inputPowerPerMillion: 3,
    outputPowerPerMillion: 15,
    costInputPowerPerMillion: 2,
    costOutputPowerPerMillion: 10,
    enabled: true,
    isDefault: false
  });
  const [editing, setEditing] = useState<Record<string, { name: string; kind: "chat" | "image"; protocol: "openai" | "anthropic"; baseUrl: string; model: string; apiKey: string; systemPrompt: string; inputPowerPerMillion: number; outputPowerPerMillion: number; costInputPowerPerMillion: number; costOutputPowerPerMillion: number; enabled: boolean; isDefault: boolean }>>({});

  async function createModel(event: FormEvent) {
    event.preventDefault();
    await api("/api/admin/models", { method: "POST", body: JSON.stringify(form) });
    setForm({ name: "", kind: "chat", protocol: "openai", baseUrl: "https://app.yylx.io/v1", apiKey: "", model: "", systemPrompt: "", inputPowerPerMillion: 3, outputPowerPerMillion: 15, costInputPowerPerMillion: 2, costOutputPowerPerMillion: 10, enabled: true, isDefault: false });
    await reload();
  }

  async function toggle(model: Model) {
    await api(`/api/admin/models/${model.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !model.enabled }) });
    await reload();
  }

  async function saveModel(model: Model) {
    const draft = editing[model.id];
    if (!draft) return;
    await api(`/api/admin/models/${model.id}`, {
      method: "PATCH",
      body: JSON.stringify(draft)
    });
    setEditing(({ [model.id]: _removed, ...rest }) => rest);
    await reload();
  }

  async function deleteModel(model: Model) {
    if (!confirm(`确认删除模型 ${model.name}？`)) return;
    await api(`/api/admin/models/${model.id}`, { method: "DELETE" });
    await reload();
  }

  return (
    <div className="admin-grid wide">
      <form className="admin-form" onSubmit={createModel}>
        <h3>接入模型</h3>
        <input placeholder="展示名称，如 通义千问" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as "chat" | "image", protocol: event.target.value === "image" ? "openai" : form.protocol })}>
          <option value="chat">聊天模型</option>
          <option value="image">图片模型</option>
        </select>
        {form.kind === "chat" ? (
          <select value={form.protocol} onChange={(event) => setForm({ ...form, protocol: event.target.value as "openai" | "anthropic" })}>
            <option value="openai">OpenAI 兼容协议</option>
            <option value="anthropic">Claude / Anthropic 协议</option>
          </select>
        ) : null}
        <input placeholder="Base URL，如 https://dashscope.aliyuncs.com/compatible-mode/v1" value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        <input type="password" autoComplete="new-password" placeholder="API Key" value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
        <input placeholder="模型 ID，如 qwen-plus / gpt-image-2" value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })} />
        <div className="price-fields"><label>对外输入价<small>电力 / 百万 Token</small><input type="number" min="0" step="0.000001" value={form.inputPowerPerMillion} onChange={(event) => setForm({ ...form, inputPowerPerMillion: Number(event.target.value) })} /></label><label>对外输出价<small>电力 / 百万 Token</small><input type="number" min="0" step="0.000001" value={form.outputPowerPerMillion} onChange={(event) => setForm({ ...form, outputPowerPerMillion: Number(event.target.value) })} /></label><label>进价 · 输入<small>仅超管可见</small><input type="number" min="0" step="0.000001" value={form.costInputPowerPerMillion} onChange={(event) => setForm({ ...form, costInputPowerPerMillion: Number(event.target.value) })} /></label><label>进价 · 输出<small>仅超管可见</small><input type="number" min="0" step="0.000001" value={form.costOutputPowerPerMillion} onChange={(event) => setForm({ ...form, costOutputPowerPerMillion: Number(event.target.value) })} /></label></div>
        <textarea placeholder="模型默认 System Prompt，可留空" value={form.systemPrompt} rows={4} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} />
        <label className="check"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />启用</label>
        <label className="check"><input type="checkbox" checked={form.isDefault} disabled={form.kind !== "chat" || !form.enabled} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} />设为新聊天默认模型</label>
        <button className="primary"><Plus size={16} />保存模型</button>
      </form>
      <div className="table">
        {models.map((model) => (
          <div className="table-row model-row editable-row" key={model.id}>
            {editing[model.id] ? (
              <>
                <label className="field-label">展示名称<input value={editing[model.id].name} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], name: event.target.value } })} /></label>
                <label className="field-label">类型<select value={editing[model.id].kind} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], kind: event.target.value as "chat" | "image" } })}>
                    <option value="chat">聊天模型</option>
                    <option value="image">图片模型</option>
                  </select></label>
                {editing[model.id].kind === "chat" ? (
                  <label className="field-label">接口协议<select value={editing[model.id].protocol} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], protocol: event.target.value as "openai" | "anthropic" } })}>
                    <option value="openai">OpenAI 兼容协议</option>
                    <option value="anthropic">Claude / Anthropic 协议</option>
                  </select></label>
                ) : null}
                <label className="field-label">Base URL<input value={editing[model.id].baseUrl} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], baseUrl: event.target.value } })} /></label>
                <label className="field-label">模型 ID<input value={editing[model.id].model} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], model: event.target.value } })} /></label>
                <label className="field-label">替换 API Key<input type="password" autoComplete="new-password" placeholder="留空则保持原 Key" value={editing[model.id].apiKey} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], apiKey: event.target.value } })} /></label>
                <label className="field-label">对外输入价<input type="number" min="0" step="0.000001" value={editing[model.id].inputPowerPerMillion} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], inputPowerPerMillion: Number(event.target.value) } })} /></label>
                <label className="field-label">对外输出价<input type="number" min="0" step="0.000001" value={editing[model.id].outputPowerPerMillion} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], outputPowerPerMillion: Number(event.target.value) } })} /></label>
                <label className="field-label">输入进价<input type="number" min="0" step="0.000001" value={editing[model.id].costInputPowerPerMillion} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], costInputPowerPerMillion: Number(event.target.value) } })} /></label>
                <label className="field-label">输出进价<input type="number" min="0" step="0.000001" value={editing[model.id].costOutputPowerPerMillion} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], costOutputPowerPerMillion: Number(event.target.value) } })} /></label>
                <label className="field-label model-prompt-field">System Prompt<textarea rows={4} value={editing[model.id].systemPrompt} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], systemPrompt: event.target.value } })} /></label>
                <label className="inline-check"><input type="checkbox" checked={editing[model.id].enabled} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], enabled: event.target.checked } })} />启用</label>
                <label className="inline-check"><input type="radio" checked={editing[model.id].isDefault} disabled={editing[model.id].kind !== "chat" || !editing[model.id].enabled} onChange={() => setEditing({ ...editing, [model.id]: { ...editing[model.id], isDefault: true } })} />新聊天默认</label>
                <button className="secondary" onClick={() => saveModel(model)}><Save size={15} />保存</button>
              </>
            ) : (
              <>
                <span>{model.name}<small>{model.kind === "image" ? "图片" : model.protocol === "anthropic" ? "聊天 · Anthropic" : "聊天 · OpenAI"} · {model.model}{model.isDefault ? " · 新聊天默认" : ""}</small></span>
                <span>{model.hasApiKey ? "已配置 Key" : "缺少 Key"}<small>售价 {model.inputPowerPerMillion} / {model.outputPowerPerMillion} 电力</small></span>
                <button className="secondary" onClick={() => setEditing({ ...editing, [model.id]: { name: model.name, kind: model.kind, protocol: model.protocol, baseUrl: model.baseUrl, model: model.model, apiKey: "", systemPrompt: model.systemPrompt || "", inputPowerPerMillion: model.inputPowerPerMillion, outputPowerPerMillion: model.outputPowerPerMillion, costInputPowerPerMillion: model.costInputPowerPerMillion, costOutputPowerPerMillion: model.costOutputPowerPerMillion, enabled: model.enabled, isDefault: model.isDefault } })}><Edit3 size={15} />编辑</button>
                <button className="secondary" onClick={() => toggle(model)}>{model.enabled ? "停用" : "启用"}</button>
                <button className="danger" onClick={() => deleteModel(model)}><Trash2 size={15} />删除</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootMessage, setBootMessage] = useState("加载中...");

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const loginCode = fragment.get("one-key");
    const request = loginCode
      ? (setBootMessage("正在验证 ONE Key..."), api<{ user: User }>("/api/auth/one-key/redeem", { method: "POST", body: JSON.stringify({ loginCode }) }))
      : api<{ user: User }>("/api/me");
    request
      .then((result) => { setUser(result.user); if (loginCode) window.history.replaceState({}, "", "/"); })
      .catch(() => { if (loginCode) window.history.replaceState({}, "", "/"); })
      .finally(() => setBooting(false));
  }, []);

  if (booting) return <div className="boot">{bootMessage}</div>;
  if (!user) return <Login onDone={setUser} />;
  return (
    <ChatApp
      user={user}
      onLogout={() => {
        api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        setUser(null);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
