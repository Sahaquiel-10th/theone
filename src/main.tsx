import React, { FormEvent, createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  Check,
  ArrowUp,
  ArrowUpRight,
  Bot,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Download,
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
  Maximize2,
  Minimize2,
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
import "./one-refinements.css";
import "./one-studio.css";
import "./one-surfaces.css";
import "./one-login.css";
import "./one-attention.css";
import "./one-beta.css";
import "./one-onboarding.css";
import { BetaUserInsights } from "./BetaUserInsights";
import { mergeTaskSnapshots, recoverTaskDraft } from "./oneStudioState";
import { buildTaskActivityRows, getSettledTaskTransitions, selectConversationExecution, shouldAutoReadTaskNotice, type TaskActivityRow } from "./oneTaskAttention";
import { OneCompanionEye as OneHeroEye } from "./OneCompanionEye";
import { api, apiForUser, ApiError, expectUser, announceSessionChange, SESSION_EVENT, SESSION_STORAGE_KEY } from "./oneApi";
import { chatSubmission, forgetChatSubmission, pendingChatSubmissions } from "./chatSubmission";
import { Onboarding, ProfileNameEditor, BetaFeedbackControls, type AccountProfile, type ProfilePatch } from "./Onboarding";
import { getNotePollFailureAction, prepareGetNoteAuthorizationWindow } from "./getNoteAuthorization";
import { PaymentPanel } from "./PaymentPanel";
import { PricingPanel } from "./PricingPanel";
import { GiftBatchHistory } from "./GiftBatchHistory";

type Role = "admin" | "user";
const PrivateApiContext = createContext<typeof api>(api);

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
  profile?: AccountProfile;
};

type Model = {
  pricing?: { referenceInput: number; referenceOutput: number; multiplier: number; version: number; label: string };
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
  imagePowerPerCall?: number;
  costImagePowerPerCall?: number;
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
  requestId?: string;
  knowledgeDiagnostics?: { status: "used" | "no_match" | "not_connected" | "partial" | "failed"; failures: { message: string }[] };
  attachmentWarning?: string;
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
  knowledge?: { providers: KnowledgeConnection["provider"][] };
};

type KnowledgeConnection = {
  provider: "getnote" | "notion" | "yinxiang" | "flowus";
  status: "disconnected" | "pending" | "connected" | "error" | "revoked";
  providerSpaceName?: string;
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

type TransitionPoint = { x: number; y: number };
type OneViewTransition = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void> };
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => OneViewTransition;
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

type PowerLedgerEntry = { id: string; type: "gift" | "recharge" | "usage" | "adjustment" | "refund"; amountMicros: number; balanceAfterMicros: number; title: string; createdAt: string; username?: string };
type RechargeOrder = { id: string; userId: string; requestedMicros: number; amountCny: number; status: "pending" | "paid" | "cancelled"; createdAt: string; username?: string };
type UsageRecord = { id: string; userId: string; modelId: string; inputTokens: number; outputTokens: number; totalTokens: number; chargedMicros?: number; costMicros?: number; requestId?: string; createdAt: string; username?: string; modelName?: string; source?: "provider" | "estimated" | "unknown" | "fixed"; status?: "pending" | "success" | "failed" | "needs_review" | "waived"; activity?: "chat" | "execution_compile" | "local_agent"; durationMs?: number };
type UsageTotals = { calls: number; inputTokens: number; outputTokens: number; chargedMicros: number; costMicros: number; unknownCostCalls?: number; reviewCalls?: number; failedCalls?: number };
type UserUsageSummary = {
  userId: string; workspaceId: string; username: string; role?: Role; enabled: boolean; balanceMicros: number; reservedMicros?: number;
  today: UsageTotals; sevenDays: UsageTotals; total: UsageTotals; conversationCount: number;
  knowledgeRecallCount: number; executionCount: number; activeKeyCount: number; activeDays7d?: number; lastUsedAt?: string;
};
type UsageActivity = { id: string; action: string; targetType: string; requestId?: string; createdAt: string };
type UserUsageDetail = { user: { id: string; username: string; enabled: boolean }; usage: UsageRecord[]; activity: UsageActivity[]; pagination: { offset: number; limit: number; total: number; hasMore: boolean }; activityTotal: number; period: string };
type AuditItem = { id: string; actorName?: string; action: string; targetType: string; requestId?: string; createdAt: string };
type OneKeyDevice = { id: string; serialNumber: string; workspaceId: string; userId: string; username: string; status: "active" | "revoked"; createdAt: string; lastUsedAt?: string; revokedAt?: string };
type ContextTraceSummary = { id: string; workspaceId: string; userId: string; username: string; conversationId: string; conversationTitle: string; modelName: string; requestId?: string; query: string; responsePreview: string; createdAt: string };
type ContextTraceDetail = ContextTraceSummary & { assistantMessageId: string; modelId: string; sections: { key: string; title: string; content: string }[] };
type OneKeyCredential = { version: 1; deviceId: string; privateKeyRaw: string; publicKeyRaw: string; serverBaseUrl?: string };
type RuntimeUpdateStatus = {
  configured: boolean;
  supported: boolean;
  current?: { platform: "macos" | "windows"; architecture: string; version: string; updateProtocol: number };
  latestVersion?: string;
  available: boolean;
  progress?: { requestId: string; status: "requested" | "downloading" | "verifying" | "installing" | "completed" | "failed"; version: string; message?: string; updatedAt: string };
};

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

function executionStatusLabel(task: ExecutionTask | null, preparing = false) {
  if (preparing) return "正在接管任务";
  if (!task) return "准备开始";
  if (task.status === "queued" || task.status === "selecting_target") return "正在连接本机";
  if (task.status === "running") return "正在替你工作";
  if (task.status === "completed") return "任务已经完成";
  if (task.status === "cancelled") return "任务已停止";
  return "遇到了一点问题";
}

function isExecutionRunning(task?: ExecutionTask | null) {
  return Boolean(task && ["queued", "selecting_target", "running"].includes(task.status));
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

function OneWorkingPresence({ message, expanded = false }: { message: string; expanded?: boolean }) {
  return (
    <div className={`one-working-presence ${expanded ? "expanded" : "compact"}`}>
      <div className="one-working-eye">
        {expanded ? <OneHeroEye mood="thinking" /> : <OneEye size="sm" mood="thinking" decorative />}
      </div>
      <div className="one-working-copy">
        <small>ONE · THINKING</small>
        <strong role="status">正在想…</strong>
        <span className="one-wait-line" key={message} aria-live="off">{message}</span>
      </div>
    </div>
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

function MessageSources({ message }: { message: Message }) {
  const { sources, knowledgeDiagnostics: knowledge } = message;
  if (!sources?.length && !knowledge && !message.attachmentWarning) return null;
  return (
    <details className="one-answer-sources">
      <summary>{knowledge ? ({ used: "已参考你的知识", no_match: "没有找到相关知识", not_connected: "未连接知识来源", partial: "已参考部分知识", failed: "知识读取失败 · 本次仅由模型回答" })[knowledge.status] : "查看参考资料"}{sources?.length ? ` · ${sources.length} 条来源` : ""}</summary>
      {knowledge?.failures.map((failure, index) => <p className="one-source-warning" key={index}>{failure.message}</p>)}
      {message.attachmentWarning ? <p className="one-source-warning">{message.attachmentWarning}</p> : null}
      {sources?.map((source, index) => <section key={`${source.url}-${index}`}><a href={/^https?:\/\//i.test(source.url) ? source.url : undefined} target="_blank" rel="noreferrer">{index + 1}. {source.title}</a><p>{source.snippet}</p></section>)}
    </details>
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
            <h1>超管登录</h1>
          </div>
        </div>
        <div className="notice">普通用户请从 U 盘打开 ONE。</div>
        <label>
          账号
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
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
            autoComplete="current-password"
            name="workspace-passcode"
          />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <button className="primary" type="submit">
          <KeyRound size={18} />
          超管登录
        </button>
      </form>
    </main>
  );
}

function ExecutionDisclosure({ task, events, preparing, expanded, onToggle, onStop }: {
  task: ExecutionTask | null; events: ExecutionEvent[]; preparing: boolean; expanded: boolean;
  onToggle: () => void; onStop: (source: HTMLElement) => void;
}) {
  const [trace, setTrace] = useState("");
  const steps = events.filter(event => event.kind === "status" || event.kind === "error");
  const latestStep = steps[steps.length - 1]?.text;
  const api = useContext(PrivateApiContext);
  const status = preparing ? "preparing" : task?.status || "preparing";
  const busy = preparing || isExecutionRunning(task);
  return <section id="one-current-execution" className={`execution-disclosure ${status} ${expanded ? "is-expanded" : ""}`} aria-label="本机执行">
    <div className="execution-disclosure-header">
      <button className="execution-disclosure-toggle" type="button" aria-expanded={expanded} aria-controls="one-execution-content" onClick={onToggle}>
        <span className={`task-indicator ${busy ? "running" : status}`} aria-hidden="true">{status === "completed" ? <Check size={12} /> : null}</span>
        <span><strong>{executionStatusLabel(task, preparing)}</strong><small>{preparing ? "正在连接本机…" : task?.status === "completed" ? "查看结果" : task?.status === "failed" ? "查看问题" : latestStep || "查看过程"}</small></span>
        <span className="execution-expand-label">{expanded ? "收起" : "展开"}</span><ChevronDown size={15} />
      </button>
      {isExecutionRunning(task) ? <button className="execution-stop" type="button" onClick={event => onStop(event.currentTarget)}><Square size={10} />停止</button> : null}
    </div>
    <div className="execution-disclosure-grid" data-open={expanded}>
      <div className="execution-disclosure-clip" inert={!expanded} aria-hidden={!expanded}>
        <div id="one-execution-content" className="execution-disclosure-body">
          {!busy && task?.status === "failed" ? <p className="execution-problem">{task.lastError || "执行未完成。"}</p> : !busy && task?.status === "completed" && task.finalResponse ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{task.finalResponse}</ReactMarkdown></div> : <p className="execution-current-step">{preparing ? "正在连接本机…" : task?.status === "cancelled" ? "已停止。" : latestStep || "等待本机反馈…"}</p>}
          {steps.length > 0 ? <details className="execution-step-history"><summary>过程记录 · {steps.length} 条</summary><ol>{steps.slice(-30).map(event => <li key={event.id} className={event.kind}>{event.text}</li>)}</ol>{steps.length > 30 ? <small>最近 30 条</small> : null}</details> : null}
          {task ? <details className="execution-step-history" onToggle={async event => {
            if (!event.currentTarget.open || trace) return;
            setTrace("正在读取…");
            try {
              const result = await api<{ instruction: string }>(`/api/executions/${encodeURIComponent(task.id)}/trace`);
              setTrace(result.instruction);
            } catch (error) { setTrace(error instanceof Error ? error.message : "暂时无法读取"); }
          }}><summary>交给本机的完整安排</summary><pre>{trace}</pre></details> : null}
        </div>
      </div>
    </div>
  </section>;
}

type TaskNotice = { id: string; conversationId: string; title: string; outcome: "reply" | "completed" | "failed" | "cancelled"; taskId?: string; read?: boolean };

function ChatApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const api = useContext(PrivateApiContext);
  const [profile, setProfile] = useState<AccountProfile>(user.profile || { workspaceId: user.defaultWorkspaceId, displayName: "", onboarding: { knowledgeChoice: "pending" }, updatedAt: user.createdAt });
  const [pendingRequests, setPendingRequests] = useState(() => pendingChatSubmissions(user.id));
  const failedSubmissions = useRef(new Map<string, { content: string; attachmentIds: string[]; draftKey: string }>());
  async function saveProfile(patch: ProfilePatch) { const result = await api<{ profile: AccountProfile }>("/api/me/profile", { method: "PATCH", body: JSON.stringify(patch) }); setProfile(result.profile); return result.profile; }
  async function recoverAnswer(operationId: string) {
    try {
      const result = await api<{ conversation: Conversation }>(`/api/chat/operations/${encodeURIComponent(operationId)}`);
      const latest = await api<{ conversation: Conversation }>(`/api/conversations/${encodeURIComponent(result.conversation.id)}`).catch(() => result);
      result.conversation = latest.conversation;
      const failedDraft = failedSubmissions.current.get(operationId);
      if (failedDraft && resolvedDraftKey(composeKeyRef.current) === resolvedDraftKey(failedDraft.draftKey)
        && currentDraftRef.current.content === failedDraft.content
        && JSON.stringify(currentDraftRef.current.attachments.map(item => item.id)) === JSON.stringify(failedDraft.attachmentIds)) {
        setContent(""); setPendingAttachments([]); delete draftsRef.current[resolvedDraftKey(failedDraft.draftKey)];
      }
      failedSubmissions.current.delete(operationId);
      setConversations(items => [{ ...result.conversation, messagesLoaded: true }, ...items.filter(item => item.id !== result.conversation.id)]);
      setActiveId(result.conversation.id); setComposeNew(false); setView("chat"); setError(""); setFailedMessage("");
      forgetChatSubmission(user.id, operationId); setPendingRequests(pendingChatSubmissions(user.id));
    } catch (error) {
      // A 404 can race an earlier request still entering the server. Keep its ID
      // so a user retry remains idempotent; only an explicit safe failure resets it.
      if (error instanceof ApiError && error.retryable === true) { forgetChatSubmission(user.id, operationId); setPendingRequests(pendingChatSubmissions(user.id)); }
      setError(error instanceof Error ? error.message : "暂时无法确认，请稍后查看");
    }
  }
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
  const [view, setView] = useState<"chat" | "admin" | "knowledge" | "account" | "agents" | "agentEditor">(() => { const params = new URLSearchParams(window.location.search); return params.has("notion") || params.has("knowledge") ? "knowledge" : "chat"; });
  const [editingAgentId, setEditingAgentId] = useState<string | "new">("new");
  const [showArchived, setShowArchived] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
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
  const [notionConnection, setNotionConnection] = useState<KnowledgeConnection>({ provider: "notion", status: "disconnected" });
  const [yinxiangConnection, setYinxiangConnection] = useState<KnowledgeConnection>({ provider: "yinxiang", status: "disconnected" });
  const [flowusConnection, setFlowusConnection] = useState<KnowledgeConnection>({ provider: "flowus", status: "disconnected" });
  const [runtimeUpdate, setRuntimeUpdate] = useState<RuntimeUpdateStatus | null>(null);
  const [runtimeUpdating, setRuntimeUpdating] = useState(false);
  const [executionTasks, setExecutionTasks] = useState<ExecutionTask[]>([]);
  const [eventsByTask, setEventsByTask] = useState<Record<string, ExecutionEvent[]>>({});
  const [taskStatusUnavailable, setTaskStatusUnavailable] = useState(true);
  const [selectedExecutionId, setSelectedExecutionId] = useState("");
  const [executionMode, setExecutionMode] = useState(false);
  const [preparingExecution, setPreparingExecution] = useState(false);
  const [preparingConversationId, setPreparingConversationId] = useState("");
  const [executionSourceMessageId, setExecutionSourceMessageId] = useState("");
  const [takeoverTaskId, setTakeoverTaskId] = useState("");
  const [composeNew, setComposeNew] = useState(false);
  const [composeMode, setComposeMode] = useState<"chat" | "execution">("chat");
  const [failedTaskIds, setFailedTaskIds] = useState<Set<string>>(() => new Set());
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [expandedExecutionId, setExpandedExecutionId] = useState("");
  const [expandedConversationId, setExpandedConversationId] = useState("");
  const [focusedTask, setFocusedTask] = useState(false);
  const [revealExecutionId, setRevealExecutionId] = useState("");
  const [taskNotices, setTaskNotices] = useState<TaskNotice[]>([]);
  const [visibleReceiptId, setVisibleReceiptId] = useState("");
  const observedTasksRef = useRef<ExecutionTask[]>([]);
  const executionOriginRef = useRef<TransitionPoint>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const draftsRef = useRef<Record<string, { content: string; attachments: AttachmentSummary[] }>>({});
  const draftAliasesRef = useRef<Record<string, string>>({});
  const composeKeyRef = useRef("new");
  composeKeyRef.current = composeNew || !activeId ? "new" : activeId;
  const currentDraftRef = useRef({ content, attachments: pendingAttachments });
  currentDraftRef.current = { content, attachments: pendingAttachments };
  const viewedConversationRef = useRef("");
  viewedConversationRef.current = view === "chat" ? activeId : "";

  const active = useMemo(() => conversations.find((item) => item.id === activeId), [activeId, conversations]);
  const targetConversation = composeNew ? undefined : active;
  const activeModelId = targetConversation?.modelId || draftModelId;
  const activeLoadingKey = active?.id || "draft";
  const activeLoading = Boolean(loadingByConversation[activeLoadingKey]);
  const executionTask = selectConversationExecution(executionTasks, activeId, selectedExecutionId);
  const executionEvents = executionTask ? eventsByTask[executionTask.id] || [] : [];
  const runningExecutions = executionTasks.filter(isExecutionRunning);
  const currentRunningExecution = runningExecutions.find(task => task.conversationId === activeId);
  const executionShortcut = currentRunningExecution || executionTask;
  const executionBusy = runningExecutions.length > 0;
  const activeExecutionMode = executionMode;
  const targetLoading = !composeNew && activeLoading;
  const studioIdle = view === "chat" && !activeId;
  const activePreparing = preparingExecution && preparingConversationId === activeId;
  const liveTaskIds = runningExecutions.map(task => task.id).sort().join("|");
  const currentModel = models.find((model) => model.id === activeModelId);
  const runtimeUpdateFailed = runtimeUpdate?.progress?.status === "failed";
  const activeAgentId = targetConversation?.agentId || draftAgentId;
  const activeAgent = agents.find((agent) => agent.id === activeAgentId);
  const canAttach = Boolean(currentModel) && (!activeAgent || activeAgent.allowFileUpload);
  const attachmentAccept = currentModel?.kind === "image"
    ? ".png,.jpg,.jpeg,.webp"
    : capabilities.attachments.extensions.map((extension) => `.${extension}`).join(",");
  const canSearch = currentModel?.kind === "chat" && capabilities.webSearch.enabled && (!activeAgent || activeAgent.allowWebSearch);
  const visibleConversations = conversations.filter((conversation) => conversation.archived === showArchived);
  const ungroupedConversations = visibleConversations.filter((conversation) => !conversation.folderId);
  const isWaiting = Object.values(loadingByConversation).some(Boolean) || executionBusy || preparingExecution;

  function announceTask(item: TaskNotice) {
    const read = shouldAutoReadTaskNotice(resolvedDraftKey(viewedConversationRef.current), item.conversationId, document.visibilityState === "visible");
    setTaskNotices(items => [{ ...item, read }, ...items.filter(previous => previous.conversationId !== item.conversationId)].slice(0, 12));
    setVisibleReceiptId(item.id);
  }

  function acknowledgeConversation(conversationId: string) {
    setTaskNotices(items => items.filter(item => item.conversationId !== conversationId));
  }

  useEffect(() => {
    const settled = getSettledTaskTransitions(observedTasksRef.current, executionTasks);
    observedTasksRef.current = executionTasks;
    for (const task of settled) announceTask({
      id: `${task.id}:${task.updatedAt}`, conversationId: task.conversationId, taskId: task.id,
      title: conversations.find(item => item.id === task.conversationId)?.title || "本机任务",
      outcome: task.status as "completed" | "failed" | "cancelled"
    });
  }, [executionTasks]);

  useEffect(() => {
    if (!visibleReceiptId) return;
    const timer = window.setTimeout(() => setVisibleReceiptId(""), 8000);
    return () => window.clearTimeout(timer);
  }, [visibleReceiptId]);

  useEffect(() => {
    if (!revealExecutionId || view !== "chat" || executionTask?.id !== revealExecutionId) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => {
      document.getElementById("one-current-execution")?.scrollIntoView({ behavior: reduced ? "instant" : "smooth", block: "nearest" });
      setRevealExecutionId("");
    }, reduced ? 0 : 340);
    return () => window.clearTimeout(timer);
  }, [revealExecutionId, executionTask?.id, view]);

  async function refresh() {
    const keep = <T,>(fallback: T) => (error: Error) => { setError(error.message); return fallback; };
    const [modelResult, conversationResult, workspaceResult, agentResult, capabilityResult, knowledgeResult, notionResult, yinxiangResult, flowusResult] = await Promise.all([
      api<{ models: Model[]; defaultModelId: string }>("/api/models").catch(keep({ models, defaultModelId })),
      api<{ conversations: Conversation[]; pagination: { page: number; hasMore: boolean } }>(
        `/api/conversations?summary=1&page=1&pageSize=${conversationPageSize}&archived=${showArchived}`
      ).catch(keep({ conversations, pagination: { page: conversationPage, hasMore: hasMoreConversations } })),
      api<{ folders: ConversationFolder[] }>("/api/folders").catch(keep({ folders })),
      api<{ agents: Agent[] }>("/api/agents").catch(keep({ agents })),
      api<AppCapabilities>("/api/capabilities").catch(keep(capabilities)),
      api<{ connection: KnowledgeConnection; configured: boolean }>("/api/knowledge/connections/getnote").catch(keep({ connection: knowledgeConnection, configured: false })),
      api<{ connection: KnowledgeConnection; configured: boolean }>("/api/knowledge/connections/notion").catch(keep({ connection: notionConnection, configured: false })),
      api<{ connection: KnowledgeConnection; configured: boolean }>("/api/knowledge/connections/yinxiang").catch(keep({ connection: yinxiangConnection, configured: false })),
      api<{ connection: KnowledgeConnection; configured: boolean }>("/api/knowledge/connections/flowus").catch(keep({ connection: flowusConnection, configured: false }))
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
      const retained = current.filter(item => item.messagesLoaded &&
        (item.id === activeId || item.id.startsWith("tmp_") || loadingByConversation[item.id]) &&
        !firstPage.some(summary => summary.id === item.id));
      return [...retained, ...firstPage];
    });
    setConversationPage(1);
    setHasMoreConversations(conversationResult.pagination.hasMore);
    setFolders(workspaceResult.folders);
    setAgents(agentResult.agents);
    setCapabilities(capabilityResult);
    setKnowledgeConnection(knowledgeResult.connection);
    setNotionConnection(notionResult.connection);
    setYinxiangConnection(yinxiangResult.connection);
    setFlowusConnection(flowusResult.connection);
    setDraftModelId((current) => (
      modelResult.models.some((model) => model.id === current)
        ? current
        : modelResult.defaultModelId || modelResult.models[0]?.id || ""
    ));
  }

  async function refreshRuntimeUpdate() {
    try {
      const result = await api<RuntimeUpdateStatus>("/api/runtime/update");
      setRuntimeUpdate(result);
      if (!result.available || result.progress?.status === "failed") setRuntimeUpdating(false);
    } catch {
      // Runtime update availability is optional and must never block the workspace.
      if (!runtimeUpdating) setRuntimeUpdate(null);
    }
  }

  async function installRuntimeUpdate() {
    setRuntimeUpdating(true);
    setError("");
    try {
      const result = await api<{ progress: NonNullable<RuntimeUpdateStatus["progress"]> }>("/api/runtime/update", { method: "POST" });
      setRuntimeUpdate(current => current ? { ...current, progress: result.progress } : current);
    } catch (updateError) {
      setRuntimeUpdating(false);
      setError(updateError instanceof Error ? updateError.message : "更新没有开始，请重试");
    }
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
    void refreshExecutionTasks();
    void refreshRuntimeUpdate();
  }, [showArchived]);

  useEffect(() => {
    if (!runtimeUpdating) return;
    const timer = window.setInterval(() => void refreshRuntimeUpdate(), 2500);
    return () => window.clearInterval(timer);
  }, [runtimeUpdating]);

  useEffect(() => {
    function refreshWhenVisible() {
      if (document.visibilityState === "visible") {
        refresh().catch(() => undefined);
        void refreshExecutionTasks();
        void refreshRuntimeUpdate();
      }
    }
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [showArchived, activeId]);

  function rememberExecution(task: ExecutionTask, events?: ExecutionEvent[]) {
    setExecutionTasks(items => mergeTaskSnapshots(items, [task]));
    if (events) setEventsByTask(items => ({ ...items, [task.id]: events }));
  }

  async function refreshExecutionTasks() {
    try {
      const result = await api<{ tasks: ExecutionTask[] }>("/api/executions");
      setExecutionTasks(current => mergeTaskSnapshots(current, result.tasks));
      setTaskStatusUnavailable(false);
    } catch { setTaskStatusUnavailable(true); }
  }

  useEffect(() => {
    if (!liveTaskIds) return;
    const streams = liveTaskIds.split("|").map(id => {
      const stream = new EventSource(`/api/executions/${encodeURIComponent(id)}/stream`);
      stream.onmessage = event => {
        try {
          const result = JSON.parse(event.data) as { task: ExecutionTask; events: ExecutionEvent[] };
          rememberExecution(result.task, result.events);
          setTaskStatusUnavailable(false);
          if (!isExecutionRunning(result.task)) stream.close();
        } catch { setTaskStatusUnavailable(true); }
      };
      stream.onerror = () => setTaskStatusUnavailable(true);
      return stream;
    });
    return () => streams.forEach(stream => stream.close());
  }, [liveTaskIds]);

  useEffect(() => {
    const task = executionTasks.find(item => item.id === takeoverTaskId);
    if (!executionMode || preparingExecution || !task || isExecutionRunning(task)) return;
    const timer = window.setTimeout(() => {
      transitionExecutionMode(false, executionOriginRef.current);
    }, task.status === "completed" ? 1100 : 700);
    return () => window.clearTimeout(timer);
  }, [executionTasks, executionMode, takeoverTaskId, preparingExecution]);

  async function loadLatestExecution(conversationId: string, selectedTaskId = "") {
    if (conversationId.startsWith("tmp_")) return;
    try {
      const result = await api<{ tasks: ExecutionTask[] }>(`/api/executions?conversationId=${encodeURIComponent(conversationId)}`);
      const latest = selectConversationExecution(result.tasks, conversationId, selectedTaskId);
      result.tasks.forEach(task => rememberExecution(task));
      const detailId = selectedTaskId || latest?.id;
      if (!detailId) return;
      const detail = await api<{ task: ExecutionTask; events: ExecutionEvent[] }>(`/api/executions/${encodeURIComponent(detailId)}`);
      rememberExecution(detail.task, detail.events);
    } catch { /* Execution history is an enhancement to the chat view. */ }
  }

  function pointFromElement(element?: HTMLElement | null): TransitionPoint {
    if (!element) return executionOriginRef.current;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  }

  function transitionExecutionMode(next: boolean, source?: HTMLElement | TransitionPoint | null) {
    delete document.documentElement.dataset.oneTransition;
    const point = source instanceof HTMLElement ? pointFromElement(source) : source || executionOriginRef.current;
    if (next) executionOriginRef.current = point;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const transitionDocument = document as ViewTransitionDocument;
    if (!transitionDocument.startViewTransition || reducedMotion) {
      setExecutionMode(next);
      return;
    }

    const radius = Math.hypot(
      Math.max(point.x, window.innerWidth - point.x),
      Math.max(point.y, window.innerHeight - point.y)
    );
    const transition = transitionDocument.startViewTransition(() => {
      flushSync(() => setExecutionMode(next));
    });

    transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${point.x}px ${point.y}px)`, `circle(${radius}px at ${point.x}px ${point.y}px)`] },
        {
          duration: next ? 430 : 380,
          easing: next ? "cubic-bezier(.2,.82,.2,1)" : "cubic-bezier(.3,.72,.2,1)",
          fill: "both",
          pseudoElement: "::view-transition-new(root)"
        } as KeyframeAnimationOptions & { pseudoElement: string }
      );
    }).catch(() => undefined);
  }

  function transitionInterface(update: () => void) {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const transitionDocument = document as ViewTransitionDocument;
    if (!transitionDocument.startViewTransition || reducedMotion) {
      update();
      return;
    }

    document.documentElement.dataset.oneTransition = "flow";
    const transition = transitionDocument.startViewTransition(() => flushSync(update));
    transition.finished.finally(() => { delete document.documentElement.dataset.oneTransition; }).catch(() => undefined);
    transition.ready.then(() => {
      document.documentElement.animate(
        [
          { opacity: .5, transform: "translateY(5px)" },
          { opacity: 1, transform: "translateY(0)" }
        ],
        {
          duration: 300,
          easing: "cubic-bezier(.2,.82,.2,1)",
          fill: "both",
          pseudoElement: "::view-transition-new(root)"
        } as KeyframeAnimationOptions & { pseudoElement: string }
      );
    }).catch(() => undefined);
    return transition.updateCallbackDone.catch(() => undefined);
  }

  function switchDraft(key: string) {
    const previousKey = composeNew || !activeId ? "new" : activeId;
    draftsRef.current[previousKey] = { content, attachments: pendingAttachments };
    const draft = draftsRef.current[key];
    setContent(draft?.content || "");
    setPendingAttachments(draft?.attachments || []);
    setComposeMode("chat");
    setFailedMessage("");
    setError("");
  }

  function resolvedDraftKey(key: string): string {
    return draftAliasesRef.current[key] ? resolvedDraftKey(draftAliasesRef.current[key]) : key;
  }

  function beginNewTask() {
    switchDraft("new");
    setComposeNew(true);
    requestAnimationFrame(() => document.getElementById("one-studio-input")?.focus());
  }

  function openSurface(next: "chat" | "admin" | "knowledge" | "account") {
    transitionInterface(() => {
      setView(next);
      setHistoryOpen(false);
      setSidebarOpen(false);
    });
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

  async function openConversation(conversation: Conversation, selectedTaskId = "") {
    switchDraft(conversation.id);
    acknowledgeConversation(conversation.id);
    setActivityExpanded(false);
    transitionInterface(() => {
      setActiveId(conversation.id);
      setSelectedExecutionId(selectedTaskId);
      setComposeNew(false);
      setView("chat");
      setError("");
      setSidebarOpen(false);
      setHistoryOpen(false);
    });
    void loadLatestExecution(conversation.id, selectedTaskId);
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

  async function openExecution(task: ExecutionTask) {
    setExpandedExecutionId(task.id);
    setRevealExecutionId(task.id);
    const conversation = conversations.find(item => item.id === task.conversationId);
    if (conversation) { await openConversation(conversation, task.id); return; }
    try {
      const result = await api<{ conversation: Conversation }>(`/api/conversations/${encodeURIComponent(task.conversationId)}`);
      const loaded = { ...result.conversation, messagesLoaded: true };
      setConversations(items => [loaded, ...items.filter(item => item.id !== loaded.id)]);
      await openConversation(loaded, task.id);
    } catch (err) { setError(err instanceof Error ? err.message : "暂时无法打开这件事"); }
  }

  function startNewChat() {
    switchDraft("new");
    transitionInterface(() => {
      setActiveId("");
      setComposeNew(true);
      setDraftAgentId("");
      setDraftModelId(defaultModelId || models[0]?.id || "");
      setError("");
      setWebSearch(false);
      setView("chat");
      setSidebarOpen(false);
      setHistoryOpen(false);
    });
  }

  function startAgentChat(agent: Agent) {
    switchDraft("new");
    transitionInterface(() => {
      setActiveId("");
      setComposeNew(true);
      setDraftAgentId(agent.id);
      setDraftModelId(agent.modelId);
      setContent("");
      setError("");
      setPendingAttachments([]);
      setWebSearch(false);
      setView("chat");
      setSidebarOpen(false);
    });
  }

  async function uploadAttachments(files: FileList | File[] | null) {
    if (!files?.length || uploadingAttachments) return;
    const uploadDraftKey = composeKeyRef.current;
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
      const key = resolvedDraftKey(uploadDraftKey);
      const isCurrent = resolvedDraftKey(composeKeyRef.current) === key;
      const draft = isCurrent ? currentDraftRef.current : draftsRef.current[key] || { content: "", attachments: [] };
      const attachments = [...draft.attachments, ...result.attachments].slice(0, capabilities.attachments.maxFiles);
      draftsRef.current[key] = { ...draft, attachments };
      if (isCurrent) setPendingAttachments(attachments);
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
    let operationId = "";
    const target = targetConversation;
    const modelId = target?.modelId || draftModelId;
    const text = rawText.trim();
    const attachments = [...pendingAttachments];
    const useWebSearch = canSearch;
    if ((!text && !attachments.length) || !modelId) return;
    const isNewConversation = !target || target.id.startsWith("tmp_");
    const tempId = isNewConversation ? target?.id || localId("tmp") : "";
    const loadingKey = target?.id || tempId;
    if (loadingByConversation[loadingKey]) return;
    setLoadingByConversation((items) => ({ ...items, [loadingKey]: true }));
    setError("");
    setFailedMessage("");
    setFailedTaskIds(ids => { const next = new Set(ids); next.delete(loadingKey); return next; });
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
    delete draftsRef.current[target?.id || "new"];
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
      await transitionInterface(() => {
        setConversations((items) => [optimistic, ...items.filter(item => item.id !== tempId)]);
        setActiveId(tempId);
        setComposeNew(false);
        setView("chat");
      });
    } else {
      setView("chat");
      setConversations((items) =>
        items.map((item) =>
          item.id === target.id
            ? { ...item, messages: [...item.messages, userMessage], updatedAt: userMessage.createdAt }
            : item
        )
      );
    }
    try {
      const payload = { content: text, modelId, conversationId: isNewConversation ? "" : target?.id,
        folderId: draftWorkspaceId, agentId: isNewConversation ? draftAgentId : target?.agentId,
        attachmentIds: attachments.map(attachment => attachment.id), webSearch: useWebSearch };
      operationId = await chatSubmission(user.id, payload);
      const result = await api<{ conversation: Conversation; knowledgeWarning?: string }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ ...payload, operationId })
      });
      forgetChatSubmission(user.id, operationId); setPendingRequests(pendingChatSubmissions(user.id));
      setConversations((items) => {
        const rest = items.filter((item) => item.id !== result.conversation.id && item.id !== tempId);
        return [{ ...result.conversation, messagesLoaded: true }, ...rest];
      });
      if (tempId) draftAliasesRef.current[tempId] = result.conversation.id;
      if (tempId && draftsRef.current[tempId]) {
        draftsRef.current[result.conversation.id] = draftsRef.current[tempId];
        delete draftsRef.current[tempId];
      }
      setActiveId((current) => (current === tempId || current === target?.id ? result.conversation.id : current));
      announceTask({ id: `reply:${result.conversation.id}:${result.conversation.updatedAt}`, conversationId: result.conversation.id, title: result.conversation.title, outcome: "reply" });
      setWebSearch(false);
    } catch (err) {
      if (operationId && err instanceof ApiError && err.retryable === true) forgetChatSubmission(user.id, operationId);
      if (operationId) failedSubmissions.current.set(operationId, { content: text, attachmentIds: attachments.map(item => item.id), draftKey: loadingKey });
      setPendingRequests(pendingChatSubmissions(user.id));
      const draftKey = resolvedDraftKey(loadingKey);
      const stillComposing = resolvedDraftKey(composeKeyRef.current) === draftKey;
      const existingDraft = stillComposing ? currentDraftRef.current : draftsRef.current[draftKey];
      // A failed request belongs to its own task, never to a newer draft.
      const recovered = recoverTaskDraft({ content: text, attachments }, existingDraft);
      draftsRef.current[draftKey] = recovered;
      setFailedTaskIds(ids => new Set(ids).add(draftKey));
      if (stillComposing) {
        setPendingAttachments(recovered.attachments);
        setContent(recovered.content);
        setFailedMessage(text || " ");
      }
      setConversations((items) =>
        tempId
          ? items.map(item => item.id === tempId ? { ...item, messages: [] } : item)
          : items.map((item) =>
              item.id === target?.id
                ? { ...item, messages: item.messages.filter((message) => message.id !== userMessage.id) }
                : item
            )
      );
      setError(stillComposing ? (err instanceof Error ? err.message : "发送失败") : `「${titleFrom(text)}」发送失败，草稿已保留。`);
    } finally {
      setLoadingByConversation((items) => ({ ...items, [loadingKey]: false }));
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (uploadingAttachments) return;
    const text = content;
    if (composeMode === "execution" && !composeNew) {
      if (!text.trim()) return;
      await sendExecutionMessage(text);
      return;
    }
    if ((!text.trim() && !pendingAttachments.length) || targetLoading) return;
    await sendMessage(text);
  }

  async function retryFailedMessage() {
    if ((!content && !pendingAttachments.length) || targetLoading) return;
    await sendMessage(content);
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
    if (conversation.id.startsWith("tmp_")) return;
    const result = await api<{ conversation: Conversation }>(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: !conversation.archived })
    });
    setConversations((items) => items.map((item) => (item.id === conversation.id ? result.conversation : item)));
    if (activeId === conversation.id && !showArchived) { switchDraft("new"); setActiveId(""); setComposeNew(true); }
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

  async function executeFromMessage(message: Message, source?: HTMLElement | null) {
    if (!active?.id || active.id.startsWith("tmp_") || !message.id || preparingExecution || executionBusy || activeLoading || taskStatusUnavailable) return;
    const origin = pointFromElement(source);
    executionOriginRef.current = origin;
    setPreparingExecution(true);
    setPreparingConversationId(active.id);
    setTakeoverTaskId("");
    setExecutionSourceMessageId(message.id);
    transitionExecutionMode(true, origin);
    setExpandedExecutionId("");
    setError("");
    try {
      const result = await api<{ task: ExecutionTask; events: ExecutionEvent[] }>("/api/executions/from-message", {
        method: "POST",
        body: JSON.stringify({ conversationId: active.id, sourceMessageId: message.id })
      });
      setTakeoverTaskId(result.task.id);
      setSelectedExecutionId(result.task.id);
      rememberExecution(result.task, result.events);
    } catch (err) {
      transitionExecutionMode(false, origin);
      setError(err instanceof Error ? err.message : "无法交给本机执行");
    } finally {
      setPreparingExecution(false);
      setPreparingConversationId("");
    }
  }

  async function sendExecutionMessage(rawText: string) {
    const text = rawText.trim();
    if (!executionTask || !text || executionBusy || preparingExecution || taskStatusUnavailable) return;
    const originalDraftKey = composeKeyRef.current;
    setContent("");
    setError("");
    setPreparingExecution(true);
    setPreparingConversationId(executionTask.conversationId);
    transitionExecutionMode(true, document.getElementById("one-studio-send"));
    try {
      const result = await api<{ task: ExecutionTask }>(`/api/executions/${encodeURIComponent(executionTask.id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ content: text })
      });
      setTakeoverTaskId(result.task.id);
      rememberExecution(result.task);
      setEventsByTask(items => ({ ...items, [result.task.id]: [] }));
      setComposeMode("chat");
    } catch (err) {
      const key = resolvedDraftKey(originalDraftKey);
      const isCurrent = resolvedDraftKey(composeKeyRef.current) === key;
      const recovered = recoverTaskDraft({ content: text, attachments: [] as AttachmentSummary[] }, isCurrent ? currentDraftRef.current : draftsRef.current[key]);
      draftsRef.current[key] = recovered;
      if (isCurrent) { setContent(recovered.content); setPendingAttachments(recovered.attachments); }
      transitionExecutionMode(false);
      setError(err instanceof Error ? err.message : "无法继续本机任务");
    } finally {
      setPreparingExecution(false);
      setPreparingConversationId("");
    }
  }

  async function cancelExecution(source?: HTMLElement | null, task = executionTask) {
    if (!task || !isExecutionRunning(task)) return;
    try {
      await api(`/api/executions/${encodeURIComponent(task.id)}/cancel`, { method: "POST" });
      transitionExecutionMode(false, pointFromElement(source));
      void refreshExecutionTasks();
    } catch (err) { setError(err instanceof Error ? err.message : "无法停止执行"); }
  }

  const visibleReceipt = taskNotices.find(item => item.id === visibleReceiptId);
  const heroMood: OneEyeMood = error
    ? "angry"
    : notice || visibleReceipt?.outcome === "completed" || visibleReceipt?.outcome === "reply"
      ? "pleased"
      : isWaiting
        ? "thinking"
        : content.trim()
          ? "curious"
          : "idle";

  const thinkingConversations = conversations.filter(item => loadingByConversation[item.id]);
  const composerTarget = composeNew || !active ? "新事情" : active.title;
  const unreadNotices = taskNotices.filter(item => !item.read);
  const activityRows = buildTaskActivityRows(conversations, executionTasks, new Set(thinkingConversations.map(item => item.id)), failedTaskIds, new Set(unreadNotices.map(item => item.conversationId)));
  const otherRows = activityRows.filter(item => view !== "chat" || item.conversationId !== activeId || item.unread);
  const activeOthers = otherRows.filter(item => item.status === "running" || item.status === "thinking");
  const settledOthers = otherRows.filter(item => item.status !== "running" && item.status !== "thinking");
  const latestTurnStart = Math.max(0, (active?.messages || []).map(message => message.role).lastIndexOf("user"));
  const showEarlier = expandedConversationId === activeId;
  const currentStatus = activePreparing ? "正在连接" : currentRunningExecution ? "本机执行中" : activeLoading ? "准备回复中" : failedTaskIds.has(activeId) ? "待重试" : executionTask?.status === "completed" ? "本机已完成" : executionTask?.status === "cancelled" ? "本机已停止" : executionTask?.status === "failed" ? "执行需要看一下" : "当前事情";
  const currentBusy = activePreparing || Boolean(currentRunningExecution) || activeLoading;

  function activityLabel(row: TaskActivityRow) {
    if (row.status !== "running" && row.status !== "thinking" && !failedTaskIds.has(row.conversationId) && row.unread && taskNotices.some(item => item.conversationId === row.conversationId && item.outcome === "reply")) return "有新回复";
    return ({ running: "本机执行中", thinking: "准备回复中", failed: "需要看一下", completed: "已完成", cancelled: "已停止", recent: row.unread ? "有新回复" : "继续聊" })[row.status];
  }

  async function openActivity(row: TaskActivityRow) {
    const task = row.taskId && executionTasks.find(item => item.id === row.taskId);
    const hasNewReply = taskNotices.some(item => item.conversationId === row.conversationId && item.outcome === "reply");
    if (task && row.status !== "thinking" && !failedTaskIds.has(row.conversationId) && (row.status === "running" || !hasNewReply)) await openExecution(task);
    else {
      const conversation = conversations.find(item => item.id === row.conversationId);
      if (conversation) await openConversation(conversation);
    }
  }

  async function openReceipt(receipt: TaskNotice) {
    const task = receipt.taskId && executionTasks.find(item => item.id === receipt.taskId);
    if (task) await openExecution(task);
    else {
      const conversation = conversations.find(item => item.id === receipt.conversationId);
      if (conversation) await openConversation(conversation);
    }
  }

  function renderActivityRow(row: TaskActivityRow) {
    return <div className="attention-task-row" key={row.conversationId}>
      <button type="button" onClick={() => openActivity(row)}>
        <span className={`task-indicator ${row.status}`} aria-hidden="true">{row.status === "completed" ? <Check size={10} /> : null}</span>
        <span><strong>{row.title}</strong><small>{activityLabel(row)}</small></span>
        {row.unread ? <span className="unread-point" aria-label="未读更新" /> : <ChevronRight size={12} />}
      </button>
    </div>;
  }

  return (
    <main className={`app-shell one-shell one-studio attention-workspace ${studioIdle ? "studio-idle" : "studio-open"} ${focusedTask && view === "chat" && !studioIdle ? "studio-focused" : ""} ${activeExecutionMode ? "execution-shell" : ""}`}>
      <header className="one-chrome">
        <button className="one-brand-button" type="button" onClick={startNewChat} title="回到 ONE">
          <OneWordmark inverse />
        </button>
        <nav className="studio-navigation" aria-label="工作区导航">
          <button type="button" aria-current={view === "chat" ? "page" : undefined} onClick={() => openSurface("chat")}>工作台</button>
          <button type="button" aria-current={view === "knowledge" ? "page" : undefined} onClick={() => openSurface("knowledge")}>知识</button>
          <button type="button" aria-current={view === "account" ? "page" : undefined} onClick={() => openSurface("account")}>设置</button>
          {user.role === "admin" ? <button type="button" aria-current={view === "admin" ? "page" : undefined} onClick={() => openSurface("admin")}>管理</button> : null}
        </nav>
        <div className="one-chrome-actions">
          <button className="one-chrome-button knowledge" type="button" title="知识来源" onClick={() => openSurface("knowledge")}>
            <span className={`connection-dot ${[knowledgeConnection, notionConnection, yinxiangConnection, flowusConnection].some(item => item.status === "connected") ? "connected" : "disconnected"}`} />
            <span>{[knowledgeConnection, notionConnection, yinxiangConnection, flowusConnection].some(item => item.status === "connected") ? "知识已连接" : "连接知识"}</span>
          </button>
          <button className={`one-chrome-button icon-only ${historyOpen ? "active" : ""}`} type="button" title="最近任务" onClick={() => setHistoryOpen((open) => !open)}>
            <Archive size={16} />
          </button>
          <button className="one-user-button" type="button" title="账号" onClick={() => openSurface("account")}>
            {(profile.displayName || user.username).slice(0, 1).toUpperCase()}
          </button>
        </div>
      </header>

      {runtimeUpdate?.available ? <section className={`one-runtime-update ${runtimeUpdate.progress?.status || "available"}`} aria-live="polite">
        <span className="one-runtime-update-icon"><Download size={16} /></span>
        <span><strong>{runtimeUpdating ? "正在更新 ONE" : runtimeUpdateFailed ? "更新没有完成" : "ONE 可以更新"}</strong><small>{runtimeUpdating ? ({ requested: "准备下载…", downloading: "正在下载…", verifying: "正在验证…", installing: "正在安装…", completed: "正在重新连接…", failed: runtimeUpdate.progress?.message || "更新失败" }[runtimeUpdate.progress?.status || "requested"]) : runtimeUpdateFailed ? runtimeUpdate.progress?.message || "请保持 ONE Key 插入并重试" : `${runtimeUpdate.current?.version || "当前版本"} → ${runtimeUpdate.latestVersion}`}</small></span>
        <button type="button" disabled={runtimeUpdating} onClick={() => void installRuntimeUpdate()}>{runtimeUpdating ? "请稍候" : runtimeUpdateFailed ? "重试" : "更新"}</button>
      </section> : null}

      {historyOpen ? (
        <>
          <button className="one-popover-scrim" aria-label="关闭最近任务" onClick={() => setHistoryOpen(false)} />
          <section className="one-history-popover">
            <div className="one-popover-heading">
              <div><small>YOUR FLOW</small><h3>{showArchived ? "已归档" : "最近任务"}</h3></div>
              <button type="button" onClick={startNewChat}><Plus size={16} />新任务</button>
            </div>
            <div className="one-popover-list">
              {visibleConversations.length ? visibleConversations.map((conversation) => (
                <div className={`one-history-row ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
                  <button type="button" onClick={() => openConversation(conversation)}>
                    <span>{conversation.title}</span>
                    <small>{dateTime(conversation.updatedAt)}</small>
                  </button>
                  <button type="button" title={conversation.archived ? "取消归档" : "归档"} disabled={conversation.id.startsWith("tmp_") || Boolean(loadingByConversation[conversation.id]) || runningExecutions.some(task => task.conversationId === conversation.id)} onClick={() => archiveConversation(conversation)}><Archive size={14} /></button>
                </div>
              )) : <div className="one-popover-empty">问我一件事。</div>}
            </div>
            {hasMoreConversations ? <button className="one-load-more" type="button" disabled={loadingMoreConversations} onClick={loadMoreConversations}>{loadingMoreConversations ? "加载中…" : "加载更多"}</button> : null}
            <footer className="one-popover-footer">
              <button type="button" onClick={() => setShowArchived(!showArchived)}>{showArchived ? "返回最近任务" : "查看归档"}</button>
              <button type="button" onClick={onLogout}><LogOut size={14} />退出</button>
            </footer>
          </section>
        </>
      ) : null}

      <div className="studio-layout">
      <section className="studio-surface" aria-label={view === "chat" ? "当前事情" : "工作区内容"} hidden={studioIdle}>
      {view === "admin" && user.role === "admin" ? (
        <AdminPanel actorId={user.id} refreshModels={refresh} onOpenSidebar={() => setHistoryOpen(true)} />
      ) : view === "knowledge" ? (
        <KnowledgePage
          onOpenSidebar={() => setHistoryOpen(true)}
          onConnectionChange={(next) => next.provider === "notion" ? setNotionConnection(next) : next.provider === "yinxiang" ? setYinxiangConnection(next) : next.provider === "flowus" ? setFlowusConnection(next) : setKnowledgeConnection(next)}
        />
      ) : view === "account" ? (
        <AccountPage user={user} profile={profile} onSaveProfile={saveProfile} models={models} defaultModelId={defaultModelId} onModelChange={refresh} onOpenSidebar={() => setHistoryOpen(true)} />
      ) : (
      <section className="studio-task" key={activeId}>
        <header className="studio-task-header">
          <div><div className={`task-current-state ${currentBusy ? "is-active" : ""}`}><span className={`task-indicator ${currentBusy ? "running" : executionTask?.status || "recent"}`} aria-hidden="true" />{currentStatus}</div><h1>{active?.title || "从一个念头开始"}</h1></div>
          <div className="studio-task-controls">
            {executionShortcut ? <button type="button" onClick={() => { setSelectedExecutionId(executionShortcut.id); setExpandedExecutionId(executionShortcut.id); setRevealExecutionId(executionShortcut.id); void loadLatestExecution(activeId, executionShortcut.id); }} aria-label="查看本机执行"><Zap size={14} /><span>{currentRunningExecution ? "执行中" : "执行"}</span></button> : null}
            <button type="button" aria-label={focusedTask ? "还原布局" : "放大当前事情"} aria-pressed={focusedTask} onClick={() => transitionInterface(() => setFocusedTask(value => !value))}>{focusedTask ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          </div>
        </header>
        <div className="messages">
          {latestTurnStart > 0 ? <button className="conversation-fold-toggle" type="button" aria-expanded={showEarlier} onClick={() => setExpandedConversationId(showEarlier ? "" : activeId)}><ChevronDown size={13} /><span>{showEarlier ? "收起之前的对话" : `之前的对话 · ${latestTurnStart} 条`}</span></button> : null}
          {(active?.messages ?? []).length ? (
            active!.messages.map((message, index) => (
              <React.Fragment key={`${message.createdAt}-${index}`}>
                <article hidden={!showEarlier && index < latestTurnStart} className={`message ${message.role} ${message.id && message.id === (executionTask?.sourceMessageId || executionSourceMessageId) && activeExecutionMode ? "execution-source" : ""}`}>
                  <div className="bubble">
                    <div className="studio-message-author">{message.role === "assistant" ? "ONE" : "你"}</div>
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
                            <button className={`execution-trigger ${index === active.messages.length - 1 && !executionTask ? "execution-primary-action" : ""}`} title={taskStatusUnavailable ? "正在确认本机状态" : executionBusy ? "本机正在工作，完成后可执行下一件" : "交给 ONE 执行"} disabled={taskStatusUnavailable || preparingExecution || executionBusy || activeLoading || active.id.startsWith("tmp_")} onClick={(event) => executeFromMessage(message, event.currentTarget)}>
                              <Zap size={14} />{index === active.messages.length - 1 && !executionTask ? <span>交给 ONE 执行</span> : null}
                            </button>
                          ) : null}
                        </div>
                        <MessageSources message={message} />
                        {message.id && active && !active.id.startsWith("tmp_") ? <BetaFeedbackControls key={message.id} messageId={message.id} requestId={message.requestId} onSave={async input => (await api<{ feedback: import("./Onboarding").OwnBetaFeedback }>("/api/me/feedback", { method: "POST", body: JSON.stringify(input) })).feedback} /> : null}
                      </>
                    ) : (
                      <>
                        <pre>{message.content}</pre>
                        {active && message.id ? (
                          <div className="message-actions user-actions">
                            <button className="execution-trigger" title={taskStatusUnavailable ? "正在确认本机状态" : executionBusy ? "本机正在工作，完成后可执行下一件" : "交给 ONE 执行"} disabled={taskStatusUnavailable || preparingExecution || executionBusy || activeLoading || active.id.startsWith("tmp_")} onClick={(event) => executeFromMessage(message, event.currentTarget)}><Zap size={14} /></button>
                          </div>
                        ) : null}
                      </>
                    )}
                    {message.imageUrl ? <img className="generated-image" src={message.imageUrl} alt={message.content} /> : null}
                    <small className="message-time">{dateTime(message.createdAt)}</small>
                  </div>
                </article>
              </React.Fragment>
            ))
          ) : <div className="studio-empty">{activeLoading ? "正在打开…" : failedTaskIds.has(activeId) ? "发送失败，草稿已保留。" : "发一条消息。"}</div>}
          {activePreparing || executionTask ? <ExecutionDisclosure key={executionTask?.id || "preparing"} task={executionTask} events={executionEvents} preparing={activePreparing} expanded={Boolean(executionTask && expandedExecutionId === executionTask.id)} onToggle={() => setExpandedExecutionId(expandedExecutionId === executionTask?.id ? "" : executionTask?.id || "")} onStop={source => cancelExecution(source)} /> : null}
        </div>
      </section>
      )}
      </section>

      <aside className={`studio-assistant ${activityExpanded ? "activity-is-open" : ""}`} aria-label="ONE 助手">
        {view === "chat" && !profile.onboarding.completedAt ? <Onboarding profile={profile} knowledgeConnected={[knowledgeConnection, notionConnection, yinxiangConnection, flowusConnection].some(item => item.status === "connected")} onSave={saveProfile} onOpenKnowledge={() => openSurface("knowledge")} onStartQuestion={suggestion => { setContent(suggestion); setComposeNew(true); setView("chat"); }} /> : null}
        <div className="studio-presence">
          <OneHeroEye mood={heroMood} />
          <div className="studio-presence-copy"><span className="studio-eyebrow">ONE IS WITH YOU</span>
          <h2>{activeAgent?.name || (studioIdle ? `${profile.displayName ? `${profile.displayName}，` : ""}我在。` : "我在。")}</h2></div>
        </div>
        {(thinkingConversations.length > 0 || executionBusy || preparingExecution) ? <div className="studio-wait" aria-live="off"><p>正在想…</p></div> : null}

        {otherRows.length > 0 || unreadNotices.length > 0 || taskStatusUnavailable ? <section className="studio-activity attention-activity" aria-label="任务动态">
          {otherRows.length > 0 || unreadNotices.length > 0 ? <button className="attention-activity-toggle" type="button" aria-expanded={activityExpanded} aria-controls="attention-task-list" onClick={() => setActivityExpanded(value => !value)}>
            <span>{activeOthers.length ? <><span className="task-indicator running" aria-hidden="true" />另外 {activeOthers.length} 件正在进行</> : unreadNotices.length ? "有新的结果" : "其他事情"}</span>
            <span>{unreadNotices.length > 0 ? <b className="attention-unread-count">{unreadNotices.length} 条更新</b> : <small>{otherRows.length}</small>}<ChevronDown size={14} /></span>
          </button> : null}
          <div id="attention-task-list" className="attention-task-list" hidden={!activityExpanded || otherRows.length === 0}>
            {activeOthers.length > 0 ? <section><h3>进行中</h3>{activeOthers.map(renderActivityRow)}</section> : null}
            {settledOthers.length > 0 ? <section><h3>{settledOthers.some(row => row.unread) ? "结果与最近" : "最近"}</h3>{settledOthers.slice(0, 5).map(renderActivityRow)}</section> : null}
            {otherRows.length === 0 ? <p className="attention-empty">当前没有其他事情。</p> : null}
            <button className="attention-all-tasks" type="button" onClick={() => setHistoryOpen(true)}>查看全部记录 <ArrowUpRight size={12} /></button>
          </div>
          {taskStatusUnavailable ? <button className="studio-status-retry" type="button" onClick={refreshExecutionTasks}>进度暂未连接 · 重试</button> : null}
        </section> : null}

        <div className="attention-receipt-slot" aria-live="polite" aria-atomic="true">
          {visibleReceipt ? <div className={`attention-receipt ${visibleReceipt.outcome}`} key={visibleReceipt.id}>
            {visibleReceipt.outcome === "failed" ? <span aria-hidden="true">!</span> : visibleReceipt.outcome === "cancelled" ? <Square size={10} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}<button type="button" onClick={() => openReceipt(visibleReceipt)} title={visibleReceipt.title}><span>{visibleReceipt.outcome === "reply" ? "回复好了" : visibleReceipt.outcome === "completed" ? "做好了" : visibleReceipt.outcome === "failed" ? "需要看一下" : "已停止"}</span><strong>{visibleReceipt.title}</strong></button>
            <button type="button" aria-label="收起这条提醒" onClick={() => acknowledgeConversation(visibleReceipt.conversationId)}><X size={12} /></button>
          </div> : null}
        </div>

        <form className="composer studio-composer" onSubmit={send}>
          {!models.length ? <div className="chat-error"><span>模型未就绪，请联系管理员。</span><button type="button" onClick={() => void refresh()}>重试</button></div> : null}
          {pendingRequests.length ? <details className="one-pending-answers"><summary>有 {pendingRequests.length} 条消息待确认 · 查看原结果，不重复扣费</summary>{pendingRequests.map(item => <button type="button" key={item.operationId} onClick={() => void recoverAnswer(item.operationId)}>查看 {dateTime(item.createdAt)} 的结果</button>)}</details> : null}
          {!studioIdle ? <div className="studio-compose-context">
            <span title={composerTarget}>{composeMode === "execution" ? "继续执行" : composeNew || !active ? "新事情" : "继续聊"}{active && !composeNew ? ` · ${active.title}` : ""}</span>
            {active && composeNew ? <button type="button" onClick={() => { switchDraft(active.id); setComposeNew(false); }}>回到这件事</button> : active ? <button type="button" onClick={beginNewTask}><Plus size={12} />新事情</button> : null}
          </div> : null}
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
          {pendingAttachments.length ? (
            <div className="composer-attachments">
              <AttachmentList attachments={pendingAttachments} removable onRemove={removePendingAttachment} />
            </div>
          ) : null}
          <div className="composer-row">
            <textarea
              id="one-studio-input"
              aria-label="给 ONE 发消息"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              placeholder={composeMode === "execution" ? "补充要求" : currentModel?.kind === "image" ? "描述你想怎么改" : "告诉我，你想做什么"}
              rows={3}
            />
            <button id="one-studio-send" className="primary send" type="submit" aria-label={composeMode === "execution" ? "发送并继续执行" : "发送消息"} title={targetLoading ? "这件事正在回复，可以新开一件事" : "发送消息"} disabled={uploadingAttachments || (composeMode === "execution" ? taskStatusUnavailable || preparingExecution || executionBusy || !content.trim() || pendingAttachments.length > 0 : !activeModelId || targetLoading || (!content.trim() && !pendingAttachments.length))}>
              {composeMode === "execution" ? <Zap size={18} /> : <ArrowUp size={19} />}
            </button>
          </div>
          <div className="studio-compose-tools">
            {canAttach && capabilities.attachments.enabled && composeMode === "chat" ? <label className="studio-attach" title="添加文件或图片"><Paperclip size={15} /><span>{uploadingAttachments ? "上传中" : "附件"}</span><input aria-label="添加附件" type="file" multiple accept={attachmentAccept} disabled={uploadingAttachments} onChange={event => { void uploadAttachments(event.target.files); event.target.value = ""; }} /></label> : <span />}
            <span className="studio-keyboard-hint">Enter 发送 · ⇧ Enter 换行</span>
          </div>
          <div className="studio-composer-status">
            {active && !composeNew && executionTask && !isExecutionRunning(executionTask) ? <button type="button" className="studio-mode-switch" onClick={() => setComposeMode(mode => mode === "chat" ? "execution" : "chat")}>{composeMode === "execution" ? "切回对话" : "切换到执行"}</button> : executionBusy && composeMode === "chat" ? <p className="studio-context-hint">本机任务仍在执行。</p> : null}
          </div>
        </form>
          {studioIdle ? (
            <div className="studio-suggestions">
              <span>试试这些</span>
              <button type="button" onClick={() => setContent("帮我回想最近反复提到的重要想法")}><span>我最近在反复想什么？</span><i aria-hidden="true">↗</i></button>
              <button type="button" onClick={() => setContent("结合我的知识，把现在最重要的事情整理成一个行动方案")}><span>把一个想法变成行动</span><i aria-hidden="true">↗</i></button>
              <button type="button" onClick={() => setContent("从我的个人知识中，找出现在最值得重新关注的内容")}><span>找找被我忘掉的好东西</span><i aria-hidden="true">↗</i></button>
            </div>
          ) : null}
        <footer className="studio-assistant-footer"><span className={`connection-dot ${[knowledgeConnection, notionConnection, yinxiangConnection, flowusConnection].some(item => item.status === "connected") ? "connected" : "disconnected"}`} /><button type="button" onClick={() => openSurface("knowledge")}>{[knowledgeConnection, notionConnection, yinxiangConnection, flowusConnection].some(item => item.status === "connected") ? "知识已连接" : "连接知识"}</button></footer>
      </aside>
      </div>
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
  const api = useContext(PrivateApiContext);
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
        <div><h2>智能体</h2></div>
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
                <span>所有用户可见 · 自动生成分享链接</span>
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
  const api = useContext(PrivateApiContext);
  const chatModels = models.filter((model) => model.kind === "chat");
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
      <div><h2>{agent ? "编辑智能体" : "创建智能体"}</h2></div>
      <div className="workbench-actions"><button className="secondary" type="button" onClick={onCancel}>取消</button><button className="primary" type="submit" form="agent-config" disabled={saving || !draft.name.trim() || !draft.description.trim() || !draft.modelId}><Save size={16} />{saving ? "保存中" : "保存智能体"}</button></div>
    </header>
    <div className="agent-workbench-body">
      <form id="agent-config" className="agent-config" onSubmit={save}>
        <section><h3>基本信息</h3><div className="agent-identity-preview"><span style={{ background: draft.color }}>{draft.avatar}</span><div><strong>{draft.name || "未命名智能体"}</strong><small>{draft.group || "未分组"}</small></div></div>
          <label>名称<input maxLength={40} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：详情页策划助手" /></label>
          <label>描述<textarea maxLength={220} rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="一句话说明用途" /></label>
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
          </div>
          <label>固定模型<select value={draft.modelId} onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}><option value="">请选择聊天模型</option>{chatModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select><small>保存后，使用者无法更改此智能体的模型</small></label>
        </section>
        <section><h3>外观</h3><div className="appearance-options"><div>{emojis.map((emoji) => <button type="button" key={emoji} className={draft.avatar === emoji ? "active" : ""} onClick={() => setDraft({ ...draft, avatar: emoji })}>{emoji}</button>)}</div><div>{colors.map((color) => <button type="button" aria-label={color} key={color} className={draft.color === color ? "active" : ""} style={{ background: color }} onClick={() => setDraft({ ...draft, color })} />)}</div></div></section>
        <section><h3>指令</h3><label>系统提示词<textarea rows={10} maxLength={6000} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder="角色、流程、边界、输出格式" /><small>{draft.prompt.length} / 6000</small></label></section>
        <fieldset className="agent-tool-settings"><legend>可用能力</legend><label><input type="checkbox" checked={draft.allowFileUpload} onChange={(e) => setDraft({ ...draft, allowFileUpload: e.target.checked, allowImageInput: e.target.checked ? draft.allowImageInput : false })} /><span><Paperclip size={16} />文件上传</span></label><label><input type="checkbox" checked={draft.allowImageInput} disabled={!draft.allowFileUpload} onChange={(e) => setDraft({ ...draft, allowImageInput: e.target.checked })} /><span><Image size={16} />图片理解</span></label><label><input type="checkbox" checked={draft.allowWebSearch} onChange={(e) => setDraft({ ...draft, allowWebSearch: e.target.checked })} /><span><Globe2 size={16} />联网搜索</span></label></fieldset>
        {error ? <div className="error">{error}</div> : null}
      </form>
      <section className="agent-debug"><header><div><strong>预览与调试</strong><small>{chatModels.find((model) => model.id === draft.modelId)?.name || "尚未选择模型"}</small></div><button className="secondary" onClick={() => setDebugMessages([])}>清空</button></header><div className="debug-messages">{debugMessages.length ? debugMessages.map((message, index) => <div key={index} className={`debug-message ${message.role}`}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>) : <div className="debug-empty"><span style={{ background: draft.color }}>{draft.avatar}</span><h3>{draft.name || "你的智能体"}</h3><p>{draft.description || "发一条消息测试"}</p></div>}{debugging ? <div className="typing">正在生成测试回答…</div> : null}</div><form className="debug-composer" onSubmit={debug}><textarea rows={2} value={debugInput} onChange={(e) => setDebugInput(e.target.value)} placeholder="输入一条测试消息" /><button className="primary send" disabled={!debugInput.trim() || !draft.modelId || debugging}><Send size={17} /></button></form></section>
    </div>
  </section>;
}

function AccountPage({ user, profile, onSaveProfile, models, defaultModelId, onModelChange, onOpenSidebar }: { user: User; profile: AccountProfile; onSaveProfile: (patch: ProfilePatch) => Promise<unknown>; models: Model[]; defaultModelId: string; onModelChange: () => Promise<void>; onOpenSidebar: () => void }) {
  const api = useContext(PrivateApiContext);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [billing, setBilling] = useState<{ balanceMicros: number; reservedMicros?: number; availableMicros?: number; ledger: PowerLedgerEntry[]; orders: RechargeOrder[]; usage: UsageRecord[]; rechargeCnyPerPower: number } | null>(null);
  const [selectedModelId, setSelectedModelId] = useState(defaultModelId);

  async function loadBilling() { setBilling(await api("/api/me/billing")); }
  useEffect(() => { loadBilling().catch((error) => setNotice(error.message)); }, []);
  useEffect(() => { setSelectedModelId(defaultModelId); }, [defaultModelId]);

  async function chooseModel(modelId: string) {
    setSelectedModelId(modelId); setNotice("");
    try { await api("/api/me/model", { method: "PATCH", body: JSON.stringify({ modelId }) }); await onModelChange(); setNotice("默认模型已更新"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "模型更新失败"); }
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
          <p>{profile.displayName || user.username} · {user.role === "admin" ? "管理员" : "ONE 用户"}</p>
        </div>
      </header>
      <div className="account-body">
        <section className="account-panel"><ProfileNameEditor profile={profile} onSave={onSaveProfile} /></section>
        <section className="account-panel account-balance-card">
          <div className="account-panel-title"><Wallet size={18} /><h3>我的电力</h3></div>
          <strong className="power-balance">{power(billing?.balanceMicros)} <small>电力</small></strong>
          {billing?.reservedMicros ? <p className="hint">预占 {power(billing.reservedMicros, 6)}，可用 {power(billing.availableMicros, 6)}；待核对调用请联系管理员。</p> : null}
          <PaymentPanel api={api} rate={billing?.rechargeCnyPerPower || 0} onPaid={loadBilling} />
        </section>
        <section className="account-panel">
          <div className="account-panel-title"><Bot size={18} /><h3>默认模型</h3></div>
          <select value={selectedModelId} onChange={(event) => chooseModel(event.target.value)}>{models.filter((model) => model.kind === "chat").map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
        </section>
        {user.role === "admin" ? <form className="account-panel" onSubmit={changePassword}>
          <div className="account-panel-title"><LockKeyhole size={18} /><h3>修改密码</h3></div>
          <label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <label>新密码<input type="password" autoComplete="new-password" placeholder="至少 8 个字符" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label>确认新密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
          <button className="primary" type="submit" disabled={!currentPassword || newPassword.length < 8 || !confirmPassword}>更新密码</button>
        </form> : null}
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
  onConnectionChange?: (connection: KnowledgeConnection) => void;
}) {
  const api = useContext(PrivateApiContext);
  const [connection, setConnection] = useState<KnowledgeConnection>({ provider: "getnote", status: "disconnected" });
  const [remoteConnections, setRemoteConnections] = useState<Record<"notion" | "yinxiang" | "flowus", KnowledgeConnection>>({
    notion: { provider: "notion", status: "disconnected" }, yinxiang: { provider: "yinxiang", status: "disconnected" }, flowus: { provider: "flowus", status: "disconnected" }
  });
  const [configured, setConfigured] = useState(false);
  const [remoteConfigured, setRemoteConfigured] = useState<Record<"notion" | "yinxiang" | "flowus", boolean>>({ notion: false, yinxiang: false, flowus: false });
  const [remoteBusy, setRemoteBusy] = useState<"notion" | "yinxiang" | "flowus" | "">("");
  const [testConnectAvailable, setTestConnectAvailable] = useState(false);
  const [flow, setFlow] = useState<GetNoteDeviceFlow | null>(null);
  const [polling, setPolling] = useState(false);
  const [notice, setNotice] = useState("");

  async function load() {
    const providers = ["notion", "yinxiang", "flowus"] as const;
    const [getNoteResult, ...remoteResults] = await Promise.allSettled([
      api<{ connection: KnowledgeConnection; configured: boolean; testConnectAvailable?: boolean }>("/api/knowledge/connections/getnote"),
      ...providers.map(provider => api<{ connection: KnowledgeConnection; configured: boolean }>(`/api/knowledge/connections/${provider}`))
    ]);
    if (getNoteResult.status === "fulfilled") {
      setConnection(getNoteResult.value.connection);
      setConfigured(getNoteResult.value.configured);
      setTestConnectAvailable(Boolean(getNoteResult.value.testConnectAvailable));
      onConnectionChange?.(getNoteResult.value.connection);
    } else {
      setConfigured(false);
    }
    const nextConnections = { ...remoteConnections };
    const nextConfigured = { ...remoteConfigured };
    providers.forEach((provider, index) => {
      const result = remoteResults[index];
      if (result.status === "fulfilled") { nextConnections[provider] = result.value.connection; nextConfigured[provider] = result.value.configured; onConnectionChange?.(result.value.connection); }
      else nextConfigured[provider] = false;
    });
    setRemoteConnections(nextConnections);
    setRemoteConfigured(nextConfigured);
    if (getNoteResult.status === "rejected") throw getNoteResult.reason;
  }

  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("notion");
    if (outcome) {
      setNotice(outcome === "connected" ? "Notion 已连接" : outcome === "cancelled" ? "Notion 授权已取消" : "Notion 授权未完成，请重试。");
      const url = new URL(window.location.href);
      url.searchParams.delete("notion");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    const params = new URLSearchParams(window.location.search);
    const provider = params.get("knowledge");
    const status = params.get("status");
    if ((provider === "yinxiang" || provider === "flowus") && status) {
      const label = provider === "yinxiang" ? "印象笔记" : "息流 FlowUs";
      setNotice(status === "connected" ? `${label} 已连接` : status === "cancelled" ? `${label} 授权已取消` : `${label} 授权未完成，请重试。`);
      const url = new URL(window.location.href); url.searchParams.delete("knowledge"); url.searchParams.delete("status"); window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    load().catch((err) => setNotice(err.message));
  }, []);

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
        const result = await api<{ status?: "pending"; phase?: "provider_retry" | "verifying"; retryAfterSeconds?: number; connection?: KnowledgeConnection }>(`/api/knowledge/connections/getnote/device-flow/${encodeURIComponent(flow!.flowId)}/poll`, { method: "POST" });
        if (cancelled) return;
        if (result.connection) {
          setConnection(result.connection);
          onConnectionChange?.(result.connection);
          setFlow(null);
          setPolling(false);
          setNotice("得到大脑已连接");
        } else {
          retries = 0;
          if (result.phase === "verifying") setNotice("正在确认知识权限…");
          else if (result.phase === "provider_retry") setNotice("连接不稳定，正在重试…");
          timer = window.setTimeout(poll, Math.max(delay, (result.retryAfterSeconds || 0) * 1000));
        }
      } catch (err) {
        if (cancelled) return;
        const action = getNotePollFailureAction(err);
        if (action === "retry_key") {
          setNotice("请插入 ONE Key。插入后会继续。");
          timer = window.setTimeout(poll, delay);
        } else if (action === "retry_provider") {
          setNotice("连接不稳定，正在重试…");
          timer = window.setTimeout(poll, Math.min(30000, delay * 2 ** ++retries));
        } else if (err instanceof ApiError && [400, 401, 403, 404, 410, 502, 503].includes(err.status || 0)) {
          setFlow(null); setPolling(false); setNotice(err.message);
        } else {
          setNotice("连接不稳定，正在重试…");
          timer = window.setTimeout(poll, Math.min(30000, delay * 2 ** ++retries));
        }
      }
    }
    timer = window.setTimeout(poll, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [flow, polling]);

  async function connect() {
    setNotice("");
    let authorizationWindow = null as ReturnType<typeof prepareGetNoteAuthorizationWindow>;
    if (!testConnectAvailable) {
      authorizationWindow = prepareGetNoteAuthorizationWindow((url, target) => window.open(url, target) as ReturnType<typeof prepareGetNoteAuthorizationWindow>);
    }
    try {
      if (testConnectAvailable) {
        const result = await api<{ connection: KnowledgeConnection }>("/api/knowledge/connections/getnote/test-connect", { method: "POST" });
        setConnection(result.connection);
        onConnectionChange?.(result.connection);
        setNotice("测试知识已连接");
        return;
      }
      const result = await api<GetNoteDeviceFlow>("/api/knowledge/connections/getnote/device-flow", { method: "POST" });
      setFlow(result);
      setPolling(true);
      if (authorizationWindow && !authorizationWindow.closed) authorizationWindow.location.replace(result.verificationUri);
      else setNotice("点击“打开得到大脑”完成授权。");
    } catch (err) {
      authorizationWindow?.close();
      setNotice(err instanceof Error ? err.message : "无法发起授权");
    }
  }

  async function disconnect() {
    if (!confirm("断开得到大脑？")) return;
    await api("/api/knowledge/connections/getnote", { method: "DELETE" });
    setFlow(null);
    setPolling(false);
    await load();
  }

  async function cancelGetNoteFlow() {
    const current = flow;
    setFlow(null);
    setPolling(false);
    setNotice("");
    if (!current) return;
    try {
      await api(`/api/knowledge/connections/getnote/device-flow/${encodeURIComponent(current.flowId)}`, { method: "DELETE" });
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "无法取消授权");
    }
  }

  async function connectRemote(provider: "notion" | "yinxiang" | "flowus") {
    setNotice("");
    setRemoteBusy(provider);
    try {
      const result = await api<{ authorizationUrl: string }>(`/api/knowledge/connections/${provider}/oauth/start`, { method: "POST" });
      window.location.assign(result.authorizationUrl);
    } catch (err) {
      setRemoteBusy("");
      setNotice(err instanceof Error ? err.message : "无法发起授权");
    }
  }

  async function disconnectRemote(provider: "notion" | "yinxiang" | "flowus", label: string) {
    if (!confirm(`断开 ${label}？`)) return;
    await api(`/api/knowledge/connections/${provider}`, { method: "DELETE" });
    await load();
    setNotice(`${label} 已断开`);
  }

  return (
    <section className="account-page">
      <header className="admin-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div><h2>知识来源</h2></div>
      </header>
      <div className="account-body">
        {notice ? <div className={`${/失败|无法|过期|不稳定|尚未配置|未完成|还没有会员|请联系/.test(notice) ? "error" : "notice"} account-wide-notice`} role="status">{notice}</div> : null}
        <section className="account-panel knowledge-panel">
          <div className="knowledge-provider-head">
            <div className="provider-icon"><Database size={19} /></div>
            <div><h3>得到大脑</h3></div>
            <span className={`provider-status ${connection.status}`}>{connection.status === "connected" ? "已连接" : connection.status === "pending" ? "授权中" : connection.status === "error" ? "需重连" : "未连接"}</span>
          </div>
          {connection.status === "connected" ? (
            <>
              <button className="danger" type="button" onClick={disconnect}>断开连接</button>
            </>
          ) : (
            <>
              {connection.status === "error" && connection.lastError ? <p className="error" role="alert">{connection.lastError}</p> : null}
              <p className="hint">请先开通得到大脑会员，再完成官方授权。</p>
              <button className="primary" type="button" disabled={!configured || Boolean(flow)} onClick={connect}>{testConnectAvailable ? "一键连接测试知识" : "连接得到大脑"}</button>
              {testConnectAvailable ? <div className="notice">测试连接 · 使用管理员预置账号</div> : null}
              {!configured ? <p className="hint">此知识连接暂未开通，请联系管理员。</p> : null}
              {flow ? (
                <div className="notice">
                  授权码：<strong>{flow.userCode}</strong>
                  <span>{Math.max(1, Math.ceil(flow.expiresIn / 60))} 分钟内完成</span>
                  <a href={flow.verificationUri} target="_blank" rel="noreferrer">打开得到大脑</a>
                  <button type="button" onClick={() => void cancelGetNoteFlow()}>取消</button>
                </div>
              ) : null}
            </>
          )}
        </section>
        {([
          { id: "notion", label: "Notion" }, { id: "yinxiang", label: "印象笔记" }, { id: "flowus", label: "息流 FlowUs" }
        ] as const).map(provider => {
          const item = remoteConnections[provider.id];
          return <section className="account-panel knowledge-panel" key={provider.id}>
            <div className="knowledge-provider-head"><div className="provider-icon"><FileText size={19} /></div><div><h3>{provider.label}</h3></div><span className={`provider-status ${item.status}`}>{item.status === "connected" ? "已连接" : item.status === "pending" ? "授权中" : item.status === "error" ? "需重连" : "未连接"}</span></div>
            {item.status === "connected" ? <><div className="notice">工作区：{item.providerSpaceName || provider.label}</div><p className="hint">只读：ONE 会按需搜索相关内容，不会修改或删除内容。</p><button className="danger" type="button" onClick={() => void disconnectRemote(provider.id, provider.label)}>断开连接</button></>
              : <><button className="primary" type="button" disabled={!remoteConfigured[provider.id] || Boolean(remoteBusy)} onClick={() => void connectRemote(provider.id)}>{remoteBusy === provider.id ? `正在打开 ${provider.label}…` : `连接 ${provider.label}`}</button>{!remoteConfigured[provider.id] ? <p className="hint">{provider.label} 连接暂未开通，请联系管理员。</p> : null}</>}
          </section>;
        })}
      </div>
    </section>
  );
}

function AdminPanel({ actorId, refreshModels, onOpenSidebar }: { actorId: string; refreshModels: () => Promise<void>; onOpenSidebar: () => void }) {
  const api = useContext(PrivateApiContext);
  const [tab, setTab] = useState<"overview" | "users" | "keys" | "models" | "billing" | "usage" | "contexts" | "logs">("overview");
  const [users, setUsers] = useState<User[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [devices, setDevices] = useState<OneKeyDevice[]>([]);
  const [contextTraces, setContextTraces] = useState<ContextTraceSummary[]>([]);
  const [operations, setOperations] = useState<{ health?: OperationsHealth; pendingOrders: RechargeOrder[]; usage: UsageRecord[]; userUsage: UserUsageSummary[]; ledger: PowerLedgerEntry[]; logs: AuditItem[]; settings: { rechargeCnyPerPower: number }; summary: { reviewCalls?: number; unknownCostCalls?: number; users: number; balanceMicros: number; chargedMicros: number; costMicros: number } } | null>(null);
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
          <div><h2>ONE 超管</h2></div>
        </header>
        <nav className="tabs">
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><ShieldCheck size={16} />总览</button>
          <button className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}><Users size={16} />账号</button>
          <button className={tab === "keys" ? "active" : ""} onClick={() => setTab("keys")}><Usb size={16} />ONE Key</button>
          <button className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}><Bot size={16} />模型</button>
          <button className={tab === "billing" ? "active" : ""} onClick={() => setTab("billing")}><Wallet size={16} />电力</button>
          <button className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}><ReceiptText size={16} />用户用量</button>
          <button className={tab === "contexts" ? "active" : ""} onClick={() => setTab("contexts")}><Eye size={16} />上下文</button>
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}><FileText size={16} />日志</button>
        </nav>
        {notice ? <div className="notice">{notice}</div> : null}
        <div className="admin-body">
          {tab === "overview" ? <AdminOverview operations={operations} /> : null}
          {tab === "users" ? <UsersTab users={users} reload={load} /> : null}
          {tab === "keys" ? <OneKeysTab users={users} devices={devices} reload={load} /> : null}
          {tab === "models" ? <ModelsTab models={models} reload={async () => { await load(); await refreshModels(); }} /> : null}
          {tab === "billing" ? <AdminBilling actorId={actorId} users={users} operations={operations} reload={load} /> : null}
          {tab === "usage" ? <AdminUsage summaries={operations?.userUsage || []} reload={load} /> : null}
          {tab === "contexts" ? <AdminContexts traces={contextTraces} /> : null}
          {tab === "logs" ? <AdminLogs logs={operations?.logs || []} /> : null}
        </div>
      </section>
  );
}

type OperationsHealth = { database: string; diskFreePercent?: number; localBackup: { status: string; lastSuccessAt?: string }; offsiteBackup: { status: string; lastSuccessAt?: string }; checkedAt: string };
function AdminOverview({ operations }: { operations: { health?: OperationsHealth; summary: { users: number; balanceMicros: number; chargedMicros: number; costMicros: number; reviewCalls?: number; unknownCostCalls?: number }; pendingOrders: RechargeOrder[] } | null }) {
  const summary = operations?.summary;
  const health = operations?.health;
  const backupLabel = (backup: OperationsHealth["localBackup"]) => backup.status === "ok" ? `已验证 · ${dateTime(backup.lastSuccessAt!)}` : backup.status === "stale" ? "超过 36 小时未成功，请检查" : "尚无新版验证记录，请先运行一次备份";
  return <div className="ops-dashboard">
    <section className="ops-metric"><small>USERS</small><strong>{summary?.users ?? 0}</strong><span>独立账户</span></section>
    <section className="ops-metric"><small>POWER</small><strong>{power(summary?.balanceMicros)}</strong><span>用户余额</span></section>
    <section className="ops-metric"><small>USAGE</small><strong>{power(summary?.chargedMicros)}</strong><span>累计消耗电力</span></section>
    <section className="ops-metric"><small>COST</small><strong>{power(summary?.costMicros)}</strong><span>按配置进价计算的已知成本{summary?.unknownCostCalls ? `（另 ${summary.unknownCostCalls} 次未确认）` : ""}</span></section>
    <section className="ops-panel span-all"><h3>待处理</h3><p>{operations?.pendingOrders.length || 0} 笔充值待入账 · {summary?.reviewCalls || 0} 笔用量待核对</p></section>
    {health ? <section className="ops-panel span-all"><h3>运行检查</h3><div className="mini-ledger"><div><span>数据库连通</span><b>{health.database === "ok" ? "正常" : "异常，请检查服务"}</b></div><div><span>磁盘可用空间</span><b>{health.diskFreePercent === undefined ? "未能读取" : `${health.diskFreePercent}%${health.diskFreePercent < 20 ? " · 空间不足预警" : ""}`}</b></div><div><span>数据库本地备份</span><b>{backupLabel(health.localBackup)}</b></div><div><span>异地上传验证</span><b>{backupLabel(health.offsiteBackup)}</b></div></div><p className="hint">检查于 {dateTime(health.checkedAt)} · 无主动告警 · 尚未验证恢复</p></section> : null}
  </div>;
}

function AdminBilling({ actorId, users, operations, reload }: { actorId: string; users: User[]; operations: { pendingOrders: RechargeOrder[]; ledger: PowerLedgerEntry[]; settings: { rechargeCnyPerPower: number } } | null; reload: () => Promise<void> }) {
  const api = useContext(PrivateApiContext);
  const batchPending = useRef<{ operationId: string; power: number; title: string } | null>(null);
  const batchBusy = useRef(false);
  const [userId, setUserId] = useState(users[0]?.id || ""); const [gift, setGift] = useState("10"); const [batchGift, setBatchGift] = useState("10"); const [batchTitle, setBatchTitle] = useState("内测统一赠送"); const [rate, setRate] = useState(String(operations?.settings.rechargeCnyPerPower || 7)); const [notice, setNotice] = useState("");
  useEffect(() => { if (!userId && users[0]) setUserId(users[0].id); }, [users]);
  async function give(event: FormEvent) { event.preventDefault(); try { await api(`/api/admin/users/${userId}/power`, { method: "POST", body: JSON.stringify({ power: Number(gift) }) }); setNotice("电力已到账"); await reload(); } catch (error) { setNotice(error instanceof Error ? error.message : "赠送失败"); } }
  async function giveBatch(event: FormEvent) {
    event.preventDefault(); if (batchBusy.current) return;
    const storageKey = `one-gift-pending:${actorId}`;
    try { batchPending.current ??= JSON.parse(localStorage.getItem(storageKey) || "null"); }
    catch { setNotice("无法读取原批次，请先核对赠送记录"); return; }
    if (!batchPending.current && (!Number.isFinite(Number(batchGift)) || Number(batchGift) <= 0 || Number(batchGift) > 1000000 || !Number.isSafeInteger(Number(batchGift) * 1e6))) {
      setNotice("请输入大于 0、不超过 1000000 的电力，最多 6 位小数"); return;
    }
    if (!batchPending.current && !confirm(`确认给全部启用成员（含管理员）各赠送 ${batchGift} 电力？`)) return;
    batchBusy.current = true;
    batchPending.current ??= { operationId: crypto.randomUUID(), power: Number(batchGift), title: batchTitle };
    try {
      localStorage.setItem(storageKey, JSON.stringify(batchPending.current));
      const result = await api<{ recipientCount: number; batchId: string }>("/api/admin/power/batch-gift", { method: "POST", body: JSON.stringify(batchPending.current) });
      localStorage.removeItem(storageKey);
      batchPending.current = null;
      setNotice(`已给 ${result.recipientCount} 位成员赠送电力 · ${result.batchId}`);
      await reload();
    } catch (error) { setNotice(`${error instanceof Error ? error.message : "赠送失败"}；再次点击将核对原批次，不会重复赠送`); }
    finally { batchBusy.current = false; }
  }
  async function saveRate(event: FormEvent) { event.preventDefault(); try { await api("/api/admin/settings/billing", { method: "PATCH", body: JSON.stringify({ rechargeCnyPerPower: Number(rate) }) }); setNotice("充值汇率已更新"); await reload(); } catch (error) { setNotice(error instanceof Error ? error.message : "保存失败"); } }
  async function approve(order: RechargeOrder) { await api(`/api/admin/recharge-orders/${order.id}/approve`, { method: "POST" }); setNotice("充值已入账"); await reload(); }
  return <div className="admin-grid">
    <GiftBatchHistory api={api} revision={notice} />
    <div className="admin-form-stack"><form className="admin-form" onSubmit={give}><h3><Wallet size={17} />赠送电力</h3><select value={userId} onChange={(event) => setUserId(event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.username} · {power(user.balanceMicros)} 电力</option>)}</select><input type="number" min="0.000001" step="0.000001" value={gift} onChange={(event) => setGift(event.target.value)} /><button className="primary">确认赠送</button></form><form className="admin-form" onSubmit={giveBatch}><h3>批量赠送</h3><label>每位启用成员赠送<input type="number" min="0.000001" step="0.000001" value={batchGift} onChange={(event) => setBatchGift(event.target.value)} /></label><label>批次说明<input value={batchTitle} onChange={(event) => setBatchTitle(event.target.value)} maxLength={80} /></label><button className="secondary">给全部启用成员赠送</button><small className="hint">管理员也包含在启用成员内；每位成员都会留下独立电力账本记录。</small></form><form className="admin-form" onSubmit={saveRate}><h3>充值汇率</h3><label>1 电力 = 人民币<input type="number" min="0.01" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} /></label><button className="secondary">保存汇率</button></form>{notice ? <div className="notice">{notice}</div> : null}</div>
    <div className="table"><h3>待入账充值</h3>{operations?.pendingOrders.length ? operations.pendingOrders.map((order) => <div className="table-row" key={order.id}><span>{order.username}<small>{dateTime(order.createdAt)}</small></span><span>{power(order.requestedMicros)} 电力 · ¥{order.amountCny.toFixed(2)}</span><button className="primary" onClick={() => approve(order)}>确认入账</button></div>) : <div className="empty-state compact">暂无待处理充值</div>}</div>
  </div>;
}

function usageActionLabel(action: string) {
  const labels: Record<string, string> = {
    "auth.key.login": "通过 ONE Key 登录", "execution.completed": "完成本机执行", "execution.failed": "本机执行失败", "execution.cancelled": "停止本机执行", "auth.login.succeeded": "登录 ONE", "auth.one_key.login": "通过 ONE Key 登录", "one_key.login.succeeded": "通过 ONE Key 登录",
    "user.model.selected": "切换模型", "chat.completed": "完成问答", "chat.failed": "问答失败", "knowledge.recall.failed": "知识召回失败",
    "knowledge.recall.succeeded": "知识召回完成", "recharge.requested": "申请充值", "execution.codex.created": "创建本机执行任务",
    "execution.local_agent.created": "创建 Local Agent 任务", "attachment.uploaded": "上传附件",
    "admin.one_key.provisioned": "初始化 ONE Key", "admin.one_key.revoked": "挂失 ONE Key", "admin.user.created": "开通账号",
    "admin.user.updated": "更新账号", "admin.power.gifted": "赠送电力", "admin.power.batch_gifted": "批量赠送电力", "admin.recharge.approved": "确认充值入账",
    "admin.billing.rate.updated": "更新充值汇率", "admin.model.created": "添加模型", "admin.model.updated": "更新模型配置"
  };
  return labels[action] || "其他活动";
}

function usageActivityLabel(activity?: UsageRecord["activity"]) {
  return activity === "execution_compile" ? "整理执行指令" : activity === "local_agent" ? "本机执行" : "AI 问答";
}

function usageStatusLabel(usage: UsageRecord) {
  if (usage.status === "waived") return "已免扣";
  if (usage.status === "failed") return "调用失败 · 未扣费";
  if (usage.status === "pending") return "进行中";
  if (usage.status === "needs_review" || usage.source === "unknown") return "用量待核对";
  return usage.source === "estimated" ? "历史估算用量" : "已结算";
}

function UsageReconcileForm({ userId, usage, onResolved }: { userId: string; usage: UsageRecord; onResolved: () => void }) {
  const api = useContext(PrivateApiContext);
  const [inputTokens, setInputTokens] = useState("");
  const [outputTokens, setOutputTokens] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function resolve(action: "waive" | "provider_usage") {
    if (!confirm(action === "waive" ? "确认不向该用户扣费并释放这次预占电力？此操作会留下核对记录。" : "确认输入的是中转站实际返回的 Token 用量？将按本次调用的价格结算。")) return;
    setBusy(true); setError("");
    try {
      await api(`/api/admin/users/${encodeURIComponent(userId)}/usage/${encodeURIComponent(usage.id)}/resolve`, { method: "POST", body: JSON.stringify(action === "waive" ? { action } : { action, inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) }) });
      onResolved();
    } catch (err) { setError(err instanceof Error ? err.message : "核对失败"); }
    finally { setBusy(false); }
  }
  return <details className="usage-reconcile"><summary>核对这次调用</summary><p className="hint">按请求编号核对中转站账单。无法确认可暂存；免扣不代表上游免费。</p><div className="ops-list-toolbar"><label>实际输入 Token<input type="number" min="0" step="1" value={inputTokens} onChange={(event) => setInputTokens(event.target.value)} /></label><label>实际输出 Token<input type="number" min="0" step="1" value={outputTokens} onChange={(event) => setOutputTokens(event.target.value)} /></label><button className="primary" type="button" disabled={busy || inputTokens === "" || outputTokens === "" || !Number.isSafeInteger(Number(inputTokens)) || Number(inputTokens) < 0 || !Number.isSafeInteger(Number(outputTokens)) || Number(outputTokens) < 0} onClick={() => void resolve("provider_usage")}>按实际用量结算</button><button className="secondary" type="button" disabled={busy} onClick={() => void resolve("waive")}>免扣并释放预占</button></div>{error ? <div className="error">{error}</div> : null}</details>;
}

function AdminUsage({ summaries, reload }: { summaries: UserUsageSummary[]; reload: () => Promise<void> }) {
  const api = useContext(PrivateApiContext);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [detail, setDetail] = useState<UserUsageDetail | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [period, setPeriod] = useState("7d");
  const [offset, setOffset] = useState(0);
  const [activityLimit, setActivityLimit] = useState(20);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setDetail(null); setError(""); setActivityLimit(20);
    if (!selectedUserId) return;
    let active = true;
    const controller = new AbortController();
    const query = new URLSearchParams({ period, offset: String(offset), limit: "20" });
    api<UserUsageDetail>(`/api/admin/users/${encodeURIComponent(selectedUserId)}/usage?${query}`, { signal: controller.signal })
      .then((result) => { if (active && result.user.id === selectedUserId) setDetail(result); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "读取用户用量失败"); });
    return () => { active = false; controller.abort(); };
  }, [selectedUserId, period, offset, retry]);

  function toggleDetail(userId: string) {
    setDetail(null); setError(""); setOffset(0);
    setSelectedUserId(selectedUserId === userId ? "" : userId);
  }

  const visible = summaries.filter((item) => item.username.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) && (status === "all" || item.enabled === (status === "active")));
  if (!summaries.length) return <div className="empty-state compact">还没有内测用户</div>;
  return <div className="usage-user-list">
    <div className="ops-list-toolbar"><label>搜索用户<input type="search" placeholder="输入用户名" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>账号状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">正常账号</option><option value="archived">已停用 / 归档</option><option value="all">全部账号</option></select></label><span>{visible.length} 位用户 · 电力为计费单位</span></div>
    <p className="hint">点击用户查看明细 · 不展示聊天、知识或附件内容</p>
    {!visible.length ? <div className="empty-state compact">没有符合条件的用户</div> : null}
    {visible.map((item) => {
      const expanded = selectedUserId === item.userId;
      const currentDetail = detail?.user.id === item.userId ? detail : null;
      return <section className={`usage-user-card ${expanded ? "expanded" : ""}`} key={item.userId}>
        <button className="usage-user-summary" type="button" onClick={() => toggleDetail(item.userId)} aria-expanded={expanded} aria-controls={`usage-detail-${item.userId}`}>
          <span className="usage-user-name"><strong>{item.username}{item.role === "admin" ? " · 超管" : ""}</strong><small>{item.enabled ? `${item.activeKeyCount} 枚有效 Key` : "账号已停用"}{item.total.reviewCalls ? ` · ${item.total.reviewCalls} 笔待核对` : ""}</small></span>
          <span><small>今日消耗</small><strong>{power(item.today.chargedMicros, 4)}</strong><small>{item.today.calls} 次调用</small></span>
          <span><small>近 7 天消耗</small><strong>{power(item.sevenDays.chargedMicros, 4)}</strong><small>{item.sevenDays.calls} 次调用{item.activeDays7d !== undefined ? ` · 活跃 ${item.activeDays7d} 天` : ""}</small></span>
          <span><small>累计消耗 / 余额</small><strong>{power(item.total.chargedMicros, 4)} / {power(item.balanceMicros, 4)}</strong>{item.reservedMicros ? <small>其中预占 {power(item.reservedMicros, 4)} 电力</small> : null}<small>{item.lastUsedAt ? `最近 ${dateTime(item.lastUsedAt)}` : "尚未使用"}</small></span>
          {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
        </button>
        {expanded ? <div className="usage-user-detail" id={`usage-detail-${item.userId}`}>
          <BetaUserInsights key={item.userId} userId={item.userId} api={api} />
          <div className="usage-detail-metrics">
            <span><small>累计输入 / 输出 Token</small><strong>{item.total.inputTokens.toLocaleString()} / {item.total.outputTokens.toLocaleString()}</strong></span>
            <span><small>累计消耗 / 上游成本（电力）</small><strong>{power(item.total.chargedMicros, 4)} / {power(item.total.costMicros, 4)}</strong>{item.total.unknownCostCalls ? <small>{item.total.unknownCostCalls} 次成本未确认，合计仅含已知成本</small> : null}</span>
            <span><small>已知计费差额（非现金利润）</small><strong>{item.total.unknownCostCalls ? "成本未齐，暂不计算" : power(item.total.chargedMicros - item.total.costMicros, 4)}</strong></span>
            <span><small>对话 / 知识召回 / 本机执行</small><strong>{item.conversationCount} / {item.knowledgeRecallCount} / {item.executionCount}</strong></span>
          </div>
          <div className="ops-list-toolbar"><label>明细时间范围<select value={period} onChange={(event) => { setDetail(null); setPeriod(event.target.value); setOffset(0); }}><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="all">全部时间</option></select></label><span>日志时间按本机时区显示</span></div>
          {error ? <div className="error">{error}<button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>重试</button></div> : !currentDetail ? <div className="empty-state compact" role="status">正在读取 {item.username} 的用量…</div> : <>
            <details className="usage-detail-section" open>
              <summary>逐次模型调用（共 {currentDetail.pagination.total} 次）</summary>
              {currentDetail.usage.length ? <div className="ops-table"><div className="ops-table-head"><span>用途 / 模型 / 状态</span><span>输入 / 输出 Token</span><span>消耗 / 上游成本（电力）</span><span>时间 / 耗时 / 请求</span></div>{currentDetail.usage.map((usage) => {
                const costUnknown = usage.costMicros === undefined;
                return <React.Fragment key={usage.id}><div className="ops-table-row"><span><strong>{usageActivityLabel(usage.activity)}</strong><small>{usage.modelName || "模型已移除"}</small><small className={costUnknown ? "usage-review-status" : ""}>{usageStatusLabel(usage)}</small></span><span>{usage.source === "fixed" ? "按次计费" : usage.source === "unknown" ? "待核对" : <>{usage.inputTokens.toLocaleString()} / {usage.outputTokens.toLocaleString()}</>}</span><span>{power(usage.chargedMicros, 6)} / {costUnknown ? "待核对" : power(usage.costMicros, 6)}</span><span>{dateTime(usage.createdAt)}{usage.durationMs !== undefined ? <small>耗时 {(usage.durationMs / 1000).toFixed(1)} 秒</small> : null}<small>{usage.requestId || "-"}</small></span></div>{usage.status === "needs_review" ? <UsageReconcileForm userId={item.userId} usage={usage} onResolved={() => { setRetry((value) => value + 1); void reload(); }} /> : null}</React.Fragment>;
              })}</div> : <div className="empty-state compact">该时间范围内没有模型调用</div>}
              {currentDetail.pagination.total > currentDetail.pagination.limit ? <div className="ops-pagination"><button className="secondary" type="button" disabled={offset === 0} onClick={() => { setDetail(null); setOffset(Math.max(0, offset - 20)); }}><ChevronLeft size={14} />上一页</button><span>第 {Math.floor(offset / 20) + 1} / {Math.ceil(currentDetail.pagination.total / 20)} 页</span><button className="secondary" type="button" disabled={!currentDetail.pagination.hasMore} onClick={() => { setDetail(null); setOffset(offset + 20); }}>下一页<ChevronRight size={14} /></button></div> : null}
            </details>
            <details className="usage-detail-section">
              <summary>使用活动日志（共 {currentDetail.activityTotal} 条{currentDetail.activityTotal > currentDetail.activity.length ? `，最近 ${currentDetail.activity.length} 条可见` : ""}）</summary>
              {currentDetail.activity.length ? <div className="mini-ledger">{currentDetail.activity.slice(0, activityLimit).map((activity) => <div key={activity.id}><span><strong>{usageActionLabel(activity.action)}</strong><small>{activity.requestId || "无请求编号"}</small></span><b>{dateTime(activity.createdAt)}</b></div>)}</div> : <div className="empty-state compact">该时间范围内没有使用活动</div>}
              {currentDetail.activity.length > activityLimit ? <button className="secondary" type="button" onClick={() => setActivityLimit((value) => value + 20)}>再显示 20 条活动</button> : null}
            </details>
          </>}
        </div> : null}
      </section>;
    })}
  </div>;
}
function AdminContexts({ traces }: { traces: ContextTraceSummary[] }) {
  const api = useContext(PrivateApiContext);
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

  if (!traces.length) return <div className="empty-state compact"><Eye size={36} /><h2>还没有上下文记录</h2><p>完成一次问答后显示。</p></div>;
  return <div className="context-debugger">
    <aside className="context-trace-list">
      <div className="context-private-note"><LockKeyhole size={15} /><span>仅当前账号可见，其他用户和超管都不能读取。</span></div>
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
  const api = useContext(PrivateApiContext);
  const [userId, setUserId] = useState(users.find((user) => user.role === "user")?.id || users[0]?.id || "");
  const [serialNumber, setSerialNumber] = useState(`ONE-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-001`);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("active");
  const [limit, setLimit] = useState(20);
  const matching = devices.filter((device) => (status === "all" || device.status === status) && `${device.username} ${device.serialNumber}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  useEffect(() => setLimit(20), [search, status]);

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
      setNotice("凭证已下载，仅此一次。请放入 U 盘 .one 文件夹。");
      await reload();
    } catch (error) { setNotice(error instanceof Error ? error.message : "初始化失败"); }
  }

  async function revoke(device: OneKeyDevice) { if (!confirm(`确认挂失 ${device.serialNumber}？`)) return; await api(`/api/admin/one-keys/${device.id}/revoke`, { method: "POST" }); await reload(); }

  return <div className="admin-grid">
    <form className="admin-form" onSubmit={provision}><h3><Usb size={17} />初始化 ONE Key</h3><label>绑定用户<select value={userId} onChange={(event) => setUserId(event.target.value)}>{users.map((user) => <option key={user.id} value={user.id}>{user.username}</option>)}</select></label><label>设备序列号<input value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} /></label><p className="hint">私钥仅下载一次；服务端仅存公钥。普通 U 盘可复制，不等同安全芯片。</p><button className="primary" disabled={!userId || !serialNumber.trim()}>生成并下载凭证</button>{notice ? <div className="notice">{notice}</div> : null}</form>
    <div className="table"><div className="ops-list-toolbar"><label>搜索用户或序列号<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>Key 状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">正常使用</option><option value="revoked">已挂失 / 归档</option><option value="all">全部</option></select></label></div>{matching.slice(0, limit).map((device) => <div className="table-row" key={device.id}><span><strong>{device.serialNumber}</strong><small>{device.username} · {device.lastUsedAt ? `最近使用 ${dateTime(device.lastUsedAt)}` : "尚未使用"}</small></span><span>{device.status === "active" ? "正常" : "已挂失 / 归档"}</span>{device.status === "active" ? <button className="danger" onClick={() => revoke(device)}>挂失</button> : <span />}</div>)}{matching.length > limit ? <button type="button" className="secondary" onClick={() => setLimit((value) => value + 20)}>再显示 20 枚</button> : null}{!matching.length ? <p className="hint">没有符合条件的 Key</p> : null}</div>
  </div>;
}

function UsersTab({ users, reload }: { users: User[]; reload: () => Promise<void> }) {
  const api = useContext(PrivateApiContext);
  const [username, setUsername] = useState("");
  const [editing, setEditing] = useState<Record<string, { username: string; enabled: boolean }>>({});
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState("");

  async function createUser(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setCreateNotice("");
    try {
      await api("/api/admin/users", { method: "POST", body: JSON.stringify({ username, role: "user" }) });
      setUsername("");
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
        enabled: draft.enabled
      })
    });
    setEditing(({ [user.id]: _removed, ...rest }) => rest);
    await reload();
  }

  return (
    <div className="admin-grid">
      <div className="admin-form-stack">
        <form className="admin-form" onSubmit={createUser}>
          <h3><UserPlus size={17} />开通账号</h3>
          <input placeholder="用户名" value={username} onChange={(event) => setUsername(event.target.value)} />
          <p className="hint">普通用户仅凭已绑定的 ONE Key 登录。</p>
          {createNotice ? <div className={createNotice === "账号已开通" ? "notice import-notice" : "error import-notice"}>{createNotice}</div> : null}
          <button className="primary" type="submit" disabled={!username.trim() || creating}>
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
                <label className="inline-check"><input type="checkbox" checked={editing[user.id].enabled} onChange={(event) => setEditing({ ...editing, [user.id]: { ...editing[user.id], enabled: event.target.checked } })} />启用</label>
                <button className="secondary" onClick={() => saveUser(user)}><Save size={15} />保存</button>
              </>
            ) : (
              <>
                <span>{user.username}<small>{user.enabled ? "启用" : "停用"}</small></span>
                <span>{user.role === "admin" ? "管理员" : "普通用户"}</span>
                <button className="secondary" onClick={() => setEditing({ ...editing, [user.id]: { username: user.username, enabled: user.enabled } })}><Edit3 size={15} />编辑</button>
                <button className="secondary" onClick={() => toggle(user)}>{user.enabled ? "停用" : "启用"}</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ImageCallPricing({ price, cost, onChange }: { price: number; cost: number; onChange: (values: { imagePowerPerCall?: number; costImagePowerPerCall?: number }) => void }) {
  return <div className="price-fields"><label>图片售价<small>电力 / 次，必须大于 0</small><input type="number" min="0.000001" step="0.000001" value={price || ""} onChange={(event) => onChange({ imagePowerPerCall: Number(event.target.value) })} /></label><label>图片进价<small>电力 / 次，按上游报价配置</small><input type="number" min="0" step="0.000001" value={cost} onChange={(event) => onChange({ costImagePowerPerCall: Number(event.target.value) })} /></label><p className="hint">每次生成 1 张 · 按次结算 · 未配置售价时禁用</p></div>;
}

function ModelsTab({ models, reload }: { models: Model[]; reload: () => Promise<void> }) {
  const api = useContext(PrivateApiContext);
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
    imagePowerPerCall: 0,
    costImagePowerPerCall: 0,
    enabled: true,
    isDefault: false
  });
  const [editing, setEditing] = useState<Record<string, { name: string; kind: "chat" | "image"; protocol: "openai" | "anthropic"; baseUrl: string; model: string; apiKey: string; systemPrompt: string; inputPowerPerMillion: number; outputPowerPerMillion: number; costInputPowerPerMillion: number; costOutputPowerPerMillion: number; imagePowerPerCall: number; costImagePowerPerCall: number; enabled: boolean; isDefault: boolean }>>({});

  async function createModel(event: FormEvent) {
    event.preventDefault();
    await api("/api/admin/models", { method: "POST", body: JSON.stringify(form) });
    setForm({ name: "", kind: "chat", protocol: "openai", baseUrl: "https://app.yylx.io/v1", apiKey: "", model: "", systemPrompt: "", inputPowerPerMillion: 3, outputPowerPerMillion: 15, costInputPowerPerMillion: 2, costOutputPowerPerMillion: 10, imagePowerPerCall: 0, costImagePowerPerCall: 0, enabled: true, isDefault: false });
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
        {form.kind === "chat" ? (<div className="price-fields"><label>对外输入价<small>电力 / 百万 Token</small><input type="number" min="0" step="0.000001" value={form.inputPowerPerMillion} onChange={(event) => setForm({ ...form, inputPowerPerMillion: Number(event.target.value) })} /></label><label>对外输出价<small>电力 / 百万 Token</small><input type="number" min="0" step="0.000001" value={form.outputPowerPerMillion} onChange={(event) => setForm({ ...form, outputPowerPerMillion: Number(event.target.value) })} /></label><label>进价 · 输入<small>仅超管可见</small><input type="number" min="0" step="0.000001" value={form.costInputPowerPerMillion} onChange={(event) => setForm({ ...form, costInputPowerPerMillion: Number(event.target.value) })} /></label><label>进价 · 输出<small>仅超管可见</small><input type="number" min="0" step="0.000001" value={form.costOutputPowerPerMillion} onChange={(event) => setForm({ ...form, costOutputPowerPerMillion: Number(event.target.value) })} /></label></div>) : <ImageCallPricing price={form.imagePowerPerCall} cost={form.costImagePowerPerCall} onChange={(values) => setForm({ ...form, ...values })} />}
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
                {editing[model.id].kind === "chat" ? <>
                <label className="field-label">对外输入价<input type="number" min="0" step="0.000001" value={editing[model.id].inputPowerPerMillion} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], inputPowerPerMillion: Number(event.target.value) } })} /></label>
                <label className="field-label">对外输出价<input type="number" min="0" step="0.000001" value={editing[model.id].outputPowerPerMillion} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], outputPowerPerMillion: Number(event.target.value) } })} /></label>
                <label className="field-label">输入进价<input type="number" min="0" step="0.000001" value={editing[model.id].costInputPowerPerMillion} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], costInputPowerPerMillion: Number(event.target.value) } })} /></label>
                <label className="field-label">输出进价<input type="number" min="0" step="0.000001" value={editing[model.id].costOutputPowerPerMillion} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], costOutputPowerPerMillion: Number(event.target.value) } })} /></label>
                </> : <ImageCallPricing price={editing[model.id].imagePowerPerCall} cost={editing[model.id].costImagePowerPerCall} onChange={(values) => setEditing({ ...editing, [model.id]: { ...editing[model.id], ...values } })} />}
                <label className="field-label model-prompt-field">System Prompt<textarea rows={4} value={editing[model.id].systemPrompt} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], systemPrompt: event.target.value } })} /></label>
                <label className="inline-check"><input type="checkbox" checked={editing[model.id].enabled} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], enabled: event.target.checked } })} />启用</label>
                <label className="inline-check"><input type="radio" checked={editing[model.id].isDefault} disabled={editing[model.id].kind !== "chat" || !editing[model.id].enabled} onChange={() => setEditing({ ...editing, [model.id]: { ...editing[model.id], isDefault: true } })} />新聊天默认</label>
                <button className="secondary" onClick={() => saveModel(model)}><Save size={15} />保存</button>
              </>
            ) : (
              <>
                <span>{model.name}<small>{model.kind === "image" ? "图片" : model.protocol === "anthropic" ? "聊天 · Anthropic" : "聊天 · OpenAI"} · {model.model}{model.isDefault ? " · 新聊天默认" : ""}</small></span>
                <span>{model.hasApiKey ? "已配置 Key" : "缺少 Key"}<small>{model.kind === "image" ? `售价 ${model.imagePowerPerCall || "未配置"} 电力 / 次` : `售价 ${model.inputPowerPerMillion} / ${model.outputPowerPerMillion} 电力 / 百万 Token`}</small></span>
                {model.kind === "chat" ? <PricingPanel key={`${model.id}-${model.pricing?.version}`} api={api} model={model} reload={reload} /> : null}
                <button className="secondary" onClick={() => setEditing({ ...editing, [model.id]: { name: model.name, kind: model.kind, protocol: model.protocol, baseUrl: model.baseUrl, model: model.model, apiKey: "", systemPrompt: model.systemPrompt || "", inputPowerPerMillion: model.inputPowerPerMillion, outputPowerPerMillion: model.outputPowerPerMillion, costInputPowerPerMillion: model.costInputPowerPerMillion, costOutputPowerPerMillion: model.costOutputPowerPerMillion, imagePowerPerCall: model.imagePowerPerCall ?? 0, costImagePowerPerCall: model.costImagePowerPerCall ?? 0, enabled: model.enabled, isDefault: model.isDefault } })}><Edit3 size={15} />编辑</button>
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
  const privateApi = useMemo(() => user ? apiForUser(user.id) : api, [user?.id]);
  const [booting, setBooting] = useState(true);
  const [bootMessage, setBootMessage] = useState("加载中…");
  const [bootError, setBootError] = useState("");
  const [recoveryLogin, setRecoveryLogin] = useState(false);
  const bootGeneration = useRef(0);
  const currentUser = useRef<User | null>(null);
  currentUser.current = user;
  async function boot() {
    const generation = ++bootGeneration.current;
    expectUser(""); setBooting(true); setBootError(""); setUser(null);
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const loginCode = fragment.get("one-key");
    if (loginCode) window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
    try {
      setBootMessage(loginCode ? "正在验证 ONE Key…" : "正在连接…");
      const result = loginCode ? await api<{ user: User }>("/api/auth/one-key/redeem", { method: "POST", body: JSON.stringify({ loginCode }) }) : await api<{ user: User }>("/api/me");
      if (generation !== bootGeneration.current) return;
      expectUser(result.user.id); setUser(result.user); setRecoveryLogin(false);
      if (loginCode) announceSessionChange();
    } catch (error) {
      if (generation !== bootGeneration.current) return;
      setBootError(error instanceof ApiError && error.status === 401 ? "请插入 ONE Key。首次使用请从 U 盘打开 ONE。" : error instanceof Error ? error.message : "暂时连不上 ONE，请检查网络后重试。");
    } finally { if (generation === bootGeneration.current) setBooting(false); }
  }
  useEffect(() => {
    void boot();
    const changed = () => { void boot(); };
    const storage = (event: StorageEvent) => { if (event.key === SESSION_STORAGE_KEY) changed(); };
    const checkIdentity = () => {
      if (document.visibilityState !== "visible") return;
      if (!currentUser.current) { void boot(); return; }
      void api<{ user: User }>("/api/me").then(result => { if (result.user.id !== currentUser.current?.id) void boot(); }).catch(error => {
        if (error instanceof ApiError && error.status === 401) void boot();
      });
    };
    window.addEventListener(SESSION_EVENT, changed);
    window.addEventListener("storage", storage);
    window.addEventListener("online", checkIdentity);
    document.addEventListener("visibilitychange", checkIdentity);
    return () => { bootGeneration.current++; window.removeEventListener(SESSION_EVENT, changed); window.removeEventListener("storage", storage); window.removeEventListener("online", checkIdentity); document.removeEventListener("visibilitychange", checkIdentity); };
  }, []);

  if (booting) return <div className="boot">{bootMessage}</div>;
  if (!user) return recoveryLogin ? <><Login onDone={next => { expectUser(next.id); setUser(next); announceSessionChange(); }} /><button className="one-login-back" onClick={() => setRecoveryLogin(false)}>返回 ONE Key 登录</button></> : <main className="one-key-welcome"><OneEye size="hero" /><h1>插入 ONE Key</h1><p role="status">{bootError}</p><button className="primary" onClick={() => void boot()}>重新连接</button><details><summary>连接帮助</summary><p>检查 ONE Key、网络和启动器版本。Key 已挂失请联系管理员。</p><button className="secondary" onClick={() => setRecoveryLogin(true)}>超管登录</button></details></main>;
  return (
    <PrivateApiContext.Provider value={privateApi}><ChatApp
      key={user.id}
      user={user}
      onLogout={() => {
        void privateApi("/api/auth/logout", { method: "POST" }).then(() => { expectUser(""); setUser(null); setBootError("已退出。插入 Key 后可以重新打开 ONE。"); announceSessionChange(); }).catch(error => setBootError(error.message));
      }}
    /></PrivateApiContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
