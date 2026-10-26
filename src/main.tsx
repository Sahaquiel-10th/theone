import {OneEye,type OneEyeMood} from './OneEye';
import {OneFluidSurface,getFluidLayout,type FluidFrame as FluidProgress} from "./fluid/OneFluidSurface";
import {useFluidActivityHeight} from './fluid/useFluidActivityHeight';
import {useFluidContentFlow} from './fluid/contentFlow';
import {useFluidPanels} from "./fluid/useFluidPanels";
import { CompanyPanel } from "./CompanyPanel";
import {AdminPowerControls} from './AdminPowerControls';
import {StaticPreviewPanel} from './StaticPreviewPanel';
import type { identityAccess } from "../server/enterprisePolicy";
import React, { FormEvent, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { UnifiedCapabilityPanel } from "./UnifiedCapabilityPanel";
import { OfficialFeaturePanel } from "./OfficialFeaturePanel";
import { FeatureBudgetSettings, approveFeaturePrices } from './FeatureBudgetSettings';
import {ContextSettings,AttentionSettings,AttentionInbox} from './AttentionPanel';
import { FeatureMarketplace } from "./FeatureMarketplace";
import {ProductMetricsPanel} from './ProductMetricsPanel';
import {OneWaitingCopy,useOneGreeting} from './OnePersonality';
import {FeatureNav} from './FeatureNav';
import {ThingsPanel} from './ThingsPanel';
import {TaskReadAllButton} from './TaskReadAllButton';
import {StoryOnboarding} from './StoryOnboarding';
import {onboardingEffectPreview} from './onboardingPreviewBoundary';
import {WelcomeGuideCard} from './WelcomeGuideCard';
import {AttachmentActions} from './AttachmentActions';
import {SavedWelcomeGuides} from './SavedWelcomeGuides';
import {AccountPreferencesLayout} from './AccountPreferencesLayout';
import {AppearanceSettings} from './AppearanceSettings';
import {resolvedAppearanceScene} from './appearancePreferences';
import {FluidWorkLayer} from './FluidWorkLayer';
import {MessageSources} from './MessageSources';
import {FeatureRunMonitor,FeatureRunHistory,type FeatureRunSummary} from './FeatureCatalog';
import './welcome-guide.css';
import type {JourneyInput,WelcomeContext} from '../server/onboardingJourney';
import {ActionMenu} from './ActionMenu';
import {remainingResultAttachments} from './taskMessagePresentation';
import {sendThingMessage} from './sendThingMessage';
import {CoordinatorConversation} from './preview/CoordinatorConversation';
import {useFollowLatest} from './useFollowLatest';
import {runtimeNoticeSeen, rememberRuntimeNotice} from './runtimeNoticeMemory';
import {executionNeedsReview} from './executionReview';
import {executionCanContinue,executionContinuationRequest,executionCancellationRequest,executionForHandoff,executionRecovery,executionResumeInstruction} from './executionRecovery';
import {ExecutionReconcileStop} from './ExecutionReconcileStop';
import {TaskTransferRail, dismissibleReceiptIds, visibleTransfers, transferSettled, type Transfer} from './TaskTransferRail';
import {taskCategory,taskUiOutcome,taskEntrySelection} from './taskAttention';
import {taskRetryScope} from './taskRetryScope';
import {notionReceiptForReview,unstartedLocalInput} from './taskRecovery';
import {taskConversationView} from './taskConversationView';
import {friendlyExecutionProgress,readCapturedNotices} from './friendlyTaskStatus';
import {internalTaskId} from './taskLink';
import {claimInitialTaskLink,settleInitialTaskLink,coordinatorTaskConversation} from './coordinatorTaskView';
import {TaskWorkflowProgress} from './TaskWorkflowProgress';
import {FeatureShelf,type FeatureChoice} from './preview/FeatureShelf';
import {KnowledgeConnections} from './KnowledgeConnections';
import {captureFeatureHandoff,FeatureHandoff,FeatureArmedRim,pulseFeatureComposer,type FeatureHandoffTransfer} from './FeatureHandoff';
import {featureSelectionTransition} from './featureHandoffMotion';
import {ResultSignal} from './preview/ResultSignal';
import {useWorkspacePreview} from './preview/useWorkspacePreview';
import {useCoordinator} from './useCoordinator';
import {executionHandoffOutcome} from './executionHandoff';
import { useComposerFeatures } from "./ComposerFeatures";
import { LocalDeviceSettings } from './LocalDeviceSettings';
import { DocumentDestinationPicker, NotionWritingSettings, NotionReceiptNotice, type DocumentDestination } from './DocumentDestination';
import './preview/workspace-preview.css';
import './task-transfer.css';
import {canPeekAtFeatures,waitingForCurrentReply} from './oneFocusState';
import {eyeRoute,isConversationShelfMove,type EyeRoute} from './oneEdgeMotion';
import {createEyeMotion} from './interruptibleEye';
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { MessageMarkdown, ImagePreview, hasInlineImage } from "./MessageMarkdown";
import { PublicSharingPage } from "./PublicSharing";
import "katex/dist/katex.min.css";
import {
  Archive,
  Check,
  Sparkles,
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
  Lightbulb,
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
import "./one-settings.css";
import './one-product.css';
import './account-preferences.css';
import './one-playful.css';
import './task-message-ux.css';
import "./fluid-workspace.css";
import './fluid-scenes.css';
import './fluid-conversation.css';
import './appearance-settings.css';
import './fluid-work-layers.css';
import './fluid-flow-integration.css';
import './fluid-workflow-system.css';
import './fluid-control-rhythm.css';
import './fluid/fluid-work-layer-arrival.css';
import { Pagination, SearchPicker, SettingsDialog } from "./SettingsControls";
import { BetaUserInsights } from "./BetaUserInsights";
import { mergeTaskSnapshots, recoverTaskDraft } from "./oneStudioState";
import { buildTaskActivityRows, getSettledTaskTransitions, selectConversationExecution, shouldAutoReadTaskNotice, type TaskActivityRow } from "./oneTaskAttention";
import { OneCompanionEye as OneHeroEye } from "./OneCompanionEye";
import { api, apiForUser, ApiError, expectUser, announceSessionChange, SESSION_EVENT, SESSION_STORAGE_KEY } from "./oneApi";
import { chatSubmission, forgetChatSubmission, pendingChatSubmissions } from "./chatSubmission";
import { ProfileNameEditor, BetaFeedbackControls, type AccountProfile, type ProfilePatch } from "./Onboarding";
import type { OnboardingHandbookOffer,WelcomeDelivery as Delivery } from '../server/onboardingHandbook';
import {WelcomeDelivery,followWelcomeDelivery} from './WelcomeDelivery';
import { PaymentPanel } from "./PaymentPanel";
import { CacheUsageDetails } from "./CacheUsageDetails";
import { PricingCatalog } from "./PricingPanel";
import { MembershipAdminPanel } from "./MembershipPanel";
import { GiftBatchHistory } from "./GiftBatchHistory";
import { runtimeUpdateView, runtimeUpdateConfirmed, runtimeRecoveryMessage, type RuntimeUpdateStatus } from "./runtimeUpdateState";

type Role = "admin" | "user";
const PrivateApiContext = createContext<typeof api>(api);

type User = {
  access?: ReturnType<typeof identityAccess>;
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
  pricing?: { referenceInput: number; referenceOutput: number; referenceCache?: { read: number; write: number; write1h: number }; longContext?: { thresholdInputTokens: number; referenceInput: number; referenceOutput: number; referenceCache?: { read: number; write: number; write1h: number } }; multiplier: number; version: number; label: string; effectiveAt?: string; publishedAt?: string; explanation?: string };
  cacheCostPrices?: { read: number; write: number; write1h: number };
  pricingHistory?: { pricing: NonNullable<Model["pricing"]>; cancelledAt?: string }[];
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
  finishReason?: "stop" | "length" | "filtered" | "tool_calls" | "unknown";
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
  officeArtifact?:'slides'|'file';
  welcomeGuide?:boolean;visualDocument?:boolean;
  id: string;
  originalName: string;
  mimeType: string;
  kind: "image" | "document" | "spreadsheet" | "presentation" | "text";
  size: number;
  status?: "uploading" | "queued" | "parsing" | "ready" | "failed";
  uploadedBytes?: number;
  parseError?: string;
};

type SearchSource = {
  title: string;
  url: string;
  snippet: string;
};

type AppCapabilities = {
  attachments: { enabled: boolean; maxFiles: number; maxBytes: number; imageMaxBytes?: number; extensions: string[] };
  webSearch: { enabled: boolean };
  knowledge?: { providers: KnowledgeConnection["provider"][] };
};

type KnowledgeConnection = {
  provider: "getnote" | "notion" | "yinxiang" | "flowus" | "flomo";
  status: "disconnected" | "pending" | "connected" | "error" | "revoked";
  providerSpaceName?: string;
  credentialExpiresAt?: string;
  lastCheckedAt?: string;
  lastError?: string;
};

type ExecutionTask = {
  id: string;
  dispatchOperationId?: string;
  preparationOperationId?: string;
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
  resultDeliveryPending?: boolean;
  blocksCurrentDevice?: boolean;
  requiresExecutionCheck?: boolean;
  reportRound?: number;
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
type OneViewTransition = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void>; skipTransition: () => void };
type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => OneViewTransition;
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
  coordinatorMain?:boolean;
  executorProfileId?:string;
  workPaused?:boolean;
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
type RechargeOrder = { id: string; userId: string; requestedMicros: number; amountCny: number; status: "pending" | "paid" | "cancelled"; createdAt: string; username?: string; payment?: { channel: string; expiresAt?: string } };
type UsageRecord = { cacheUsage?: { read: number; write: number; write5m: number; write1h: number }; cachePricesSnapshot?: { read: number; write: number; write1h: number }; id: string; userId: string; modelId: string; inputTokens: number; outputTokens: number; totalTokens: number; chargedMicros?: number; costMicros?: number; requestId?: string; createdAt: string; username?: string; modelName?: string; source?: "provider" | "estimated" | "unknown" | "fixed"; status?: "pending" | "success" | "failed" | "needs_review" | "waived"; activity?: "attachment_summary" | "chat" | "execution_compile" | "local_agent"; durationMs?: number };
type UsageTotals = { calls: number; inputTokens: number; outputTokens: number; chargedMicros: number; costMicros: number; unknownCostCalls?: number; reviewCalls?: number; failedCalls?: number };
type UserUsageSummary = {
  userId: string; workspaceId: string; username: string; role?: Role; enabled: boolean; balanceMicros: number; reservedMicros?: number;
  today: UsageTotals; sevenDays: UsageTotals; total: UsageTotals; conversationCount: number;
  knowledgeRecallCount: number; executionCount: number; activeKeyCount: number; activeDays7d?: number; lastUsedAt?: string;
};
type UsageActivity = { id: string; action: string; targetType: string; requestId?: string; createdAt: string };
type UserUsageDetail = { diagnostics?:ReturnType<typeof import('../server/billingDiagnostics').billingDiagnostics>; user: { id: string; username: string; enabled: boolean }; usage: UsageRecord[]; activity: UsageActivity[]; pagination: { offset: number; limit: number; total: number; hasMore: boolean }; activityTotal: number; period: string };
type AuditItem = { id: string; actorName?: string; action: string; targetType: string; requestId?: string; createdAt: string };
type OneKeyDevice = { id: string; serialNumber: string; workspaceId: string; userId: string; username: string; status: "active" | "revoked"; createdAt: string; lastUsedAt?: string; revokedAt?: string };
type ContextTraceSummary = { id: string; workspaceId: string; userId: string; username: string; conversationId: string; conversationTitle: string; modelName: string; requestId?: string; query: string; responsePreview: string; executionStepCount?: number; createdAt: string };
type ContextTraceDetail = ContextTraceSummary & { assistantMessageId: string; modelId: string; sections: { key: string; title: string; content: string }[]; executionSteps?: { step: number; tool: string; status: string; query?: string; resultPreview: string; durationMs: number }[] };
type OneKeyCredential = { version: 1; deviceId: string; privateKeyRaw: string; publicKeyRaw: string; serverBaseUrl?: string };

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
  if (preparing) return "我在准备这件事";
  if (!task) return "准备开始";
  if (task.requiresExecutionCheck) return '本机工具还没确认结束，请核对操作记录';
  if (task.resultDeliveryPending) return task.status === 'cancelled' ? '已请求停止，等待本机确认' : '本机结果还没确认，正在等反馈';
  if (task.status === "queued" || task.status === "selecting_target") return "正在连接本机";
  if (task.status === "running") return "正在替你工作";
  if (task.status === "completed") return "本轮结果已返回";
  if (task.status === "cancelled") return "任务已停止";
  return "这一步还没做成";
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

function AttachmentList({ attachments, removable, onRemove, onRetry }: {
  attachments: AttachmentSummary[];
  removable?: boolean;
  onRemove?: (attachment: AttachmentSummary) => void;
  onRetry?: (attachment: AttachmentSummary) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className={`attachment-list ${removable ? "pending" : ""}`}>
      {attachments.map((attachment) => (
        attachment.welcomeGuide||attachment.visualDocument?<WelcomeGuideCard key={attachment.id} id={attachment.id} title={attachment.originalName}/>:
        <div className="attachment-chip" key={attachment.id}>
          {attachment.kind === "image" && (!attachment.status || attachment.status === "ready") ? (
            <img src={`/api/attachments/${encodeURIComponent(attachment.id)}/content`} alt="" />
          ) : <span className="attachment-file-icon"><AttachmentIcon kind={attachment.kind} /></span>}
          <span className="attachment-meta">
            <strong title={attachment.originalName}>{attachment.originalName}</strong>
            <small title={attachment.parseError}>{attachment.status === "uploading" ? `上传 ${Math.floor((attachment.uploadedBytes || 0) / attachment.size * 100)}%` : attachment.status === "queued" ? "等待解析" : attachment.status === "parsing" ? "正在解析" : attachment.status === "failed" ? "解析失败" : readableFileSize(attachment.size)}</small>
            {!removable?<AttachmentActions file={attachment}/>:null}
          </span>
          {removable && attachment.status === "failed" && onRetry ? <button className="attachment-retry" type="button" title="重试解析" onClick={() => onRetry(attachment)}>重试</button> : null}
          {removable && attachment.status !== "uploading" ? (
            <button type="button" title="移除附件" onClick={() => onRemove?.(attachment)}><X size={13} /></button>
          ) : null}
        </div>
      ))}
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

function ExecutionDisclosure({ task, events, preparing, expanded, onToggle, onStop, onContinue, onCheck, onReconciled, actorRole = 'user', continuationDisabled = false, idPrefix = "one" }: {
  idPrefix?: string;
  task: ExecutionTask | null; events: ExecutionEvent[]; preparing: boolean; expanded: boolean;
  onToggle: () => void; onStop: (source: HTMLElement) => void;
  onContinue?: (source: HTMLElement) => void; onCheck?: () => void;
  continuationDisabled?: boolean;
  actorRole?: Role; onReconciled?: (task: ExecutionTask, events: ExecutionEvent[]) => void;
}) {
  const [trace, setTrace] = useState("");
  const steps = events.filter(event => event.kind !== "user_message");
  const latestStep = friendlyExecutionProgress(steps[steps.length - 1]);
  const api = useContext(PrivateApiContext);
  const status = preparing ? "preparing" : executionNeedsReview(task) ? "needs_input" : task?.status || "preparing";
  const busy = preparing || isExecutionRunning(task);
  const recovery = executionRecovery(task);
  return <section id={`${idPrefix}-current-execution`} className={`execution-disclosure ${status} ${expanded ? "is-expanded" : ""}`} aria-label="本机执行">
    <div className="execution-disclosure-header">
      <button className="execution-disclosure-toggle" type="button" aria-expanded={expanded} aria-controls={`${idPrefix}-execution-content`} onClick={onToggle}>
        <span className={`task-indicator ${busy ? "running" : status}`} aria-hidden="true">{status === "completed" ? <Check size={12} /> : null}</span>
        <span><strong>{executionNeedsReview(task) ? '这轮有个问题，结果需要核对' : executionStatusLabel(task, preparing)}</strong><small>{preparing ? "正在连接这台电脑…" : recovery?.title || (task?.status === "completed" ? "看看做了什么" : latestStep || "看看正在做什么")}</small></span>
        <span className="execution-expand-label">{expanded ? "收起" : "展开"}</span><ChevronDown size={15} />
      </button>
      {busy || task?.resultDeliveryPending || task?.requiresExecutionCheck ? <button className="execution-stop" type="button" disabled={!busy&&continuationDisabled} onClick={event => onStop(event.currentTarget)}><Square size={10} />{busy?'停止本机执行':'再次请求停止原操作'}</button> : null}
    </div>
    <div className="execution-disclosure-grid" data-open={expanded}>
      <div className="execution-disclosure-clip" inert={!expanded} aria-hidden={!expanded}>
        <div id={`${idPrefix}-execution-content`} className="execution-disclosure-body">
          {task?.targetName ? <p className="execution-current-step">工作文件夹：{task.targetName}（可在设置 → 本机执行中更换）</p> : null}
          {task && !busy && task.targetName ? <StaticPreviewPanel key={task.id} taskId={task.id} request={(action, path) => api(`/api/executions/${encodeURIComponent(task.id)}/preview`, {method: 'POST', body: JSON.stringify({action, path})})}/> : null}
          {!busy && recovery ? <div className="execution-problem" role="status"><p>{recovery.message}</p>{recovery.canContinue && onContinue ? <button type="button" disabled={continuationDisabled} onClick={event=>onContinue(event.currentTarget)}>核对后继续这件事</button> : onCheck ? <button type="button" onClick={onCheck}>检查本机状态</button> : null}{task?<ExecutionReconcileStop actorRole={actorRole} task={task} disabled={continuationDisabled} onReconcile={async request=>{const result=await api<{task:ExecutionTask;events:ExecutionEvent[]}>(request.path,{method:'POST',body:JSON.stringify(request.body)});onReconciled?.(result.task,result.events);}}/>:null}{task?.finalResponse?<MessageMarkdown>{task.finalResponse}</MessageMarkdown>:null}</div> : !busy && task?.status === "completed" && task.finalResponse ? <div className="markdown-body"><MessageMarkdown>{task.finalResponse}</MessageMarkdown></div> : <p className="execution-current-step">{preparing ? "正在连接这台电脑…" : task?.status === "completed" ? "这轮操作已结束，结果保留在对应任务里。" : latestStep || "正在等这台电脑的反馈…"}</p>}
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
  const guideEffectPreview=onboardingEffectPreview(window.location,document.documentElement.dataset.onePreviewMode);
  const [storyLaunchError,setStoryLaunchError]=useState(''),[storyLaunching,setStoryLaunching]=useState(false);
  const storyLaunchPending=useRef(false);
  const storyRequested=useRef(false),storyStarter=useRef<()=>Promise<void>>(async()=>{});
  const demo = useWorkspacePreview();
  const api = useContext(PrivateApiContext);
  const coordinator = useCoordinator(api,user.id,!demo.enabled,user.access?.workspaceId??user.defaultWorkspaceId);
  const preview = coordinator.enabled ? coordinator : demo;
  const [profile, setProfile] = useState<AccountProfile>(user.profile || { workspaceId: user.defaultWorkspaceId, displayName: "", onboarding: { knowledgeChoice: "pending" }, updatedAt: user.createdAt });
  const [handbookOffer,setHandbookOffer]=useState<OnboardingHandbookOffer>(),[handbookNotice,setHandbookNotice]=useState('');
  const [welcomeContext,setWelcomeContext]=useState<WelcomeContext>(),[profileLoaded,setProfileLoaded]=useState(false),[storyOpen,setStoryOpen]=useState(false),[storyHidden,setStoryHidden]=useState(false),[storyTaskId,setStoryTaskId]=useState('');
  const [delivery,setDelivery]=useState<Delivery>(),[deliveryBusy,setDeliveryBusy]=useState(false),[deliveryError,setDeliveryError]=useState(''),[dismissedDelivery,setDismissedDelivery]=useState('');
  const deliverySeenKey=`one-welcome-seen:${user.id}:${profile.workspaceId}`;
  useEffect(()=>{try{setDismissedDelivery(localStorage.getItem(deliverySeenKey)||'');}catch{setDismissedDelivery('');}},[deliverySeenKey]);
  function dismissWelcome(){if(!delivery)return;setDismissedDelivery(delivery.operationId);try{localStorage.setItem(deliverySeenKey,delivery.operationId);}catch{/* Optional local reminder preference only. */}}
  type WelcomeResponse={profile:AccountProfile;handbookOffer?:OnboardingHandbookOffer;welcomeContext?:WelcomeContext;welcomeDelivery?:Delivery;handbookNotice?:string};
  function acceptWelcome(result:WelcomeResponse){setProfile(result.profile);setHandbookOffer(result.handbookOffer);setWelcomeContext(result.welcomeContext);setDelivery(result.welcomeDelivery);}
  async function checkWelcome(){setDeliveryBusy(true);setDeliveryError('');try{acceptWelcome(await api<WelcomeResponse>('/api/me/profile'));}catch{setDeliveryError('状态还没连上，设置和已有任务都保留着。');}finally{setDeliveryBusy(false);}}
  async function retryWelcome(){if(!delivery?.canRetry||deliveryBusy)return;setDeliveryBusy(true);setDeliveryError('');try{acceptWelcome(await api<WelcomeResponse>('/api/me/profile/onboarding',{method:'POST',body:JSON.stringify({action:'retry_delivery',operationId:delivery.operationId})}));void coordinator.refresh();}catch(e){setDeliveryError(e instanceof Error?e.message:'这次没安排好，先检查状态。');}finally{setDeliveryBusy(false);}}
  useEffect(()=>{
    if(demo.enabled)return;
    let live=true;
    void api<WelcomeResponse>('/api/me/profile').then(result=>{if(live)acceptWelcome(result);}).catch(()=>{}).finally(()=>{if(live)setProfileLoaded(true);});
    return()=>{live=false;};
  },[user.id,profile.workspaceId]);
  const welcomeTaskStatus=coordinator.state.tasks.find(task=>task.id===delivery?.taskId)?.status;
  useEffect(()=>{
    if(demo.enabled||!delivery||!followWelcomeDelivery(delivery,welcomeTaskStatus))return;
    let live=true,busy=false;
    const refresh=()=>{if(busy)return;busy=true;void api<WelcomeResponse>('/api/me/profile').then(result=>{if(live){setDelivery(old=>old?.operationId===result.welcomeDelivery?.operationId?result.welcomeDelivery:old);setDeliveryError('');}}).catch(()=>{if(live)setDeliveryError('状态暂时没连上，任务不会重复安排。');}).finally(()=>{busy=false;});};
    refresh();const timer=setInterval(refresh,5000);
    return()=>{live=false;clearInterval(timer);};
  },[user.id,profile.workspaceId,delivery?.operationId,delivery?.state,welcomeTaskStatus]);
  const [pendingRequests, setPendingRequests] = useState(() => pendingChatSubmissions(user.id));
  const [hasSubmittedChat, setHasSubmittedChat] = useState(false);
  const failedSubmissions = useRef(new Map<string, { content: string; attachmentIds: string[]; draftKey: string }>());
  async function saveProfile(patch: ProfilePatch) {
    const result = await api<{ profile: AccountProfile; handbookOffer?:OnboardingHandbookOffer; handbookNotice?:string }>("/api/me/profile", { method: "PATCH", body: JSON.stringify(patch) });
    setProfile(result.profile);setHandbookOffer(result.handbookOffer);setHandbookNotice(result.handbookNotice||'');
    if(patch.onboardingAction==='complete'&&result.profile.onboarding.handbook?.taskId)void coordinator.refresh();
    return result.profile;
  }
  async function saveStory(input:JourneyInput) {
    const result=await api<WelcomeResponse>('/api/me/profile/onboarding',{method:'POST',body:JSON.stringify(input)});
    acceptWelcome(result);
    if(result.profile.onboarding.journey?.stage==='complete'&&(input.action==='finish'||input.step==='features')) {
      const returnToChat=storyRequested.current;storyRequested.current=false;
      setStoryOpen(false);setStoryHidden(true);if(returnToChat){setComposeNew(true);openSurface('chat');}
      const guide=result.profile.onboarding.handbook;
      setHandbookNotice(result.welcomeDelivery?'':result.handbookNotice||'');setDismissedDelivery('');
      setStoryTaskId(guide?.status==='queued'?guide.taskId||'':'');
      void coordinator.refresh().catch(()=>{if(guide?.status==='queued')setHandbookNotice('使用说明已经安排好了，进度暂时没刷新出来。可以先聊，或打开任务看看。');});
    }
    return result.profile;
  }
  async function startStory() {
    storyRequested.current=true;
    setStoryLaunchError('');setStoryOpen(true);setStoryHidden(false);
    if(preview.enabled){setWorkLayer('guide');setView('chat');}
    if(guideEffectPreview)return;
    if(storyLaunchPending.current)return;
    storyLaunchPending.current=true;setStoryLaunching(true);
    try{await saveStory({action:'begin',launchId:crypto.randomUUID(),experience:4});if(storyRequested.current){setComposeNew(true);if(!preview.enabled)openSurface('chat');}}
    catch(error){if(storyRequested.current)setStoryLaunchError(error instanceof Error?error.message:'引导暂时没打开，可以重新试一次。');}
    finally{storyLaunchPending.current=false;setStoryLaunching(false);}
  }
  storyStarter.current=startStory;
  function dismissStory(){storyRequested.current=false;setStoryHidden(true);setStoryOpen(false);closeWorkLayer();}
  useEffect(()=>{
    if(!guideEffectPreview)return;
    const open=()=>{void storyStarter.current();};window.addEventListener('one-onboarding-preview',open);
    return()=>window.removeEventListener('one-onboarding-preview',open);
  },[guideEffectPreview]);
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
  const [storedConversations, setConversations] = useState<Conversation[]>([]);
  const listedConversations: Conversation[] = demo.enabled ? demo.state.tasks.map(task => ({id: task.id, title: task.title, userId: user.id, modelId: 'preview-model', archived: false, messagesLoaded: true, createdAt: user.createdAt, updatedAt: user.createdAt, messages: task.messages.map(message => ({id:message.id,role:message.role,content:message.text,createdAt:user.createdAt}))})) : coordinator.enabled ? [...coordinator.state.tasks.map(task=>{const detail=coordinator.details[task.id]?.conversation,old=storedConversations.find(c=>c.id===task.id),meta=coordinator.snapshot?.tasks.find(c=>c.id===task.id);return detail?{...detail,messagesLoaded:true}:old||{id:task.id,title:task.title,userId:user.id,modelId:models.find(m=>m.isDefault)?.id||models[0]?.id||'',archived:false,messagesLoaded:false,messages:[],createdAt:user.createdAt,updatedAt:meta?.updatedAt||user.createdAt};}),...storedConversations.filter(c=>!coordinator.state.tasks.some(t=>t.id===c.id)&&!(c as Conversation&{coordinatorMain?:boolean}).coordinatorMain)] : storedConversations;
  const conversations=coordinator.enabled?listedConversations.map(item=>coordinatorTaskConversation(item,coordinator.details)):listedConversations;
  const [conversationPage, setConversationPage] = useState(1);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [folders, setFolders] = useState<ConversationFolder[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [thingId,setThingId] = useState('');
  const [taskScope,setTaskScope] = useState<'tasks'|'features'>('tasks');
  const [thingDrafts,setThingDrafts] = useState<Record<string,string>>({});
  const [thingDestinations,setThingDestinations] = useState<Record<string,DocumentDestination>>({});
  const [taskRetryBudgets,setTaskRetryBudgets]=useState<Record<string,string>>({});
  const [resultLampOpen,setResultLampOpen] = useState(false);
  const [dismissedResults,setDismissedResults] = useState<string[]>([]);
  const [previewHome,setPreviewHome] = useState(true);
  const [featureForNext,setFeatureForNext]=useState<FeatureChoice[]>([]);
  const selectedFeaturesRef=useRef(featureForNext);selectedFeaturesRef.current=featureForNext;
  const [featureTransfer,setFeatureTransfer]=useState<FeatureHandoffTransfer|null>(null);
  const [featureSelectionNotice,setFeatureSelectionNotice]=useState('');
  useEffect(()=>{setFeatureTransfer(current=>current&&!featureForNext.some(feature=>feature.id===current.featureId)?null:current);},[featureForNext]);
  const [draftModelId, setDraftModelId] = useState("");
  const [draftAgentId, setDraftAgentId] = useState("");
  const [defaultModelId, setDefaultModelId] = useState("");
  const [draftWorkspaceId, setDraftWorkspaceId] = useState("");
  const [content, setContent] = useState("");
  const featurePicker = useComposerFeatures({api,text:content,setText:setContent,selected:featureForNext.map(f=>f.id),onChoose:chooseFeature});
  const [loadingByConversation, setLoadingByConversation] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [view, setView] = useState<"chat" | "things" | "admin" | "company" | "account" | "features" | "agents" | "agentEditor">(() => { const params = new URLSearchParams(window.location.search); return params.has("notion") || params.has("knowledge") ? "account" : user.access?.role === "company_admin" ? "company" : user.role === "admin" ? "admin" : "chat"; });
  type WorkLayer = 'features'|'account'|'things'|'history'|'admin'|'company'|'guide';
  const [workLayer,setWorkLayer] = useState<WorkLayer|null>(null);
  const [visitedLayers,setVisitedLayers] = useState<WorkLayer[]>([]);
  const [featureOperationId,setFeatureOperationId] = useState('');
  const [viewedFeatureOperation,setViewedFeatureOperation] = useState<string|undefined>();
  const [featureRuns,setFeatureRuns] = useState<FeatureRunSummary[]>([]);
  const [featureRunIssue,setFeatureRunIssue] = useState('');
  const [attentionCount,setAttentionCount] = useState(0);
  useEffect(()=>{if(workLayer)setVisitedLayers(old=>old.includes(workLayer)?old:[...old,workLayer]);},[workLayer]);
  const knowledgeReturnRef=useRef({notion:new URLSearchParams(window.location.search).get('notion'),provider:new URLSearchParams(window.location.search).get('knowledge'),status:new URLSearchParams(window.location.search).get('status')});
  // A connector callback may arrive before the coordinator finishes loading.
  // Adopt its settings destination without moving or remounting the main chat.
  useEffect(()=>{if(preview.enabled&&['account','things','features','admin','company'].includes(view)){setWorkLayer(view as WorkLayer);setView('chat');}},[preview.enabled,view]);
  const [accountSection, setAccountSection] = useState(() => { const params = new URLSearchParams(window.location.search); return params.has("notion") || params.has("knowledge") ? "knowledge" : "profile"; });
  const eyeMotion = useRef<ReturnType<typeof createEyeMotion> | null>(null);
  if (!eyeMotion.current) eyeMotion.current = createEyeMotion();
  useEffect(()=>()=>eyeMotion.current?.clear(),[]);
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
    webSearch: { enabled: false }
  });
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentSummary[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [knowledgeConnection, setKnowledgeConnection] = useState<KnowledgeConnection>({
    provider: "getnote",
    status: "disconnected"
  });
  const [notionConnection, setNotionConnection] = useState<KnowledgeConnection>({ provider: "notion", status: "disconnected" });
  const [yinxiangConnection, setYinxiangConnection] = useState<KnowledgeConnection>({ provider: "yinxiang", status: "disconnected" });
  const [flomoConnection, setFlomoConnection] = useState<KnowledgeConnection>({ provider: "flomo", status: "disconnected" });
  const [flowusConnection, setFlowusConnection] = useState<KnowledgeConnection>({ provider: "flowus", status: "disconnected" });
  const [runtimeUpdate, setRuntimeUpdate] = useState<RuntimeUpdateStatus | null>(null);
  const [runtimeUpdateIssue, setRuntimeUpdateIssue] = useState("");
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [runtimeCheckFeedback, setRuntimeCheckFeedback] = useState("");
  const [dismissedRuntimeReceipt, setDismissedRuntimeReceipt] = useState(() => {
    try { return sessionStorage.getItem(`one.runtime.confirmed.${user.id}`) || ""; } catch { return ""; }
  });
  useLayoutEffect(() => {
    if (!runtimeUpdate || !runtimeUpdateConfirmed(runtimeUpdate)) return;
    const version = runtimeUpdate.current!.version;
    try {
      if (runtimeNoticeSeen(localStorage, user.id, version)) {
        setDismissedRuntimeReceipt(runtimeUpdate.confirmation!.requestId);
      } else {
        // Remember presentation, not just clicking Refresh. Keep this first notice visible.
        rememberRuntimeNotice(localStorage, user.id, version);
      }
    } catch { /* Browser may deny even access to localStorage. */ }
  }, [user.id, runtimeUpdate?.confirmation?.requestId, runtimeUpdate?.connectionState, runtimeUpdate?.current?.version]);
  const runtimeCheck = useRef({ pending: false, dispatching: false, generation: 0, lastSuccess: Date.now(), active: false });
  const [runtimeUpdating, setRuntimeUpdating] = useState(false);
  const [executionTasks, setExecutionTasks] = useState<ExecutionTask[]>([]);
  const [eventsByTask, setEventsByTask] = useState<Record<string, ExecutionEvent[]>>({});
  const [taskStatusUnavailable, setTaskStatusUnavailable] = useState(true);
  const [outputDestination, setOutputDestination] = useState<DocumentDestination>('chat');
  const [selectedExecutionId, setSelectedExecutionId] = useState("");
  const [executionMode, setExecutionMode] = useState(false);
  const [awaitingExecutionOperationId, setAwaitingExecutionOperationId] = useState('');
  const [preparingExecution, setPreparingExecution] = useState(false);
  const executionPreparationRef = useRef<{cancelled:boolean;operationId?:string;coordinator?:boolean}|null>(null);
  const stoppedPreparationIdsRef = useRef(new Set<string>());
  const stoppedExecutionIdsRef = useRef(new Set<string>());
  const [preparingConversationId, setPreparingConversationId] = useState("");
  const [executionSourceMessageId, setExecutionSourceMessageId] = useState("");
  const [takeoverTaskId, setTakeoverTaskId] = useState("");
  const [composeNew, setComposeNew] = useState(false);
  const [composeMode, setComposeMode] = useState<"chat" | "execution">("chat");
  const [failedTaskIds, setFailedTaskIds] = useState<Set<string>>(() => new Set());
  const [activityExpanded, setActivityExpanded] = useState(false);
  const [expandedExecutionId, setExpandedExecutionId] = useState("");
  const [focusedTask, setFocusedTask] = useState(false);
  const [revealExecutionId, setRevealExecutionId] = useState("");
  const [taskNotices, setTaskNotices] = useState<TaskNotice[]>([]);
  const [visibleReceiptId, setVisibleReceiptId] = useState("");
  const observedTasksRef = useRef<ExecutionTask[]>([]);
  const motionTasksRef = useRef<Set<string> | null>(null);
  const initialTaskLinkRef = useRef({opening:false,opened:false});
  const executionOriginRef = useRef<TransitionPoint>({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  const executionPointerRef = useRef<{element: HTMLElement; point: TransitionPoint} | null>(null);
  const draftsRef = useRef<Record<string, { content: string; attachments: AttachmentSummary[] }>>({});
  const draftAliasesRef = useRef<Record<string, string>>({});
  const composeKeyRef = useRef("new");
  composeKeyRef.current = preview.enabled || composeNew || !activeId ? "new" : activeId;
  const currentDraftRef = useRef({ content, attachments: pendingAttachments });
  const coordinatorFailedDraft = useRef<{text:string;files:AttachmentSummary[];features:FeatureChoice[]}|null>(null);
  currentDraftRef.current = { content, attachments: pendingAttachments };
  const viewedConversationRef = useRef("");
  viewedConversationRef.current = view === "chat" ? activeId : "";

  const active = useMemo(() => conversations.find((item) => item.id === activeId), [activeId, conversations]);
  const targetConversation = preview.enabled || composeNew ? undefined : active;
  const activeModelId = targetConversation?.modelId || draftModelId;
  const activeLoadingKey = active?.id || "draft";
  const activeLoading = Boolean(loadingByConversation[activeLoadingKey]) || (preview.enabled && preview.state.tasks.some(task => task.id === activeId && task.status === 'running'));
  const executionTask = selectConversationExecution(executionTasks, activeId, selectedExecutionId);
  const thingExecutionTask = selectConversationExecution(executionTasks, thingId, selectedExecutionId);
  const executionEvents = executionTask ? eventsByTask[executionTask.id] || [] : [];
  const runningExecutions = executionTasks.filter(isExecutionRunning);
  const currentRunningExecution = runningExecutions.find(task => task.conversationId === activeId);
  const executionShortcut = currentRunningExecution || executionTask;
  const executionBusy = runningExecutions.length > 0;
  const activeExecutionMode = executionMode;
  const targetLoading = preview.enabled ? Boolean(preview.state.pending) || Boolean(loadingByConversation[activeLoadingKey]) : !composeNew && activeLoading;
  const studioIdle = view === "chat" && !activeId && (!preview.enabled || previewHome);
  const taskScroll = useFollowLatest<HTMLElement>(activeId, view === 'chat' && Boolean(active));
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
  const visibleConversations = conversations.filter((conversation) => conversation.archived === showArchived && conversation.title.toLocaleLowerCase().includes(historyQuery.trim().toLocaleLowerCase())).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  const ungroupedConversations = visibleConversations.filter((conversation) => !conversation.folderId);
  const isWaiting = (preview.enabled && (Boolean(preview.state.pending) || preview.state.tasks.some(task=>task.status==='running'))) || Object.values(loadingByConversation).some(Boolean) || executionBusy || preparingExecution;
  const greeting=useOneGreeting(`${view}:${activeId}`);
  const lampTasks = preview.enabled ? preview.state.tasks.filter(task=>task.unread && !dismissedResults.includes(`${task.id}:${task.messages.filter(message=>message.role==='assistant').at(-1)?.id}`)) : [];
  const lampKey=lampTasks.map(task=>`${task.id}:${task.messages.filter(message=>message.role==='assistant').at(-1)?.id}`).join('|');
  const coordinatorMetas = coordinator.snapshot?.transfers || coordinator.snapshot?.tasks || [];
  const transfers: Transfer[] = [...coordinatorMetas.filter(t => t.running || t.queued || t.reconciling || t.state==='reconciling' || t.localPrepared || t.state==='prepared_local').map(t => ({id:`work:${t.id}`,taskId:t.id,title:t.title,phase:t.phase,state:t.state||(t.running?'running':t.reconciling?'reconciling':t.paused?'paused':t.localPrepared?'prepared_local':'queued'),reportable:false})),
    ...(coordinator.snapshot?.notices ?? []).map(n => ({id:n.id,taskId:n.taskId,title:n.title||conversations.find(c=>c.id===n.taskId)?.title||'这件事',state:n.state,reported:n.reported,read:n.read,outcome:n.outcome,reportable:true})),
    ...executionTasks.filter(t=>isExecutionRunning(t)).map(t=>({id:t.id,taskId:t.conversationId,title:conversations.find(c=>c.id===t.conversationId)?.title||'本机任务',state:t.status,local:true,reportable:false}))];
  const unviewedResultCount=new Set((coordinator.snapshot?.notices||[]).filter(n=>!n.read).map(n=>n.taskId)).size;
  const uniqueTransfers = [...new Map(transfers.map(t=>[t.id,t])).values()].map(task=>({...task,updatedAt:
    coordinator.snapshot?.notices.find(n=>n.id===task.id)?.updatedAt
    || executionTasks.find(t=>t.id===task.id)?.updatedAt
    || coordinatorMetas.find(t=>t.id===task.taskId)?.updatedAt}));
  // Material-only animation: the coordinator and composer remain mounted in place.
  const fluidEnabled = view === 'chat' && preview.enabled;
  const fluidHasDialogue = preview.state.dialogue.length > 0 || Boolean(preview.state.pending);
  const fluidCanvasRef = useRef<HTMLDivElement>(null);
  const fluidEyeOwnerRef = useRef<'main'|'activity'|'local'>('main');
  const [fluidSize,setFluidSize] = useState({width:0,height:0,viewportWidth:0,viewportHeight:0});
  const [fluidAttention,setFluidAttention] = useState<{target:'main'|'activity'|'local';version:number}>({target:'main',version:0});
  function focusFluid(owner:'main'|'activity'|'local'){
    setFluidAttention(old=>({target:owner,version:old.version+1}));
  }
  const fluidFeedback = visibleTransfers(uniqueTransfers);
  const fluidReminderCount=unviewedResultCount+attentionCount+featureRuns.filter(run=>run.status!=='pending').length;
  const fluidLocalTask = runningExecutions.find(task=>task.id===takeoverTaskId) || runningExecutions[0] || executionTasks.find(task=>task.id===takeoverTaskId) || executionTask;
  const fluidActivitySignal = [...fluidFeedback.map(task=>`${task.id}:${task.state}:${task.outcome||''}`),...featureRuns.map(run=>`feature:${run.operationId}:${run.status}`),...(attentionCount?[`attention:${attentionCount}`]:[]),...(delivery&&delivery.operationId!==dismissedDelivery?[`guide:${delivery.operationId}:${delivery.state}`]:[])].sort().join('|');
  const runtimeNotice=Boolean(runtimeUpdate?.available||runtimeUpdate&&runtimeUpdateConfirmed(runtimeUpdate)&&runtimeUpdate.confirmation?.requestId!==dismissedRuntimeReceipt);
  const localTaskSignal = preparingExecution || awaitingExecutionOperationId ? `preparing:${awaitingExecutionOperationId||preparingConversationId}` : fluidLocalTask && (isExecutionRunning(fluidLocalTask)||fluidLocalTask.id===takeoverTaskId) ? `${fluidLocalTask.id}:${fluidLocalTask.status}` : '';
  const fluidLocalSignal=[localTaskSignal,runtimeNotice?`runtime:${runtimeUpdate?.latestVersion||runtimeUpdate?.current?.version}:${runtimeUpdate?.progress?.status||'ready'}`:''].filter(Boolean).join('|');
  const fluidPanels = useFluidPanels({enabled:fluidEnabled,activitySignal:fluidActivitySignal,localSignal:fluidLocalSignal,
    activityReported:Boolean(coordinator.snapshot?.recentReportedReceiptIds?.length||coordinator.snapshot?.notices.some(notice=>notice.reported)),
    activityProtected:featureRuns.some(run=>run.status==='pending') || fluidFeedback.some(task=>!transferSettled(task.state)) || fluidFeedback.some(task=>['needs_input','partial','failed','interrupted'].includes(task.outcome||task.state)),
    localProtected:preparingExecution || Boolean(awaitingExecutionOperationId) || isExecutionRunning(fluidLocalTask),
    onAttention:kind=>setFluidAttention(old=>({target:kind,version:old.version+1})),
    onAutoCollapse:kind=>restoreFluidFocus(kind)
  });
  useLayoutEffect(()=>{
    const canvas=fluidCanvasRef.current;if(!canvas||!fluidEnabled)return;
    const measure=()=>{const rect=canvas.getBoundingClientRect();setFluidSize(old=>old.width===rect.width&&old.height===rect.height&&old.viewportWidth===window.innerWidth&&old.viewportHeight===window.innerHeight?old:{width:rect.width,height:rect.height,viewportWidth:window.innerWidth,viewportHeight:window.innerHeight});};
    measure();const observer=new ResizeObserver(measure);observer.observe(canvas);return()=>observer.disconnect();
  },[fluidEnabled]);
  useEffect(()=>{if(fluidEnabled&&activeId)fluidPanels.open('activity');},[fluidEnabled,activeId]);
  const [fluidAccent,setFluidAccent]=useState<'solar'|'iris'|'jade'>(()=>{const value=new URLSearchParams(window.location.search).get('accent');return value==='iris'||value==='jade'?value:'solar';});
  useEffect(()=>{const update=()=>{const value=new URLSearchParams(window.location.search).get('accent');setFluidAccent(value==='iris'||value==='jade'?value:'solar');};window.addEventListener('one-fluid-accent-preview',update);return()=>window.removeEventListener('one-fluid-accent-preview',update);},[]);
  const [scenePreview,setScenePreview]=useState<'silver'|'graphite'|null>(()=>{const value=import.meta.env.DEV?new URLSearchParams(window.location.search).get('scene'):null;return value==='silver'||value==='graphite'?value:null;});
  const fluidScene=scenePreview||resolvedAppearanceScene(profile);
  useEffect(()=>{if(!import.meta.env.DEV)return;const update=()=>{const value=new URLSearchParams(window.location.search).get('scene');setScenePreview(value==='silver'||value==='graphite'?value:null);};window.addEventListener('one-fluid-scene-preview',update);return()=>window.removeEventListener('one-fluid-scene-preview',update);},[]);
  const fluidMaterialQuery = new URLSearchParams(window.location.search).get('material');
  const fluidMaterial = fluidMaterialQuery==='titanium'||fluidMaterialQuery==='mist'||fluidMaterialQuery==='smoke'||fluidMaterialQuery==='glass'?fluidMaterialQuery:'optical';
  const fluidDesktop = fluidSize.viewportWidth>=1100 && fluidSize.viewportHeight>=584;
  const activityContentHeight=useFluidActivityHeight(fluidCanvasRef,{enabled:fluidEnabled&&fluidDesktop,canvasHeight:Math.max(560,fluidSize.height)});
  const fluidSizing = {activityHeight:activityContentHeight,localHeight:runtimeNotice?320:fluidLocalTask?264:224,paired:fluidPanels.activityOpen&&fluidPanels.localOpen};
  const fluidLayout = getFluidLayout(Math.max(1000,fluidSize.width),Math.max(560,fluidSize.height),fluidSizing);
  const flowFluidContent=useFluidContentFlow(fluidCanvasRef,fluidEnabled&&fluidDesktop,fluidLayout);
  const fluidStyle = {'--fluid-child-left':`${fluidLayout.activityBounds.left}px`,'--fluid-child-width':`${fluidLayout.activityBounds.width}px`,'--fluid-up-top':`${fluidLayout.activityBounds.top}px`,'--fluid-up-height':`${fluidLayout.activityBounds.height}px`,'--fluid-low-top':`${fluidLayout.localBounds.top}px`,'--fluid-low-height':`${fluidLayout.localBounds.height}px`,'--fluid-safe-right':`${fluidLayout.safeRight}px`,'--fluid-reading-width':`${fluidLayout.mainContentBounds.width}px`,'--fluid-sidebar-travel':`${fluidLayout.sidebarTravel}px`} as React.CSSProperties;
  const paintFluidContent = useCallback((frame:FluidProgress)=>{
    const canvas=fluidCanvasRef.current;if(!canvas)return;
    fluidEyeOwnerRef.current=frame.eyeOwner;
    const shift=Number.parseFloat(canvas.style.getPropertyValue('--fluid-sidebar-travel'))||120;
    canvas.style.setProperty('--fluid-sidebar-shift',`${shift*frame.sidebar}px`);
    canvas.closest('main')?.style.setProperty('--fluid-rail-growth',`${shift*frame.sidebar}px`);
    canvas.style.setProperty('--fluid-up-height',`${frame.activityHeight}px`);
    canvas.style.setProperty('--fluid-low-height',`${frame.localHeight}px`);
    canvas.style.setProperty('--fluid-low-top',`${frame.localTop}px`);
    flowFluidContent(frame);
    for(const kind of ['activity','local'] as const){
      const progress=frame[kind],visible=progress>.94;
      canvas.style.setProperty(`--fluid-${kind}-reveal`,String(Math.max(0,Math.min(1,(progress-.94)/.057))));
      canvas.style.setProperty(`--fluid-${kind}-x`,`${frame[kind==='activity'?'activityRecoil':'localRecoil']}px`);
      const panel=canvas.querySelector<HTMLElement>(`.fluid-${kind}-panel`);
      if(panel){panel.inert=!visible;panel.setAttribute('aria-hidden',String(!visible));}
    }
  },[flowFluidContent]);
  useLayoutEffect(()=>{
    if(!fluidEnabled||fluidDesktop)return;
    for(const kind of ['activity','local'] as const){
      const panel=fluidCanvasRef.current?.querySelector<HTMLElement>(`.fluid-${kind}-panel`);
      const open=kind==='activity'?fluidPanels.activityOpen:fluidPanels.localOpen;
      if(panel){panel.inert=!open;panel.setAttribute('aria-hidden',String(!open));}
    }
  },[fluidEnabled,fluidDesktop,fluidPanels.activityOpen,fluidPanels.localOpen]);
  function restoreFluidFocus(kind:'activity'|'local'){
    const canvas=fluidCanvasRef.current,panel=canvas?.querySelector<HTMLElement>(`.fluid-${kind}-panel`);
    if(panel?.contains(document.activeElement))canvas?.querySelector<HTMLButtonElement>(`[data-fluid-trigger="${kind}"]`)?.focus();
  }
  function toggleFluidPanel(kind:'activity'|'local'){
    if(kind==='activity'?fluidPanels.activityOpen:fluidPanels.localOpen)restoreFluidFocus(kind);
    fluidPanels.toggle(kind);
  }
  function touchFluidPanel(kind:'activity'|'local',deliberate=false){
    fluidPanels.interact(kind);
    if(deliberate||fluidEyeOwnerRef.current===kind)focusFluid(kind);
  }
  const fluidInteraction=(kind:'activity'|'local')=>({
    onPointerDownCapture:()=>touchFluidPanel(kind,true),onKeyDownCapture:(event:React.KeyboardEvent<HTMLElement>)=>{if(event.key!=='Tab')touchFluidPanel(kind,true);},onScrollCapture:()=>touchFluidPanel(kind),
    onFocusCapture:(event:React.FocusEvent<HTMLElement>)=>{touchFluidPanel(kind,true);if(event.target.matches('input,textarea,[contenteditable="true"]'))fluidPanels.protectEditing(kind,true);},
    onBlurCapture:(event:React.FocusEvent<HTMLElement>)=>{if(!(event.relatedTarget instanceof Element&&event.currentTarget.contains(event.relatedTarget)&&event.relatedTarget.matches('input,textarea,[contenteditable="true"]')))fluidPanels.protectEditing(kind,false);}
  });

  useLayoutEffect(()=>{
    const input=document.getElementById('one-studio-input');
    if(input instanceof HTMLTextAreaElement){
      // Measure from the compact minimum, rather than the legacy 90px height.
      input.style.height=fluidEnabled?'0px':'auto';
      input.style.height=`${Math.max(fluidEnabled?36:0,Math.min(fluidEnabled?156:180,input.scrollHeight))}px`;
    }
  },[content,view,fluidEnabled]);
  useEffect(() => {
    const previous = motionTasksRef.current; motionTasksRef.current = new Set(executionTasks.map(t=>t.id));
    const eligible=executionTasks.filter(t=>isExecutionRunning(t)&&!stoppedExecutionIdsRef.current.has(t.id)&&!stoppedPreparationIdsRef.current.has(t.dispatchOperationId||'')&&!stoppedPreparationIdsRef.current.has(t.preparationOperationId||''));
    const current=eligible.find(t=>t.id===takeoverTaskId);
    const fresh = current || eligible.find(t=>!previous?.has(t.id)) || eligible[0];
    if (fresh) {
      setTakeoverTaskId(fresh.id);
      if (!executionMode && !preparingExecution) {
        const note=document.querySelector<HTMLElement>(`[data-task-transfer-id="${CSS.escape(fresh.conversationId)}"]`);
        transitionExecutionMode(true,note?pointFromElement(note):executionOriginRef.current);
      }
    }
  }, [executionTasks]);
  useEffect(()=>{
    const state=initialTaskLinkRef.current;
    if(!claimInitialTaskLink(state,{modelsLoaded:models.length>0,demo:demo.enabled,snapshotKnown:coordinator.ready}))return;
    const id=internalTaskId(window.location.href,window.location.href);
    if(!id){settleInitialTaskLink(state,true);return;}
    void openLinkedTask(id).then(opened=>settleInitialTaskLink(state,opened));
  },[models.length,demo.enabled,coordinator.enabled,coordinator.ready]);
  useEffect(()=>{
    if(!coordinator.enabled)return;
    const id=view==='chat'?(workLayer==='things'?thingId:!workLayer?activeId:''):'';
    void coordinator.viewTask(id||null).catch(e=>setError(e instanceof Error?e.message:'暂时无法打开结果'));
  },[coordinator.enabled,coordinator.viewTask,view,workLayer,thingId,activeId]);
  function closeResultLamp() { setResultLampOpen(false); if(coordinator.enabled)void coordinator.acknowledge().catch(e=>setError(e.message)); setDismissedResults(previous=>[...previous,...lampTasks.map(task=>`${task.id}:${task.messages.filter(message=>message.role==='assistant').at(-1)?.id}`)]); }
  async function selectThing(id:string,markRead=true) {
    setThingId(id);
    void loadLatestExecution(id);
    if(coordinator.enabled){try{const detail=await coordinator.viewTask(id);if(detail&&markRead)await coordinator.acknowledge(id);}catch(e){setError(e instanceof Error?e.message:'暂时无法打开结果');}return;}
    await loadThingMessages(id);
  }
  async function removeCoordinatorTask(id:string) {
    await coordinator.removeTask(id);
    setConversations(old=>old.map(c=>c.id===id?{...c,archived:true}:c));
    if(activeId===id)setActiveId('');
    if(thingId===id)setThingId('');
    await refresh();
  }
  function prepareTaskReview(id:string){
    const text='请先核对上一轮实际结果，只继续未完成的部分，不要重复已有修改。补充本轮要求：若本任务是新建文档，同名文件（即使为空）请保留，另存为原名-2、-3等编号版本；允许回读本轮目标文件验证，不读取无关文件。若原任务是修改已有文件，则先核对原目标，不擅自另存或扩大授权。';
    if(preview.enabled){
      setThingDrafts(old=>({...old,[id]:old[id]?.trim()?old[id]:text}));
      void selectThing(id);setTaskScope('tasks');setWorkLayer('things');
      requestAnimationFrame(()=>document.querySelector<HTMLTextAreaElement>('.things-thread textarea')?.focus());return;
    }
    if(currentDraftRef.current.content.trim()){setError('输入框里还有一段没发出的内容，先保留或发完它，再继续这件事。');return;}
    coordinator.dispatch({type:'bind',taskId:id});openSurface('chat');setContent(text);
  }
  function taskPauseNotice(id:string) {
    const task=coordinator.snapshot?.tasks.find(t=>t.id===id);
    const conversation=coordinator.details[id]?.conversation||conversations.find(c=>c.id===id);
    const detail=coordinator.details[id];
    const lastJob=detail?.jobs.at(-1);
    const local=executionForHandoff(executionTasks,id,lastJob?.inputMessageId);
    const localNeedsAction=local&&(['failed','cancelled'].includes(local.status)||executionNeedsReview(local))&&!task?.running&&!task?.queued;
    if(!coordinator.enabled)return null;
    const localInput=unstartedLocalInput(id,detail?.jobs||[],conversation?.messages||[],executionTasks);
    const blockingLocal=localInput&&(executionTasks.find(item=>item.blocksCurrentDevice&&item.conversationId!==id)||executionTasks.find(item=>item.blocksCurrentDevice&&item.conversationId===id));
    const blockerTitle=blockingLocal&&(conversations.find(item=>item.id===blockingLocal.conversationId)?.title||'另一件本机任务');
    if(localInput){
      const blockerActive=isExecutionRunning(blockingLocal||null);
      const blockerReason=blockingLocal?(blockerActive
        ? `「${blockerTitle}」正在这台电脑上执行。`
        : blockingLocal.conversationId===id?'这件事上一轮本机操作的结束情况还没确认。'
          : `「${blockerTitle}」的结束情况还没确认，不表示它是这件事的前置步骤。`):'';
      return <section className="task-recovery" role="status">
        <strong>{blockingLocal?blockerActive?'正在等待这台电脑空闲':'这台电脑还有一轮操作需要确认':'本机这件事还没开始'}</strong>
        <p>{blockingLocal?`${blockerReason}为避免两轮同时改文件，ONE 暂未启动新操作。${executionRecovery(blockingLocal)?.message||'可以等这轮结束；如果不再需要，也可以明确停止原操作。'} 这件事的要求仍保留，其他云端任务不受影响。`:'要求已经保存好了。确认 ONE 已连接后，就可以从这里开始；不会重做其他任务。'}</p>
        {blockingLocal?<>
          <button type="button" onClick={()=>void openLinkedTask(blockingLocal.conversationId)}>查看「{blockerTitle}」</button>
          <button type="button" onClick={()=>void loadLatestExecution(blockingLocal.conversationId,blockingLocal.id,true)}>检查本机状态</button>
          <button type="button" disabled={preparingExecution||Boolean(awaitingExecutionOperationId)} onClick={event=>void cancelExecution(event.currentTarget,blockingLocal)}>{blockerActive?'停止原操作':'再次请求停止原操作'}</button>
        </>:<button type="button" disabled={preparingExecution||executionBusy||taskStatusUnavailable||loadingByConversation[id]} onClick={event=>void executeFromMessage(localInput,event.currentTarget,id)}>{preparingExecution&&preparingConversationId===id?'正在连接本机…':'开始本机任务'}</button>}
      </section>;
    }
    const localRecovery=localNeedsAction?executionRecovery(local):undefined;
    if(local&&localRecovery)return <section className="task-recovery" role="status">
      <strong>{localRecovery.title}</strong><p>{localRecovery.message}</p>
      <button type="button" onClick={()=>{setSelectedExecutionId(local.id);setExpandedExecutionId(local.id);setRevealExecutionId(local.id);void loadLatestExecution(id,local.id);}}>查看本轮操作</button>
      {localRecovery.canContinue?<button type="button" disabled={preparingExecution||executionBusy||taskStatusUnavailable} onClick={event=>void sendExecutionMessage(executionResumeInstruction,local,event.currentTarget,true)}>核对后继续这件事</button>:<>
        <button type="button" onClick={()=>void loadLatestExecution(id,local.id,true)}>检查本机状态</button>
        <button type="button" disabled={preparingExecution||Boolean(awaitingExecutionOperationId)} onClick={event=>void cancelExecution(event.currentTarget,local)}>再次请求停止原操作</button>
      </>}
    </section>;
    if(!(task?.paused||conversation?.workPaused||!task?.running&&(task?.reconciling||task?.state==='reconciling')||localNeedsAction||lastJob?.dependencyBlocked))return task?.running&&lastJob?.progress?.completed.length?<section className="task-recovery" role="status"><strong>正在接着做</strong><p>已做好：{lastJob.progress.completed.join('、')}。{lastJob.progress.pending.length?`正在处理：${lastJob.progress.pending.join('、')}。`:'后续内容还在整理。'}</p></section>:null;
    const error=lastJob?.error;
    const recovery=detail?.recovery;
    if(recovery?.kind==='reconciling')return <section className="task-recovery" role="status"><strong>正在核对保存结果</strong><p>{recovery.message}</p></section>;
    const latest=taskRetryScope(detail?.jobs||[],conversation?.messages.filter(m=>m.role==='user').at(-1)?.content);
    const title=conversation?.title||task?.title||'当前任务';
    const retrying=coordinator.retryingTasks.includes(id);
    const canAdjustBudget=Boolean(lastJob&&lastJob.kind!=='image'&&recovery?.kind==='retry');
    const retryBudget=Number(taskRetryBudgets[lastJob?.id??'']??lastJob?.budget??.5);
    const invalidBudget=canAdjustBudget&&(!Number.isFinite(retryBudget)||retryBudget<.001||retryBudget>10);
    const actionLabel=recovery?.welcomeStep?'继续制作使用说明':recovery?.kind==='review_image'?'重新生成图片':recovery?.kind==='resume'?'开始处理最新要求':lastJob?.progress?.completed.length?'继续未完成的部分':'重新处理最新要求';
    return <section className="task-recovery" role="status">
      <strong>{lastJob?.dependencyBlocked?'在等前面的结果':'还有部分没做好'}</strong><p>{lastJob?.userReport||error||'原要求还在，下面可以查看下一步。'}</p>
      {lastJob?.userReport&&error?<details><summary>查看详细记录</summary><p>{error}</p></details>:null}
      <p>{recovery?.message||'正在读取恢复方式…'}</p>
      {lastJob?.dependencyBlocked?lastJob.waitingFor?.map(parent=><button type="button" key={parent.taskId} onClick={()=>void selectThing(parent.taskId)}>看看「{parent.title}」</button>):null}
      {recovery&&['retry','resume'].includes(recovery.kind)?<p>本轮范围：{latest}</p>:null}
      {canAdjustBudget?<label>这次继续，最多使用多少电力<input aria-label="本次恢复电力上限" type="number" min="0.001" max="10" step="0.001" disabled={retrying} value={taskRetryBudgets[lastJob?.id??'']??lastJob?.budget??.5} onChange={e=>setTaskRetryBudgets(old=>({...old,[lastJob!.id]:e.target.value}))}/><small>这是本次继续的上限，不含以前已用的电力，也不会一次扣完。只补没完成的部分，按实际使用结算。</small></label>:null}
      {recovery&&['retry','resume','review_image'].includes(recovery.kind)?<button type="button" disabled={retrying||Boolean(invalidBudget)} onClick={()=>{
        const price=detail?.jobs.at(-1)?.retryPower;
        if(recovery.kind==='review_image'&&!(typeof price==='number'&&(price>0||price===0&&recovery.welcomeStep==='page'))){setError('这次图片价格还没确认，请稍后刷新任务再试。');return;}
        if(confirm(`${actionLabel} · ${title}\n本轮范围：${latest.slice(0,480)}\n${recovery.welcomeStep?`只补未完成的步骤，最多使用 ${price!.toLocaleString('zh-CN',{maximumFractionDigits:6})} 电力，按实际用量结算；已保存的说明和图片会复用。`:recovery.kind==='review_image'?`这次新生成一张图片，使用 ${price!.toLocaleString('zh-CN',{maximumFractionDigits:6})} 电力；已有结果和历史都会保留。`:canAdjustBudget?`本次继续最多使用 ${retryBudget} 电力，不含以前已用的电力，按实际用量结算。将沿用原附件和功能，只补未完成部分。`:'沿用原上限开始处理最新要求，不重复已有成果。'}`))void coordinator.retryTask(id,canAdjustBudget?retryBudget:undefined,lastJob?.id).then(()=>refresh()).catch(e=>setError(e.message));
      }}>{retrying?'正在恢复…':actionLabel}</button>:null}
      {recovery?.kind==='review_notion'?<NotionReceiptNotice api={api} taskId={id} receipt={notionReceiptForReview(detail?.jobs||[])?.notionReceipt} onRefresh={()=>coordinator.load(id,true)} />:null}
{localNeedsAction?<><p>{local.status==='cancelled'?'这轮已经停下，不会自己再启动。':'这轮本机操作还没完成。'}先看看操作记录；想接着做，可以回到这件事补一句要求，ONE 会先核对已有结果。</p><button type="button" onClick={()=>{setSelectedExecutionId(local.id);setExpandedExecutionId(local.id);setRevealExecutionId(local.id);void loadLatestExecution(id,local.id);}}>查看本轮操作</button><button type="button" onClick={()=>prepareTaskReview(id)}>核对后继续这件事</button></>:null}
      {!detail?<button type="button" onClick={()=>void coordinator.load(id).catch(e=>setError(e.message))}>查看恢复方式</button>:null}
    </section>;
  }
  async function loadThingMessages(id:string, force=false) {
    const item=conversations.find(conversation=>conversation.id===id);
    if(coordinator.enabled){try{await coordinator.load(id);}catch(err){setError(err instanceof Error?err.message:'暂时无法打开');}return;}
    if (!item || (!force && item.messagesLoaded) || demo.enabled) return;
    try { const result=await api<{conversation:Conversation}>(`/api/conversations/${encodeURIComponent(id)}`); setConversations(previous=>previous.map(conversation=>conversation.id===id?{...result.conversation,messagesLoaded:true}:conversation)); } catch(err) {setError(err instanceof Error?err.message:'暂时无法打开');}
  }
  async function continueThing(id: string, text: string) {
    if (demo.enabled) { demo.dispatch({type:'task-send',taskId:id,text,id:crypto.randomUUID(),now:Date.now()}); return; }
    const task = conversations.find(conversation => conversation.id === id);
    if (!task) throw new Error('这件事已不可用，请重新打开');
    const destination=thingDestinations[id]||'chat';
    if (destination === 'local') { await executeDraft(text, document.getElementById('one-things-send')!, id); return; }
    if (coordinator.enabled && models.find(model => model.id === task.modelId)?.kind !== 'image') {
      await coordinator.direct(id, text, [], destination === 'notion' ? 'notion' : 'chat');
      return;
    }
    if (destination === 'notion') throw new Error('Notion 写入需要启用 ONE 持续对话');
    const conversation = await sendThingMessage<Conversation>(api, user.id, {conversationId:id,modelId:task.modelId,agentId:task.agentId,content:text.trim()});
    setConversations(old => old.map(item => item.id === id ? {...conversation,messagesLoaded:true} : item));
    setPendingRequests(pendingChatSubmissions(user.id));
  }
  useEffect(() => { if (demo.enabled) demo.dispatch({type:'draft',text:content}); }, [demo.enabled, content]);
  const coordinatorErrorRef = useRef("");
  useEffect(()=>{
    if(coordinator.error) setError(coordinator.error);
    else if(coordinatorErrorRef.current) { const previous=coordinatorErrorRef.current; setError(old=>old===previous?"":old); }
    coordinatorErrorRef.current=coordinator.error;
  },[coordinator.error]);
  useEffect(() => { if (preview.enabled && preview.state.selected && !activeId) setActiveId(preview.state.selected); }, [preview.enabled, preview.state.selected, activeId]);

  function announceTask(item: TaskNotice) {
    const read = shouldAutoReadTaskNotice(resolvedDraftKey(viewedConversationRef.current), item.conversationId, document.visibilityState === "visible");
    setTaskNotices(items => [{ ...item, read }, ...items.filter(previous => previous.conversationId !== item.conversationId)].slice(0, 12));
    setVisibleReceiptId(item.id);
  }

  function acknowledgeConversation(conversationId: string) {
    setTaskNotices(items => items.filter(item => item.conversationId !== conversationId));
  }

  async function readAllTaskMessages() {
    const capturedNoticeIds=new Set(taskNotices.map(item=>item.id));
    if (coordinator.enabled) await coordinator.readAll();
    setTaskNotices(items => readCapturedNotices(items,capturedNoticeIds));
    if (demo.enabled) closeResultLamp();
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
    const [modelResult, conversationResult, workspaceResult, agentResult, capabilityResult, knowledgeResult, notionResult, yinxiangResult, flowusResult, flomoResult] = await Promise.all([
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
      api<{ connection: KnowledgeConnection; configured: boolean }>("/api/knowledge/connections/flowus").catch(keep({ connection: flowusConnection, configured: false })),
      api<{ connection: KnowledgeConnection; configured: boolean }>("/api/knowledge/connections/flomo").catch(keep({ connection: flomoConnection, configured: false }))
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
    setFlomoConnection(flomoResult.connection);
    setDraftModelId((current) => (
      modelResult.models.some((model) => model.id === current)
        ? current
        : modelResult.defaultModelId || modelResult.models[0]?.id || ""
    ));
  }

  async function refreshRuntimeUpdate(manual = false) {
    if (runtimeCheck.current.pending || runtimeCheck.current.dispatching) {
      if (manual) setRuntimeCheckFeedback("正在查询，请稍候；不会重复安装");
      return;
    }
    if (manual) { setRuntimeChecking(true); setRuntimeCheckFeedback("正在查询当前账号的启动器…"); }
    runtimeCheck.current.pending = true;
    const generation = runtimeCheck.current.generation;
    try {
      const result = await api<RuntimeUpdateStatus>("/api/runtime/update", { signal: AbortSignal.timeout(10_000) });
      if (runtimeCheck.current.dispatching || generation !== runtimeCheck.current.generation) return;
      const view = runtimeUpdateView(result, runtimeCheck.current.active);
      runtimeCheck.current.lastSuccess = Date.now();
      runtimeCheck.current.active = view.busy;
      setRuntimeUpdate(result);
      setRuntimeUpdating(view.busy);
      setRuntimeUpdateIssue(view.issue);
      if (manual) setRuntimeCheckFeedback(`已检查 · ${new Date().toLocaleTimeString()} · ${result.available ? "运行版本尚未更新；本按钮只查询状态" : "已运行最新版"}`);
    } catch (checkError) {
      if (generation !== runtimeCheck.current.generation) return;
      if (manual) setRuntimeCheckFeedback(runtimeCheck.current.active ? "新版连接尚未确认，正在自动检查；请保持 Key 插入" : checkError instanceof Error ? checkError.message : "状态查询失败，请检查网络和 Key 连接");
      // A lost connection is not evidence of a failed install. Offer a status
      // check, never silently send a second install into an uncertain first one.
      if (runtimeCheck.current.active && Date.now() - runtimeCheck.current.lastSuccess >= 30_000) {
        setRuntimeUpdating(false);
        setRuntimeUpdateIssue("正在自动恢复连接，请保持 ONE Key 插入；无需重复安装。");
      }
    } finally {
      runtimeCheck.current.pending = false;
      if (manual) setRuntimeChecking(false);
    }
  }

  async function installRuntimeUpdate() {
    if (runtimeCheck.current.dispatching) return;
    runtimeCheck.current.generation++;
    runtimeCheck.current.dispatching = true;
    setRuntimeUpdating(true);
    setRuntimeUpdateIssue("");
    setRuntimeCheckFeedback("");
    runtimeCheck.current.active = true;
    runtimeCheck.current.lastSuccess = Date.now();
    setError("");
    try {
      const result = await api<{ progress: NonNullable<RuntimeUpdateStatus["progress"]> }>("/api/runtime/update", { method: "POST", signal: AbortSignal.timeout(10_000) });
      setRuntimeUpdate(current => current ? { ...current, progress: result.progress } : current);
    } catch (updateError) {
      setRuntimeUpdating(false);
      setRuntimeUpdateIssue("请检查更新状态后再试");
      setError(updateError instanceof Error ? updateError.message : "更新没有开始，请重试");
    } finally {
      runtimeCheck.current.dispatching = false;
    }
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
    void refreshExecutionTasks();
    void refreshRuntimeUpdate();
  }, [showArchived]);

  useEffect(() => {
    if (!runtimeUpdating && !runtimeUpdateIssue) return;
    const timer = window.setInterval(() => void refreshRuntimeUpdate(), runtimeUpdating ? 2500 : 10_000);
    return () => window.clearInterval(timer);
  }, [runtimeUpdating, runtimeUpdateIssue]);

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
  function rememberReconciledExecution(task: ExecutionTask, events: ExecutionEvent[]) {
    rememberExecution(task,events);
    void refreshExecutionTasks();
    if(coordinator.enabled)void coordinator.load(task.conversationId,true).catch(error=>setError(error instanceof Error?error.message:'操作记录已返回，任务页面暂未刷新；请检查最新状态，不要重复操作。'));
  }

  async function refreshExecutionTasks() {
    try {
      const result = await api<{ tasks: ExecutionTask[] }>("/api/executions");
      setExecutionTasks(current => mergeTaskSnapshots(current, result.tasks));
      setTaskStatusUnavailable(false);
    } catch { setTaskStatusUnavailable(true); }
  }

  useEffect(() => {
    if (!coordinator.enabled && !liveTaskIds) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshExecutionTasks();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [coordinator.enabled, liveTaskIds]);

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
      void loadThingMessages(task.conversationId, true);
    }, task.status === "completed" ? 1100 : 700);
    return () => window.clearTimeout(timer);
  }, [executionTasks, executionMode, takeoverTaskId, preparingExecution]);

  useEffect(() => {
    const outcome = executionHandoffOutcome(awaitingExecutionOperationId, coordinator.settlement);
    if (outcome === 'pending') return;
    setAwaitingExecutionOperationId('');
    // A clarification or failed dispatch is not a running local execution.
    if (outcome === 'not_started') transitionExecutionMode(false, executionOriginRef.current);
  }, [coordinator.settlement, awaitingExecutionOperationId]);

  async function loadLatestExecution(conversationId: string, selectedTaskId = "", reportStatus = false) {
    if (conversationId.startsWith("tmp_")) return;
    try {
      const result = await api<{ tasks: ExecutionTask[] }>(`/api/executions?conversationId=${encodeURIComponent(conversationId)}`);
      const latest = selectConversationExecution(result.tasks, conversationId, selectedTaskId);
      result.tasks.forEach(task => rememberExecution(task));
      const detailId = selectedTaskId || latest?.id;
      if (!detailId) return;
      const detail = await api<{ task: ExecutionTask; events: ExecutionEvent[] }>(`/api/executions/${encodeURIComponent(detailId)}`);
      rememberExecution(detail.task, detail.events);
      if(reportStatus)setNotice(`本机状态已更新：${executionRecovery(detail.task)?.title||executionStatusLabel(detail.task)}。`);
    } catch (error) { if(reportStatus)setError(error instanceof Error?error.message:'暂时连不上本机状态，请检查 ONE Key 连接后再试。'); }
  }

  function pointFromElement(element?: HTMLElement | null): TransitionPoint {
    if (!element) return executionOriginRef.current;
    const pointer = executionPointerRef.current;
    executionPointerRef.current = null;
    if (pointer && element.contains(pointer.element)) return pointer.point;
    const bounds = element.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  }

  function transitionExecutionMode(next: boolean, source?: HTMLElement | TransitionPoint | null) {
    delete document.documentElement.dataset.oneTransition;
    document.documentElement.dataset.oneExecutionTransition = next ? 'enter' : 'exit';
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
        { clipPath: (next ? [0, radius] : [radius, 0]).map(r => `circle(${r}px at ${point.x}px ${point.y}px)`) },
        {
          duration: next ? 430 : 380,
          easing: next ? "cubic-bezier(.2,.82,.2,1)" : "cubic-bezier(.3,.72,.2,1)",
          fill: "both",
          pseudoElement: next ? "::view-transition-new(root)" : "::view-transition-old(root)"
        } as KeyframeAnimationOptions & { pseudoElement: string }
      );
    }).catch(() => undefined);
  }

  function transitionInterface(update: () => void, route: EyeRoute = 'direct', conversationShelfMove=false) {
    if(fluidEnabled){update();return Promise.resolve();}
    delete document.documentElement.dataset.oneExecutionTransition;
    delete document.documentElement.dataset.oneTransition;
    delete document.documentElement.dataset.oneRoute;
    eyeMotion.current!.move(()=>flushSync(update), conversationShelfMove ? 'direct' : route, conversationShelfMove ? 700 : 1100);
    return Promise.resolve();
  }

  function switchDraft(key: string) {
    if (preview.enabled) return;
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
    if (preview.enabled) preview.dispatch({type:'bind',taskId:null});
    switchDraft("new");
    setComposeNew(true);
    requestAnimationFrame(() => document.getElementById("one-studio-input")?.focus());
  }

  function closeWorkLayer(){
    setWorkLayer(null);
    knowledgeReturnRef.current={notion:null,provider:null,status:null};
  }
  function chooseFeature(feature:FeatureChoice,source?:HTMLElement){
    const next=featureSelectionTransition(selectedFeaturesRef.current,feature);
    if(next.action==='limit'){setFeatureSelectionNotice('每条消息最多使用 8 个功能。先取消一个，再加入新的。');return;}
    const transfer=next.action==='added'&&preview.enabled?captureFeatureHandoff(feature,source):null;
    selectedFeaturesRef.current=next.features;setFeatureForNext(next.features);setFeatureSelectionNotice('');
    if(next.action==='removed'){setFeatureTransfer(current=>current?.featureId===feature.id?null:current);return;}
    if(transfer)setFeatureTransfer(transfer);
    else if(preview.enabled){
      setFeatureTransfer(null);
      pulseFeatureComposer(document.querySelector<HTMLElement>('.studio-composer .composer-energy-shell'));
    }
  }
  function openHistory(){
    if(preview.enabled){setWorkLayer('history');setView('chat');setHistoryOpen(false);}
    else setHistoryOpen(value=>!value);
  }
  function updateFeatureRun(run:FeatureRunSummary){setFeatureRuns(old=>[run,...old.filter(item=>item.operationId!==run.operationId)].slice(0,8));setFeatureRunIssue('');}
  function openFeatureRun(operationId:string){setFeatureOperationId(operationId);openSurface('features');}
  function openSurface(next: "chat" | "things" | "admin" | "company" | "knowledge" | "account" | "features",taskId?:string) {
    featurePicker.close();
    if(preview.enabled&&next!=='chat'){
      if(next==='admin'&&user.role!=='admin'||next==='company'&&user.access?.role!=='company_admin')return;
      if(next==='knowledge')setAccountSection('knowledge');
      if(next==='things'){
        setTaskScope('tasks');
        const selected=taskEntrySelection(thingItems(),taskId||thingId);
        // Select before mounting the work layer so it has one split destination.
        // Merely opening the task overview never consumes unread receipts.
        if(selected)void selectThing(selected,Boolean(taskId&&selected===taskId));else setThingId('');
      }
      setWorkLayer(next==='knowledge'?'account':next);
      setHistoryOpen(false);
      if(view!=='chat')setView('chat');
      return;
    }
    closeWorkLayer();
    transitionInterface(() => {
      if(next==='chat'&&preview.enabled){setPreviewHome(false);setActiveId('');setFocusedTask(false);preview.dispatch({type:'select',taskId:null});preview.dispatch({type:'bind',taskId:null});}
      if (next === "knowledge") setAccountSection("knowledge");
      setView(next === "knowledge" ? "account" : next);
      setHistoryOpen(false);
      setSidebarOpen(false);
    }, eyeRoute(view,next==='knowledge'?'account':next,studioIdle),preview.enabled&&isConversationShelfMove(view,next,studioIdle));
  }

  async function loadMoreConversations() {
    if(coordinator.enabled && (coordinator.snapshot?.total??0)>coordinator.state.tasks.length)await coordinator.loadMore();
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
    if (preview.enabled) { setTaskScope('tasks');setSelectedExecutionId(selectedTaskId);void selectThing(conversation.id);setWorkLayer('things');setView('chat');setActivityExpanded(false);setHistoryOpen(false);return; }
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

  async function openLinkedTask(id:string) {
    try {
      const current=conversations.find(c=>c.id===id);
      const conversation=current||((coordinator.enabled?await coordinator.load(id):await api<{conversation:Conversation}>(`/api/conversations/${encodeURIComponent(id)}`)).conversation);
      if(!current)setConversations(old=>[{...conversation,messagesLoaded:true},...old.filter(c=>c.id!==id)]);
      await openConversation(conversation);
      return true;
    } catch(e) {setError(e instanceof Error?e.message:'无法打开此任务，请从任务列表查看');return false;}
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
    closeWorkLayer();
    if (preview.enabled) { preview.dispatch({type:'select',taskId:null}); preview.dispatch({type:'bind',taskId:null}); }
    switchDraft("new");
    transitionInterface(() => {
      if(preview.enabled)setPreviewHome(true);
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
    closeWorkLayer();
    switchDraft("new");
    transitionInterface(() => {
      setActiveId("");
      setComposeNew(true);
      setPreviewHome(false);
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
    if (files.length > remaining) { setError(`本条消息还可以添加 ${remaining} 个附件`); return; }
    const selected = Array.from(files);
    for (const file of selected) {
      const limit = file.type.startsWith("image/") ? capabilities.attachments.imageMaxBytes || 20 * 1024 * 1024 : capabilities.attachments.maxBytes;
      if (!file.size || file.size > limit) { setError(`${file.name}：请选择不超过 ${Math.round(limit / 1024 / 1024)} MB 的文件`); return; }
    }
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
    const updateDraft = (attachment: AttachmentSummary, remove = false) => {
      const key = resolvedDraftKey(uploadDraftKey);
      const isCurrent = resolvedDraftKey(composeKeyRef.current) === key;
      const draft = isCurrent ? currentDraftRef.current : draftsRef.current[key] || { content: "", attachments: [] };
      const attachments = remove ? draft.attachments.filter(a => a.id !== attachment.id) : draft.attachments.some(a => a.id === attachment.id) ? draft.attachments.map(a => a.id === attachment.id ? attachment : a) : [...draft.attachments, attachment];
      draftsRef.current[key] = { ...draft, attachments };
      if (isCurrent) { currentDraftRef.current = { ...draft, attachments }; setPendingAttachments(attachments); }
    };
    setUploadingAttachments(true);
    setError("");
    try {
      for (const file of selected) {
        const created = await api<{ attachment: AttachmentSummary; chunkBytes: number }>("/api/attachments/uploads", { method: "POST", body: JSON.stringify({ filename: file.name, size: file.size, mimeType: file.type }) });
        let item = created.attachment;
        updateDraft(item);
        try {
          let offset = item.uploadedBytes || 0;
          while (offset < file.size) {
            let completed = false;
            for (let attempt = 0; attempt < 3 && !completed; attempt++) {
              try {
                const result = await api<{ uploadedBytes: number }>(`/api/attachments/${item.id}/chunks?offset=${offset}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(offset, offset + created.chunkBytes) });
                offset = result.uploadedBytes; completed = true;
              } catch (error) {
                if (attempt === 2 || error instanceof ApiError && [401, 403, 409, 428].includes(error.status || 0)) throw error;
                await new Promise(resolve => setTimeout(resolve, 700 * (attempt + 1)));
                const current = await api<{ attachment: AttachmentSummary }>(`/api/attachments/${item.id}`);
                offset = current.attachment.uploadedBytes || 0;
                if (offset >= file.size) completed = true;
              }
            }
            item = { ...item, uploadedBytes: offset }; updateDraft(item);
          }
          await api(`/api/attachments/${item.id}/complete`, { method: "POST" });
          updateDraft({ ...item, status: "queued" });
        } catch (error) {
          updateDraft(item, true);
          await api(`/api/attachments/${item.id}`, { method: "DELETE" }).catch(() => undefined);
          throw error;
        }
      }
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

  async function retryAttachment(attachment: AttachmentSummary) {
    try {
      setError("");
      await api(`/api/attachments/${attachment.id}/retry`, { method: "POST" });
      setPendingAttachments(items => items.map(a => a.id === attachment.id ? { ...a, status: "queued", parseError: undefined } : a));
    } catch (error) { setError(error instanceof Error ? error.message : "重试失败"); }
  }

  useEffect(() => {
    const ids = pendingAttachments.filter(a => a.status === "queued" || a.status === "parsing").map(a => a.id);
    if (!ids.length) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const results = await Promise.allSettled(ids.map(id => api<{ attachment: AttachmentSummary }>(`/api/attachments/${id}`)));
      if (cancelled) return;
      const updated = new Map(results.flatMap(r => r.status === "fulfilled" ? [[r.value.attachment.id, r.value.attachment] as const] : []));
      const failed = [...updated.values()].filter(a => a.status === "failed");
      if (failed.length) setError(failed.map(a => `${a.originalName}：${a.parseError || "解析失败，请重试"}`).join("；"));
      if (updated.size) setPendingAttachments(items => items.map(a => updated.get(a.id) || a));
      else timer = setTimeout(() => { void poll(); }, 3000);
    };
    timer = setTimeout(() => { void poll(); }, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pendingAttachments, api]);

  async function sendMessage(rawText: string, localExecution = false) {
    featurePicker.close();
    if (demo.enabled) { if (demo.state.pending || !rawText.trim()) return; setPreviewHome(false); demo.dispatch({type:'submit',text:rawText,features:featureForNext,id:crypto.randomUUID(),now:Date.now()});setFeatureForNext([]);setContent('');setHasSubmittedChat(true);return; }
    // Preserve specialized image and newly selected personal-assistant routes.
    // Neither is silently reinterpreted as a generic coordinator request.
    if(coordinator.enabled && currentModel?.kind !== 'image' && !(composeNew && draftAgentId)){
      if(uploadingAttachments||pendingAttachments.some(a=>a.status&&a.status!=='ready')){setError('请等待附件解析完成');return;}
      if(coordinator.state.pending||(!rawText.trim()&&!pendingAttachments.length))return;
      const text=rawText.trim()||(pendingAttachments.length?'请分析上传的附件。':''),files=[...pendingAttachments],features=[...featureForNext];
      coordinatorFailedDraft.current={text,files,features};
      try{
        let confirmedExternal=false;
        if(features.length){const details=await Promise.all(features.map(f=>api<{name:string;usageMultiplier:number;destinations:string[]}>(`/api/features/${encodeURIComponent(f.id)}`)));confirmedExternal=confirm(`使用 ${details.map(f=>`${f.name}（${f.usageMultiplier??.6} 倍）`).join('、')}。\n${details.flatMap(f=>f.destinations).length?'任务所需内容将发送至：'+[...new Set(details.flatMap(f=>f.destinations))].join('、'):'按需使用你已连接的知识来源'}\n各功能按实际用量分别扣除 ONE 额度，再相加。是否继续？`);if(!confirmedExternal)return false;}
        const featureApprovals=features.length||coordinator.state.boundTask?await approveFeaturePrices(api,features.map(f=>f.id),coordinator.state.boundTask||undefined):[];
        if(localExecution&&executionPreparationRef.current?.cancelled)return false;
        setError('');setPreviewHome(false);setHasSubmittedChat(true);
        if (!localExecution) executionOriginRef.current = pointFromElement(document.getElementById('one-studio-send'));
        // Capture the sent content now; a new draft must never be cleared by a late receipt.
        if(currentDraftRef.current.content===rawText)setContent('');
        setPendingAttachments(old=>old.filter(file=>!files.some(sent=>sent.id===file.id)));setFeatureForNext(old=>old.filter(feature=>!features.some(sent=>sent.id===feature.id)));
        if(localExecution&&executionPreparationRef.current?.cancelled)return false;
        const submissionId=crypto.randomUUID();
        if(localExecution&&executionPreparationRef.current){executionPreparationRef.current.operationId=submissionId;executionPreparationRef.current.coordinator=true;}
        const operationId = await coordinator.submit({operationId:submissionId,text,localExecution,outputDestination:localExecution?undefined:outputDestination==='notion'?'notion':'chat',modelId:draftModelId,attachmentIds:files.map(f=>f.id),featureIds:features.map(f=>f.id),featureApprovals,confirmedExternal,webSearch:canSearch,boundTaskId:coordinator.state.boundTask||undefined});
        coordinatorFailedDraft.current=null;
        if (localExecution && !executionPreparationRef.current?.cancelled) setAwaitingExecutionOperationId(operationId);
        return true;
      }catch(err){setError(err instanceof Error?err.message:'暂时无法确认，请检查状态；不会重复执行');if(localExecution)throw err;}return false;
    }
    if (uploadingAttachments || pendingAttachments.some(a => a.status && a.status !== "ready")) { setError("请等待附件解析完成，或移除失败的附件"); return; }
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
    setHasSubmittedChat(true);
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
      let result = await api<{ conversation: Conversation; knowledgeWarning?: string; pending?: boolean }>("/api/chat", {
        method: "POST",
        body: JSON.stringify({ ...payload, operationId })
      });
      while (result.pending) {
        await new Promise(resolve => setTimeout(resolve, 2500));
        try { result = await api<typeof result>(`/api/chat/operations/${encodeURIComponent(operationId)}`); }
        catch (error) { if (!(error instanceof ApiError) || error.code !== "CHAT_OPERATION_PENDING") throw error; }
      }
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
      if(coordinator.enabled && models.find(m=>m.id===result.conversation.modelId)?.kind==='chat'){
        coordinator.dispatch({type:'bind',taskId:result.conversation.id});
        coordinator.dispatch({type:'select',taskId:result.conversation.id});
      }
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
    if (composeMode === 'chat' && outputDestination === 'local') {
      await executeDraft(content, document.getElementById('one-studio-send')!, coordinator.enabled ? undefined : targetConversation?.id); return;
    }
    if (outputDestination === 'notion' && !coordinator.enabled) { setError('Notion 写入需要启用 ONE 持续对话，请管理员检查配置'); return; }
    if (preview.enabled) { await sendMessage(content); return; }
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
    if (event.defaultPrevented || featurePicker.keyDown(event)) return;
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

  async function executeFromMessage(message: Message, source?: HTMLElement | null, conversationId = active?.id) {
    if (!conversationId || conversationId.startsWith("tmp_") || !message.id || preparingExecution || executionBusy || loadingByConversation[conversationId] || taskStatusUnavailable) return;
    const origin = pointFromElement(source);
    const preparation={cancelled:false,operationId:undefined as string|undefined};executionPreparationRef.current=preparation;
    executionOriginRef.current = origin;
    setPreparingExecution(true);
    setPreparingConversationId(conversationId);
    setTakeoverTaskId("");
    setExecutionSourceMessageId(message.id);
    setExpandedExecutionId("");
    setError("");
    transitionExecutionMode(true, origin);
    try {
      preparation.operationId=await chatSubmission(`execution:${user.id}`, { conversationId, sourceMessageId: message.id });
      if(preparation.cancelled)return;
      const result = await api<{ task: ExecutionTask; events: ExecutionEvent[] }>("/api/executions/from-message", {
        method: "POST",
        body: JSON.stringify({ conversationId, sourceMessageId: message.id, operationId: preparation.operationId })
      });
      if(preparation.cancelled){return;}
      stoppedExecutionIdsRef.current.delete(result.task.id);
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

  async function executeDraft(rawText: string, source: HTMLElement, conversationId?: string) {
    if (!rawText.trim() || preparingExecution || executionBusy || taskStatusUnavailable) return;
    executionOriginRef.current = pointFromElement(source);
    const preparation={cancelled:false,operationId:undefined as string|undefined,coordinator:false};executionPreparationRef.current=preparation;
    if (!conversationId && coordinator.enabled) {
      setTakeoverTaskId(''); setPreparingExecution(true);
      transitionExecutionMode(true, executionOriginRef.current);
      try {
        if (!await sendMessage(rawText, true)) transitionExecutionMode(false, executionOriginRef.current);
        else if(!preparation.cancelled)await refreshExecutionTasks();
      }
      catch { transitionExecutionMode(false, executionOriginRef.current); }
      finally { setPreparingExecution(false); }
      return;
    }
    if (!conversationId) { setError('请先打开一件事情，或启用持续对话调度后执行'); return; }
    setPreparingExecution(true); setPreparingConversationId(conversationId); setError(''); setTakeoverTaskId('');
    transitionExecutionMode(true, executionOriginRef.current);
    try {
      const operationId = await chatSubmission(`execution-input:${user.id}`, { conversationId, content: rawText.trim() });
      preparation.operationId=operationId;if(preparation.cancelled)return;
      const result = await api<{task:ExecutionTask;events:ExecutionEvent[]}>('/api/executions/from-input', { method:'POST', body:JSON.stringify({conversationId,content:rawText.trim(),operationId}) });
      if(preparation.cancelled)return;
      stoppedExecutionIdsRef.current.delete(result.task.id);
      rememberExecution(result.task,result.events); setTakeoverTaskId(result.task.id); setSelectedExecutionId(result.task.id);
      if (view === 'things') { setThingDrafts(old => ({...old,[conversationId]:old[conversationId] === rawText ? '' : old[conversationId]})); }
      else if (currentDraftRef.current.content === rawText) setContent('');
      await loadThingMessages(conversationId, true);
    } catch (e) { transitionExecutionMode(false, executionOriginRef.current); setError(e instanceof Error ? e.message : '执行未确认，原话保留'); if (view === 'things') throw e; }
    finally { setPreparingExecution(false); setPreparingConversationId(''); }
  }

  async function sendExecutionMessage(rawText: string, targetTask = executionTask, source?: HTMLElement, preserveDraft = false) {
    const text = rawText.trim();
    if (!targetTask || !executionCanContinue(targetTask) || !text || executionBusy || preparingExecution || taskStatusUnavailable) return;
    const originalDraftKey = composeKeyRef.current;
    const preparation={cancelled:false,operationId:crypto.randomUUID()};executionPreparationRef.current=preparation;
    const request=executionContinuationRequest(targetTask,preparation.operationId,text);
    if(!request)return;
    if(!preserveDraft)setContent("");
    setError("");
    setPreparingExecution(true);
    setPreparingConversationId(targetTask.conversationId);
    transitionExecutionMode(true, source || document.getElementById("one-studio-send"));
    try {
      const result = await api<{ task: ExecutionTask }>(request.path, {
        method: "POST",
        body: JSON.stringify(request.body)
      });
      if(preparation.cancelled)return;
      stoppedExecutionIdsRef.current.delete(result.task.id);
      setTakeoverTaskId(result.task.id);
      rememberExecution(result.task);
      setEventsByTask(items => ({ ...items, [result.task.id]: [] }));
      setComposeMode("chat");
    } catch (err) {
      if(!preserveDraft){
        const key = resolvedDraftKey(originalDraftKey);
        const isCurrent = resolvedDraftKey(composeKeyRef.current) === key;
        const recovered = recoverTaskDraft({ content: text, attachments: [] as AttachmentSummary[] }, isCurrent ? currentDraftRef.current : draftsRef.current[key]);
        draftsRef.current[key] = recovered;
        if (isCurrent) { setContent(recovered.content); setPendingAttachments(recovered.attachments); }
      }
      transitionExecutionMode(false);
      setError(err instanceof Error ? err.message : "无法继续本机任务");
    } finally {
      setPreparingExecution(false);
      setPreparingConversationId("");
    }
  }

  async function cancelExecution(source?: HTMLElement | null, task = executionTask) {
    const preparation=executionPreparationRef.current;
    if((preparingExecution||awaitingExecutionOperationId)&&preparation){
      preparation.cancelled=true;if(preparation.operationId)stoppedPreparationIdsRef.current.add(preparation.coordinator?`local_${preparation.operationId}`:preparation.operationId);setAwaitingExecutionOperationId('');transitionExecutionMode(false,pointFromElement(source));
      try{if(preparation.operationId){if(preparation.coordinator)await api(`/api/coordinator/messages/${encodeURIComponent(preparation.operationId)}/stop`,{method:'POST'});else await api(`/api/executions/preparation/${encodeURIComponent(preparation.operationId)}/cancel`,{method:'POST'});}setNotice('已请求停止，原始要求保留；已产生的修改不会自动撤销。');}
      catch(err){setError(err instanceof Error?err.message:'停止未确认，请检查任务状态');}
      return;
    }
    if (!task || !isExecutionRunning(task) && !task.resultDeliveryPending) return;
    const request=executionCancellationRequest(task);
    if(!request){setError('本机操作的轮次暂时无法确认，请先检查本机状态。');return;}
    stoppedExecutionIdsRef.current.add(task.id);
    const isCurrentTakeover=!takeoverTaskId||task.id===takeoverTaskId||!runningExecutions.some(t=>t.id!==task.id);
    if(isCurrentTakeover)transitionExecutionMode(false,executionOriginRef.current);
    try {
      await api(request.path, { method: "POST", body:JSON.stringify(request.body) });
      if(isCurrentTakeover)transitionExecutionMode(false,executionOriginRef.current);
      void refreshExecutionTasks();
    } catch (err) { stoppedExecutionIdsRef.current.delete(task.id);setError(err instanceof Error ? err.message : "无法停止执行");void refreshExecutionTasks(); }
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

  const thinkingConversations = conversations.filter(item => preview.enabled ? preview.state.tasks.some(task=>task.id===item.id&&task.status==='running') : loadingByConversation[item.id]);
  const composerTarget = composeNew || !active ? "新事情" : active.title;
  const unreadNotices = taskNotices.filter(item => !item.read);
  const activityRows = buildTaskActivityRows(conversations, executionTasks, new Set(thinkingConversations.map(item => item.id)), failedTaskIds, new Set(unreadNotices.map(item => item.conversationId)));
  const otherRows = activityRows.filter(item => view !== "chat" || item.conversationId !== activeId || item.unread);
  const activeOthers = otherRows.filter(item => item.status === "running" || item.status === "thinking");
  const settledOthers = otherRows.filter(item => item.status !== "running" && item.status !== "thinking");
  const latestTurnStart = Math.max(0, (active?.messages || []).map(message => message.role).lastIndexOf("user"));
  const replyPending=waitingForCurrentReply(activeLoading,active?.messages??[]);
  const currentStatus = activePreparing ? "正在连接" : currentRunningExecution ? "本机执行中" : activeLoading ? replyPending?'准备回复中':'正在回复' : failedTaskIds.has(activeId) ? "待重试" : executionNeedsReview(executionTask) ? "本轮未完成 · 查看下一步" : executionTask?.status === "completed" ? "本机已完成" : executionTask?.status === "cancelled" ? "本机已停止" : executionTask?.status === "failed" ? "本轮未完成 · 查看原因" : "当前任务";
  const currentBusy = activePreparing || Boolean(currentRunningExecution) || activeLoading;

  function activityLabel(row: TaskActivityRow) {
    if (row.status !== "running" && row.status !== "thinking" && !failedTaskIds.has(row.conversationId) && row.unread && taskNotices.some(item => item.conversationId === row.conversationId && item.outcome === "reply")) return "有新回复";
    return ({ running: "本机执行中", thinking: "准备回复中", failed: "未完成", completed: "已完成", cancelled: "已停止", recent: row.unread ? "有新回复" : "继续聊" })[row.status];
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

  function renderAttentionInbox(){return <>
        {!demo.enabled?<AttentionInbox key={user.id+user.defaultWorkspaceId} api={api} onCountChange={setAttentionCount} onDraft={text=>{if(currentDraftRef.current.content.trim())return false;setContent(text);if(fluidPanels.activityOpen)fluidPanels.toggle('activity');focusFluid('main');requestAnimationFrame(()=>document.getElementById('one-studio-input')?.focus());return true;}}/>:null}
    </>;}

  function renderGuideDelivery(){return <>
        {delivery&&delivery.operationId!==dismissedDelivery&&view==='chat'&&(storyHidden||profile.onboarding.journey?.stage==='complete')?<WelcomeDelivery delivery={delivery} busy={deliveryBusy} error={deliveryError} onOpen={id=>void api<{conversation:Conversation}>(`/api/conversations/${encodeURIComponent(id)}`).then(result=>openConversation(result.conversation)).catch(e=>setDeliveryError(e.message))} onCheck={()=>void checkWelcome()} onRetry={()=>void retryWelcome()} onDismiss={dismissWelcome}/>:null}
        {!delivery&&handbookNotice && view==='chat' ? <p className="one-onboarding-handbook-notice" role="status">{handbookNotice}{storyTaskId?<button type="button" onClick={()=>void api<{conversation:Conversation}>(`/api/conversations/${encodeURIComponent(storyTaskId)}`).then(result=>openConversation(result.conversation)).catch(e=>setError(e.message))}>查看任务 ↗</button>:null}<button type="button" onClick={()=>setHandbookNotice('')} aria-label="收起说明">知道了</button></p> : null}
    </>;}

  function renderStory(){
    if(storyLaunching)return <section className="story-launch-status" role="status"><h3>正在打开引导</h3><p>你的对话和草稿会留在这里。</p></section>;
    if(storyLaunchError)return <section className="story-launch-status" role="alert"><h3>引导暂时没打开</h3><p>{storyLaunchError}</p><button type="button" className="primary" onClick={()=>void startStory()}>重新打开引导</button></section>;
    return <StoryOnboarding effectPreview={guideEffectPreview} profile={profile} context={welcomeContext} offer={handbookOffer} onBegin={startStory} onAction={saveStory} onKnowledge={()=>{storyRequested.current=false;openSurface('knowledge');}} onDevice={()=>{storyRequested.current=false;setAccountSection('device');openSurface('account');}} onDismiss={dismissStory}/>;
  }

  function renderRuntimeNotices(){return <>
      {runtimeUpdate && runtimeUpdateConfirmed(runtimeUpdate) && runtimeUpdate.confirmation?.requestId !== dismissedRuntimeReceipt ? <section className="one-runtime-update completed" aria-live="polite">
        <span className="one-runtime-update-icon"><Check size={16} /></span>
        <span><strong>ONE 已升级至 {runtimeUpdate.current?.version}</strong><small>新版已启动并连接，更新成功。可以继续使用 ONE。</small></span>
        <button type="button" onClick={() => {
          const receipt = runtimeUpdate.confirmation!.requestId;
          setDismissedRuntimeReceipt(receipt);
          try { if (runtimeUpdate.current?.version) rememberRuntimeNotice(localStorage, user.id, runtimeUpdate.current.version); } catch { /* storage optional */ }
          window.location.reload();
        }}>刷新页面</button>
      </section> : null}
      {runtimeUpdate?.available ? <section className={`one-runtime-update ${runtimeUpdate.progress?.status || "available"}`} aria-live="polite">
        <span className="one-runtime-update-icon"><Download size={16} /></span>
        <span><strong>{runtimeUpdating ? "正在更新 ONE" : runtimeUpdateIssue ? "正在确认更新结果" : runtimeUpdateFailed ? "更新没有完成" : "ONE 可以更新"}</strong><small>{runtimeUpdateIssue || (runtimeUpdating ? ({ requested: "准备下载…", downloading: "正在下载…", verifying: "正在验证…", installing: "正在安装…", completed: "安装已完成，正在连接新版…", failed: runtimeUpdate.progress?.message || "更新失败" }[runtimeUpdate.progress?.status || "requested"]) : runtimeUpdateFailed ? runtimeUpdate.progress?.message || "请保持 ONE Key 插入并重试" : `${runtimeUpdate.current?.version || "当前版本"} → ${runtimeUpdate.latestVersion}`)}</small></span>
        {!runtimeUpdateIssue ? <button type="button" disabled={runtimeUpdating || runtimeChecking} onClick={() => void installRuntimeUpdate()}>{runtimeUpdating ? "请稍候" : runtimeUpdateFailed ? "重试" : "更新"}</button> : null}
        {runtimeUpdateIssue ? <details className="one-runtime-update-detail"><summary>连接详情</summary>
          <div className="one-runtime-update-detail-body"><span>当前账号：{user.username} · 运行 {runtimeUpdate.current?.version || "未知"} · 目标 {runtimeUpdate.latestVersion || "未知"}</span>
          {runtimeCheckFeedback ? <span role="status">{runtimeCheckFeedback}</span> : null}
          <div className="one-runtime-update-actions"><button type="button" disabled={runtimeChecking} onClick={() => void refreshRuntimeUpdate(true)}>{runtimeChecking ? "查询中…" : "重新检测连接"}</button>
          <button type="button" onClick={() => window.location.reload()}>刷新页面</button></div></div>
        </details> : null}
      </section> : null}

    </>;
  }

  function renderHistory() { return (
          <section className="one-history-popover fluid-history-content">
            <div className="one-popover-heading">
              <div><small>YOUR FLOW</small><h3>{showArchived ? "已归档对话" : "历史对话"}</h3></div>
              <button type="button" onClick={startNewChat}><Plus size={16} />新对话</button>
            </div>
            <input className="one-history-search" type="search" aria-label="搜索已加载的历史对话" placeholder="搜索已加载的对话" value={historyQuery} onChange={e=>setHistoryQuery(e.target.value)}/>
            <div className="one-popover-list">
              {visibleConversations.length ? visibleConversations.map((conversation) => (
                <div className={`one-history-row ${conversation.id === activeId ? "active" : ""}`} key={conversation.id}>
                  <button type="button" onClick={() => openConversation(conversation)}>
                    <span>{conversation.title}</span>
                    <small>{dateTime(conversation.updatedAt)}</small>
                  </button>
                  <button type="button" title={conversation.archived ? "取消归档" : "归档"} disabled={conversation.id.startsWith("tmp_") || Boolean(loadingByConversation[conversation.id]) || runningExecutions.some(task => task.conversationId === conversation.id)} onClick={() => archiveConversation(conversation)}><Archive size={14} /></button>
                </div>
              )) : <div className="one-popover-empty">{historyQuery?"已加载的对话中没有匹配结果，可继续加载更早记录。":"还没有对话，从一句话开始吧。"}</div>}
            </div>
            {hasMoreConversations ? <button className="one-load-more" type="button" disabled={loadingMoreConversations} onClick={loadMoreConversations}>{loadingMoreConversations ? "加载中…" : "加载更多"}</button> : null}
            <footer className="one-popover-footer">
              <button type="button" onClick={() => setShowArchived(!showArchived)}>{showArchived ? "返回历史对话" : "查看归档"}</button>
              <button type="button" onClick={onLogout}><LogOut size={14} />退出账号</button>
            </footer>
          </section>
  ); }

  function thingItems() {
    return conversations.filter(c=>!coordinator.snapshot?.conversation||c.id!==coordinator.snapshot.conversation.id).map(c=>{const task=coordinatorMetas.find(t=>t.id===c.id)||coordinator.snapshot?.tasks.find(t=>t.id===c.id);const local=executionTasks.find(t=>t.conversationId===c.id);const notices=coordinator.snapshot?.notices.filter(n=>n.taskId===c.id)||[];const notice=notices.at(-1);const reconciling=!task?.running&&Boolean(task?.reconciling||task?.state==='reconciling');const paused=!reconciling&&(task?.paused||c.workPaused);const unread=notices.some(n=>!n.read);const outcome=reconciling?'reconciling':taskUiOutcome({paused,localStatus:local?.status,receiptOutcome:notice?.outcome,receiptState:notice?.state});return {...c,messages:taskConversationView(c.messages,coordinator.details[c.id]?.jobs),outcome,unread,taskState:taskCategory({paused,active:Boolean(reconciling||task?.running||task?.queued||task?.localPrepared||local&&isExecutionRunning(local)),unread,outcome,isTask:Boolean(task||local||c.executorProfileId)})};});
  }

  function renderThings() {
    const thingDestination=thingDestinations[thingId]||'chat';
    const workflow=coordinator.details[thingId]?.jobs.at(-1)?.workflow;
    const pauseNotice=taskPauseNotice(thingId);
    const panel=<ThingsPanel
        one={undefined}
        fluid={preview.enabled}
        onCloseDetail={()=>setThingId('')}
        workbenchLabel={preview.enabled?'回到主对话':'在工作台继续 ↗'}
        items={thingItems()} selectedId={thingId} drafts={thingDrafts}
        onReadAll={readAllTaskMessages} unreadCount={unviewedResultCount || unreadNotices.length}
        onDraftChange={(id,text)=>setThingDrafts(previous=>({...previous,[id]:text}))}
        onExecuteDraft={thingDestination === 'notion' ? undefined : (id,text,source)=>executeDraft(text,source,id)}
        sendLabel={thingDestination === 'notion' ? '写到 Notion' : thingDestination === 'local' ? '本机执行' : '发送'}
        destinationPicker={!demo.enabled ? <><NotionReceiptNotice key={thingId} api={api} taskId={thingId} receipt={notionReceiptForReview(coordinator.details[thingId]?.jobs||[])?.notionReceipt} onRefresh={()=>coordinator.load(thingId,true)} /><DocumentDestinationPicker api={api} value={thingDestination} onChange={destination=>setThingDestinations(old=>({...old,[thingId]:destination}))} localDisabled={taskStatusUnavailable || executionBusy || preparingExecution} localDisabledHint={preparingExecution?'正在准备本机执行，请稍候':executionBusy?'本机任务结束后可保存':taskStatusUnavailable?'暂未确认本机连接，可到设置检查':undefined} onLocalSettings={()=>{setAccountSection('device');openSurface('account');}} onSettings={() => openSurface('knowledge')} /></> : undefined}
        onSelect={id=>void selectThing(id)} onSend={continueThing}
        onWorkbench={id=>{if(preview.enabled)closeWorkLayer();else void openConversation(conversations.find(item=>item.id===id)!);setResultLampOpen(false);}}
        onRemove={coordinator.enabled?removeCoordinatorTask:undefined}
        taskNotice={workflow?<><TaskWorkflowProgress key={thingId} workflow={workflow}/>{pauseNotice}</>:pauseNotice}
        executionDisabled={taskStatusUnavailable || preparingExecution || executionBusy || Boolean(loadingByConversation[thingId])}
        executionPreparing={preparingExecution && preparingConversationId===thingId}
        executionContent={preparingExecution && preparingConversationId===thingId || thingExecutionTask ? <ExecutionDisclosure
          key={thingExecutionTask?.id || "thing-preparing"} task={thingExecutionTask}
          events={thingExecutionTask ? eventsByTask[thingExecutionTask.id] || [] : []}
          preparing={preparingExecution && preparingConversationId===thingId}
          expanded={Boolean(thingExecutionTask && expandedExecutionId===thingExecutionTask.id)}
          onToggle={()=>setExpandedExecutionId(expandedExecutionId===thingExecutionTask?.id ? "" : thingExecutionTask?.id || "")}
          onStop={source=>cancelExecution(source,thingExecutionTask)}
          onContinue={source=>void sendExecutionMessage(executionResumeInstruction,thingExecutionTask,source,true)}
          actorRole={user.role} onReconciled={rememberReconciledExecution}
          continuationDisabled={preparingExecution||executionBusy||taskStatusUnavailable}
          onCheck={()=>{if(thingExecutionTask)void loadLatestExecution(thingExecutionTask.conversationId,thingExecutionTask.id,true);}} /> : null}
        hasMore={hasMoreConversations||(coordinator.enabled&&(coordinator.snapshot?.total??0)>coordinator.state.tasks.length)}
        onMore={()=>void loadMoreConversations()} loadingMore={loadingMoreConversations}/>;
    return preview.enabled?<div className="fluid-things-shell"><nav className="fluid-task-scope" aria-label="任务范围"><button type="button" aria-pressed={taskScope==='tasks'} onClick={()=>setTaskScope('tasks')}>任务与对话</button><button type="button" aria-pressed={taskScope==='features'} onClick={()=>setTaskScope('features')}>功能运行记录</button></nav>{taskScope==='features'?<div className="fluid-task-feature-history"><FeatureRunHistory api={api} active={workLayer==='things'} onOpen={run=>openFeatureRun(run.operationId)}/></div>:panel}</div>:panel;
  }

  function renderFeatures() {
    return (<section className="account-page features-page"><header className="admin-header"><div><h2>功能</h2></div></header><div className="account-body settings-account-body">{featureSelectionNotice?<p className="feature-selection-notice" role="status">{featureSelectionNotice}</p>:null}{preview.enabled?<FeatureShelf api={api} models={models} active={workLayer==='features'} onDone={()=>{closeWorkLayer();requestAnimationFrame(()=>featurePicker.input.current?.focus());}} onOperationChange={setViewedFeatureOperation} initialOperationId={featureOperationId||undefined} onRunStarted={run=>{setFeatureOperationId(run.operationId);updateFeatureRun(run);closeWorkLayer();fluidPanels.open('activity');focusFluid('activity');}} onRunStatus={updateFeatureRun} selected={featureForNext.map(item=>item.id)} onChoose={chooseFeature}/>:<FeatureMarketplace api={api} models={models} onAsk={()=>openSurface('chat')}/>}</div></section>);
  }
  function renderAccount() {
    return (<AccountPage user={user} profile={profile} onSaveProfile={async patch=>{const result=await saveProfile(patch);if(patch.appearance)setScenePreview(null);return result;}} onOpenGuide={startStory} models={models} defaultModelId={defaultModelId} onModelChange={refresh} onOpenSidebar={openHistory} section={accountSection} setSection={setAccountSection} knowledge={<KnowledgeConnections api={api} inline={preview.enabled} returnOutcome={knowledgeReturnRef.current} onOpenSidebar={() => setHistoryOpen(true)} onConnectionChange={(next) => next.provider === "notion" ? setNotionConnection(next) : next.provider === "yinxiang" ? setYinxiangConnection(next) : next.provider === "flowus" ? setFlowusConnection(next) : next.provider === "flomo" ? setFlomoConnection(next) : setKnowledgeConnection(next)} />} />);
  }

  return (
    <main onClickCapture={event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const anchor=event.target instanceof Element?event.target.closest('a[href]'):null;if(!anchor||anchor.hasAttribute('download')||anchor.getAttribute('target')==='_blank')return;const id=internalTaskId(anchor.getAttribute('href')||'',window.location.href);if(id){event.preventDefault();void openLinkedTask(id);}}} onPointerDownCapture={event=>{if(event.target instanceof HTMLElement)executionPointerRef.current={element:event.target,point:{x:event.clientX,y:event.clientY}};else if(event.target instanceof SVGElement)executionPointerRef.current={element:event.target.closest('button')!,point:{x:event.clientX,y:event.clientY}};}} onKeyDownCapture={()=>{executionPointerRef.current=null;}} data-fluid-desktop={fluidDesktop} data-fluid-material={fluidMaterial} data-fluid-accent={fluidAccent} data-fluid-scene={fluidScene} data-fluid-dialogue={fluidHasDialogue?'active':'empty'} data-sidebar-open={sidebarOpen} className={`app-shell one-shell one-studio attention-workspace ${fluidEnabled?"one-fluid-workspace":""} ${preview.enabled&&(view==='chat'||view==='features'||view==='account')?`coordinator-preview ${view==='features'?'coordinator-tools-open':view==='account'?'coordinator-settings-open coordinator-task-open':active?'coordinator-task-open':''}`:''} ${view==='things'?'studio-things':''} ${view==='features'?'studio-discover':''} ${studioIdle ? "studio-idle" : "studio-open"} ${focusedTask && view === "chat" && !studioIdle ? "studio-focused" : ""} ${activeExecutionMode ? "execution-shell" : ""}`}>
      <header className="one-chrome" hidden={fluidEnabled}>
        <button className="one-brand-button" type="button" onClick={startNewChat} title="回到 ONE">
          <OneWordmark inverse />
        </button>
        <nav className="studio-navigation" aria-label="工作区导航">
          <button type="button" aria-current={view === "chat" ? "page" : undefined} onClick={() => openSurface("chat")}>工作台</button>
          <button type="button" aria-current={view === "things" ? "page" : undefined} onClick={() => openSurface("things")}>任务{unviewedResultCount?<span className="task-review-dot" aria-label={`${unviewedResultCount} 个结果待确认`}/>:null}</button>
          <FeatureNav quiet={!canPeekAtFeatures(view!=='chat'||studioIdle,isWaiting,content)} active={view==='features'} onClick={()=>openSurface('features')}/>
          <button type="button" aria-current={view === "account" ? "page" : undefined} onClick={() => openSurface("account")}>设置</button>
          {user.role === "admin" ? <button type="button" aria-current={view === "admin" ? "page" : undefined} onClick={() => openSurface("admin")}>管理</button> : null}
          {user.access?.role === "company_admin" ? <button type="button" aria-current={view === "company" ? "page" : undefined} onClick={() => openSurface("company")}>公司管理</button> : null}
        </nav>
        <div className="one-chrome-actions">
          {preparingExecution||awaitingExecutionOperationId||executionBusy?<button type="button" className="one-chrome-button" onClick={event=>void cancelExecution(event.currentTarget,currentRunningExecution||runningExecutions[0]||executionTask)}><Square size={12}/>停止执行</button>:null}
          <button className="one-chrome-button knowledge" type="button" title="知识来源" onClick={() => openSurface("knowledge")}>
            <span className={`connection-dot ${[knowledgeConnection, notionConnection, yinxiangConnection, flowusConnection, flomoConnection].some(item => item.status === "connected") ? "connected" : "disconnected"}`} />
            <span>{[knowledgeConnection, notionConnection, yinxiangConnection, flowusConnection, flomoConnection].some(item => item.status === "connected") ? "知识已连接" : "连接知识"}</span>
          </button>
          <button className={`one-chrome-button icon-only ${historyOpen ? "active" : ""}`} type="button" title="历史对话" onClick={() => setHistoryOpen((open) => !open)}>
            <Archive size={16} />
          </button>
          <button className="one-user-button" type="button" title="账号" onClick={() => openSurface("account")}>
            {(profile.displayName || user.username).slice(0, 1).toUpperCase()}
          </button>
        </div>
      </header>

      {!fluidEnabled?renderRuntimeNotices():null}

      {historyOpen && !fluidEnabled ? (
        <>
          <button className="one-popover-scrim" aria-label="关闭历史对话" onClick={() => setHistoryOpen(false)} />
          {renderHistory()}
        </>
      ) : null}


      {fluidEnabled?<aside className="fluid-rail" aria-label="工作区导航" onPointerDownCapture={()=>focusFluid('main')} onFocusCapture={()=>focusFluid('main')}>
        <div className="fluid-rail-top">
          <button type="button" title="回到主对话" aria-label="回到主对话" onClick={()=>openSurface('chat')}><MessageSquare size={19}/><span>主页</span></button>
          <button type="button" title="任务" aria-label="任务" onClick={()=>openSurface('things')}><Folder size={19}/><span>所有任务</span>{fluidReminderCount?<i className="fluid-task-dot" aria-label={`${fluidReminderCount} 条待查看动态`}/>:null}</button>
          <button type="button" title="功能与分身" aria-label="功能与分身" onClick={()=>openSurface('features')}><Sparkles size={19}/><span>功能与分身</span></button>
        </div>
        <div className="fluid-rail-tasks" aria-label="待处理任务"><small className="fluid-rail-section-label">正在进行与待查看</small>{fluidFeedback.slice(0,4).map(task=><button type="button" key={task.id} title={task.title} onClick={()=>{const item=conversations.find(c=>c.id===task.taskId);if(item)void openConversation(item);}}><span aria-hidden="true">{transferSettled(task.state)?'•':'·'}</span><strong>{task.title}</strong><small>{transferSettled(task.state)?'待查看':'处理中'}</small></button>)}{featureRuns.slice(0,2).map(run=><button type="button" key={`feature:${run.operationId}`} title={run.name} onClick={()=>openFeatureRun(run.operationId)}><span aria-hidden="true">•</span><strong>{run.name}</strong><small>{run.status==='pending'?'处理中':'待查看'}</small></button>)}</div>
        <div className="fluid-rail-bottom">
          <button type="button" title="历史对话" aria-label="历史对话" onClick={openHistory}><Archive size={18}/><span>历史记录</span></button>
          <button type="button" title="设置" aria-label="设置" onClick={()=>openSurface('account')}><Settings size={18}/><span>设置</span></button>
          {user.role==='admin'?<button type="button" title="管理" aria-label="管理" onClick={()=>openSurface('admin')}><ShieldCheck size={18}/><span>管理</span></button>:null}
          {user.access?.role==='company_admin'?<button type="button" title="公司管理" aria-label="公司管理" onClick={()=>openSurface('company')}><Users size={18}/><span>公司管理</span></button>:null}
          <button type="button" title="个人账号" aria-label="个人账号" onClick={()=>openSurface('account')}><UserRound size={18}/><span>{profile.displayName||user.username}</span></button>
        </div>
      </aside>:null}
      <div className={`studio-layout ${fluidEnabled?'fluid-canvas':''}`} ref={fluidCanvasRef} style={fluidEnabled?fluidStyle:undefined}>
      {fluidEnabled&&fluidDesktop?<div className="fluid-skin"><OneFluidSurface scene={fluidScene} accent={fluidAccent} executionActive={activeExecutionMode} width={fluidSize.width} height={fluidSize.height} sizing={fluidSizing} activityOpen={fluidPanels.activityOpen} localOpen={fluidPanels.localOpen} sidebarOpen={sidebarOpen} onActivityToggle={()=>toggleFluidPanel('activity')} onLocalToggle={()=>toggleFluidPanel('local')} onSidebarToggle={()=>{focusFluid('main');setSidebarOpen(value=>!value);}} attentionTarget={fluidAttention.target} attentionVersion={fluidAttention.version} onEyeReturn={()=>setFluidAttention(old=>({...old,target:'main'}))} onProgress={paintFluidContent}/></div>:null}
      {fluidEnabled&&!fluidDesktop?<div className="fluid-compact-toggle"><button type="button" data-fluid-trigger="activity" aria-expanded={fluidPanels.activityOpen} onClick={()=>toggleFluidPanel('activity')}>任务动态{unviewedResultCount?` · ${unviewedResultCount}`:''}</button><button type="button" data-fluid-trigger="local" aria-expanded={fluidPanels.localOpen} onClick={()=>toggleFluidPanel('local')}>接管任务{executionBusy?' · 执行中':''}</button></div>:null}

      <section className="studio-surface" ref={taskScroll.scroll} onScroll={taskScroll.onScroll} data-fluid-task-detail={fluidEnabled} data-open={Boolean(active)} aria-label={view === "chat" ? "当前任务" : "工作区内容"} hidden={studioIdle||(preview.enabled&&view==='chat'&&!active)}>
      {fluidEnabled&&active?<div className="fluid-detail-toolbar"><span>任务详情</span><button type="button" aria-label="收起任务详情" onClick={()=>openSurface('chat')}><X size={16}/></button></div>:null}
      {view === "things" ? renderThings()
        : view === "company" && user.access?.role === "company_admin" ? (
        <CompanyPanel api={api}/>
      )
        : view === "admin" && user.role === "admin" ? (
        <AdminPanel actorId={user.id} refreshModels={refresh} onOpenSidebar={() => setHistoryOpen(true)} />
      ) : view === "features" ? (
        renderFeatures()
      ) : view === "account" ? (
        renderAccount()
      ) : (
      preview.enabled && !active ? <section className="workspace-task-overview"><h1>手头的事情</h1><div>{preview.state.tasks.filter(task=>task.messages.length).map(task=><button type="button" key={task.id} onClick={()=>void openConversation(conversations.find(item=>item.id===task.id)!)}><strong>{task.title}</strong><small>{task.status==='running'?'正在处理':task.status==='completed'?'结果好了':task.status==='failed'?'需要看一下':'接着聊'} ↗</small></button>)}</div></section> :
      <section className="studio-task" key={activeId}>
        <header className="studio-task-header">
          <div><div className={`task-current-state ${currentBusy ? "is-active" : ""}`}><span className={`task-indicator ${currentBusy ? "running" : executionTask?.status || "recent"}`} aria-hidden="true" />{currentStatus}</div><h1>{active?.title || "从一个念头开始"}</h1></div>
          <div className="studio-task-controls">
            {preview.enabled&&active?<button type="button" onClick={()=>openSurface('chat')}>回到 ONE <X size={14}/></button>:null}
            {preview.enabled && active ? <button type="button" className="studio-mode-switch task-continue-button" onClick={()=>openSurface('things',active.id)}>继续任务</button> : null}
            {coordinator.enabled&&active?<ActionMenu label="更多任务操作"><button type="button" onClick={()=>{if(confirm('删除此任务并停止尚未完成的云端处理？历史和用量会保留，可恢复；已发生的外部操作不会撤销。'))void removeCoordinatorTask(active.id).then(()=>openSurface('chat')).catch(e=>setError(e.message));}}>删除任务</button></ActionMenu>:null}
            {executionShortcut ? <button type="button" onClick={() => { setSelectedExecutionId(executionShortcut.id); setExpandedExecutionId(executionShortcut.id); setRevealExecutionId(executionShortcut.id); void loadLatestExecution(activeId, executionShortcut.id); }} aria-label="查看本机执行"><Zap size={14} /><span>{currentRunningExecution ? "查看执行进展" : "查看执行结果"}</span></button> : null}
            <button type="button" aria-label={focusedTask ? "还原布局" : "放大当前任务"} aria-pressed={focusedTask} onClick={() => transitionInterface(() => setFocusedTask(value => !value))}>{focusedTask ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
          </div>
        </header>
        <div className="messages">
          <TaskWorkflowProgress key={activeId} workflow={coordinator.details[activeId]?.jobs.at(-1)?.workflow}/>
          {taskPauseNotice(activeId)}
          {(active?.messages ?? []).length ? (
            taskConversationView(active!.messages,coordinator.details[activeId]?.jobs).map((message, index) => (
              <React.Fragment key={`${message.createdAt}-${index}`}>
                <article hidden={replyPending&&message.role==='assistant'&&!message.content.trim()} className={`message ${message.role} ${message.id && message.id === (executionTask?.sourceMessageId || executionSourceMessageId) && activeExecutionMode ? "execution-source" : ""}`}>
                  <div className="bubble">
                    <div className="studio-message-author">{message.originalContent ? 'ONE 交给这个任务的要求' : message.role === "assistant" ? "ONE" : "你"}</div>
                    {remainingResultAttachments(message.attachments,message.role==='assistant'?message.imageUrl:undefined).length ? <AttachmentList attachments={remainingResultAttachments(message.attachments,message.role==='assistant'?message.imageUrl:undefined)} /> : null}
                    {message.role === "assistant" ? (
                      <>
                        <div className="markdown-body">
                          <MessageMarkdown>{message.content}</MessageMarkdown>
                        </div>
                        {message.finishReason === "length" ? <div className="message-completion-notice" role="status"><span>本次回答达到长度上限，尚未写完。</span>{index === active!.messages.length - 1 && !composeNew ? <button type="button" disabled={activeLoading || executionBusy || uploadingAttachments || !!pendingAttachments.length} onClick={() => { if (confirm("继续生成会产生新的额度消耗，是否继续？")) void sendMessage("请接着上一条未完成的回答继续，从中断处接上，不要重复前文。"); }}>继续生成</button> : null}</div> : message.finishReason === "filtered" ? <p className="message-completion-notice" role="status">模型服务未完整返回这次回答，请调整问题后再试。</p> : null}
                        {message.imageUrl ? <div className="task-image-result">{!hasInlineImage(message.content,message.imageUrl) ? <ImagePreview src={message.imageUrl} alt="ONE 生成的图片"/> : null}<a className="one-task-result-link" href={message.imageUrl} download>保存图片 ↗</a></div> : null}
                        <MessageSources message={message} />
                        {!demo.enabled && message.id && active && !active.id.startsWith("tmp_") ? <BetaFeedbackControls key={message.id} messageId={message.id} requestId={message.requestId}
                          leading={<button type="button" title="复制回答" onClick={() => copyMarkdown(message.content)}><Copy size={14}/>复制</button>}
                          moreActions={!message.imageUrl&&!/!\[[^\]]*\]\(/.test(message.content) ? <button type="button" className="execution-trigger" title={taskStatusUnavailable ? "正在确认本机状态" : executionBusy ? "本机正在工作，完成后可执行下一件" : "把这条回答交给本机执行"} disabled={taskStatusUnavailable || preparingExecution || executionBusy || activeLoading} onClick={(event) => executeFromMessage(message, event.currentTarget)}><Zap size={14}/>交给本机执行</button> : undefined}
                          onSave={async input => (await api<{ feedback: import("./Onboarding").OwnBetaFeedback }>("/api/me/feedback", { method: "POST", body: JSON.stringify(input) })).feedback} /> : <div className="message-result-toolbar"><button type="button" onClick={() => copyMarkdown(message.content)}><Copy size={14}/>复制</button></div>}
                      </>
                    ) : (
                      <>
                        <pre>{message.content}</pre>
                        {message.originalContent ? <details className="task-original-message"><summary>查看你的原话</summary><p>{message.originalContent}</p></details> : null}
                        {preview.enabled && preview.state.tasks.find(task=>task.id===activeId)?.messages.find(item=>item.id===message.id)?.status==='queued' ? <small>{coordinator.snapshot?.tasks.find(t=>t.id===activeId)?.paused?'已保存 · 任务暂停，请确认继续处理':'已收到 · 等待处理'}</small> : null}
                      </>
                    )}
                    {message.role!=='assistant'&&message.imageUrl&&!hasInlineImage(message.content,message.imageUrl)?<ImagePreview src={message.imageUrl}/>:null}
                    <small className="message-time">{dateTime(message.createdAt)}</small>
                  </div>
                </article>
              </React.Fragment>
            ))
          ) : <div className="studio-empty">{activeLoading ? "正在打开…" : failedTaskIds.has(activeId) ? "发送失败，草稿已保留。" : "发一条消息。"}</div>}
          {replyPending?<OneWaitingCopy key={`waiting:${activeId}:${latestTurnStart}`}/>:null}
          {activePreparing || executionTask ? <ExecutionDisclosure key={executionTask?.id || "preparing"} task={executionTask} events={executionEvents} preparing={activePreparing} expanded={Boolean(executionTask && expandedExecutionId === executionTask.id)} onToggle={() => setExpandedExecutionId(expandedExecutionId === executionTask?.id ? "" : executionTask?.id || "")} onStop={source => cancelExecution(source)} onContinue={source=>void sendExecutionMessage(executionResumeInstruction,executionTask,source,true)} actorRole={user.role} onReconciled={rememberReconciledExecution} continuationDisabled={preparingExecution||executionBusy||taskStatusUnavailable} onCheck={()=>{if(executionTask)void loadLatestExecution(executionTask.conversationId,executionTask.id,true);}} /> : null}
        </div>
      </section>
      )}
      </section>

      <aside className={`studio-assistant ${activityExpanded ? "activity-is-open" : ""}`} aria-label="ONE 指挥台" onPointerDownCapture={()=>{if(fluidEnabled)focusFluid('main');}} onFocusCapture={()=>{if(fluidEnabled)focusFluid('main');}}>
        {!fluidEnabled?renderAttentionInbox():null}
        {view==='chat'&&workLayer!=='guide'&&!guideEffectPreview&&(!fluidEnabled||!fluidHasDialogue)&&profileLoaded&&!storyHidden&&(storyOpen||profile.onboarding.journey?.stage&&profile.onboarding.journey.stage!=='complete'||!hasSubmittedChat&&!conversations.length&&!profile.onboarding.completedAt&&user.access?.kind!=='company')?<StoryOnboarding profile={profile} context={welcomeContext} offer={handbookOffer} onBegin={startStory} onAction={saveStory} onKnowledge={()=>{storyRequested.current=false;openSurface('knowledge');}} onDevice={()=>{storyRequested.current=false;setAccountSection('device');openSurface('account');}} onDismiss={()=>{storyRequested.current=false;setStoryHidden(true);setStoryOpen(false);}}/>:null}
        {!fluidEnabled?renderGuideDelivery():null}
        {!fluidEnabled||!fluidHasDialogue?<div className="studio-presence">
          {!fluidEnabled||!fluidDesktop?<OneHeroEye mood={heroMood} label={view==='features'?'收起功能，回到 ONE':'打开功能'} onActivate={()=>openSurface(view==='features'?'chat':'features')}/>:null}
          <div className="studio-presence-copy"><span className="studio-eyebrow">ONE IS WITH YOU</span>
          <h2>{activeAgent?.name || (studioIdle ? `${profile.displayName ? `${profile.displayName}，` : ""}${greeting}` : "我在。")}</h2></div>
          {demo.enabled?<ResultSignal tasks={lampTasks} busy={Boolean(content.trim()||preview.state.pending||view==='things')} ambient={view==='chat'&&!active} onOpen={id=>void openConversation(conversations.find(item=>item.id===id)!)} onDismiss={closeResultLamp}/>:null}
        </div>:null}

{preview.enabled&&preview.state.dialogue.length>0?<CoordinatorConversation renderAssistantActions={message=><BetaFeedbackControls messageId={message.id} requestId={message.requestId} leading={<button type="button" title="复制回答" onClick={()=>void copyMarkdown(message.text)}><Copy size={14}/>复制</button>} onSave={async input=>(await api<{feedback:import('./Onboarding').OwnBetaFeedback}>('/api/me/feedback',{method:'POST',body:JSON.stringify(input)})).feedback}/>} onContinue={()=>{if(currentDraftRef.current.content.trim()){setError('输入框还有草稿，请先保留或发送它，再继续生成。');return;}if(confirm('继续生成会产生新的额度消耗，是否继续？'))void sendMessage('请接着上一条未完成的回答继续，从中断处接上，不要重复前文。');}} hasEarlierHistory={coordinator.hasEarlierHistory} loadingHistory={coordinator.loadingHistory} onLoadHistory={coordinator.enabled?coordinator.loadHistory:undefined} visible={view==='chat'||view==='features'||view==='account'} messages={preview.state.dialogue} tasks={preview.state.tasks} pending={Boolean(preview.state.pending)} completed={coordinator.settlement?.status==='completed'&&!coordinator.error} progress={coordinator.enabled?coordinator.progress:null} onStop={coordinator.enabled?coordinator.stop:undefined} onRestore={text=>{
          if(currentDraftRef.current.content.trim()){setError('输入框已有新草稿，先保留或发送它，再恢复原话。');return;}
          setContent(text);const failed=coordinatorFailedDraft.current;
          if(failed?.text===text){
            setPendingAttachments(old=>[...new Map([...old,...failed.files].map(file=>[file.id,file])).values()]);
            setFeatureForNext(old=>[...new Map([...old,...failed.features].map(feature=>[feature.id,feature])).values()]);
          }
        }} onOpen={id=>void openConversation(conversations.find(item=>item.id===id)!)}/>:null}
        {coordinator.removedTask?<p role="status">任务已删除，历史保留。<button type="button" onClick={()=>void coordinator.restoreTask().then(()=>refresh()).catch(e=>setError(e.message))}>恢复任务（不会自动重跑）</button></p>:null}
{!fluidEnabled ? coordinator.enabled && view==='chat' ? <TaskTransferRail tasks={uniqueTransfers} busy={Boolean(isComposing || coordinator.state.pending)} departureAnchor={()=>document.querySelector<HTMLElement>('[data-task-dispatch-anchor]') || document.querySelector<HTMLElement>('.studio-presence')} returnAnchor={()=>document.querySelector<HTMLElement>('[data-task-return-anchor]') || document.querySelector<HTMLElement>('.coordinator-message.assistant:last-of-type')} recentReportedReceiptIds={coordinator.snapshot?.recentReportedReceiptIds} onReadAll={readAllTaskMessages} onOpenAll={()=>openSurface('things')} onDismiss={task=>coordinator.acknowledge(task.taskId,dismissibleReceiptIds(uniqueTransfers,task.taskId))} onOpen={id=>{const item=conversations.find(c=>c.id===id);if(item)void openConversation(item);}} onStop={async(task,source)=>{const local=executionTasks.find(t=>t.id===task.id&&isExecutionRunning(t));if(local)await cancelExecution(source,local);else await coordinator.stopTask(task.taskId);}} onReport={ids=>coordinator.report(ids)} /> : null : null}

        {!preview.enabled && (otherRows.length > 0 || unreadNotices.length > 0 || taskStatusUnavailable) ? <section className="studio-activity attention-activity" aria-label="任务动态">
          {otherRows.length > 0 || unreadNotices.length > 0 ? <button className="attention-activity-toggle" type="button" aria-expanded={activityExpanded} aria-controls="attention-task-list" onClick={() => setActivityExpanded(value => !value)}>
            <span>{activeOthers.length ? <><span className="task-indicator running" aria-hidden="true" />另外 {activeOthers.length} 件正在进行</> : unreadNotices.length ? "有新的结果" : "其他事情"}</span>
            <span>{unreadNotices.length > 0 ? <b className="attention-unread-count">{unreadNotices.length} 条更新</b> : <small>{otherRows.length}</small>}<ChevronDown size={14} /></span>
          </button> : null}
          <div id="attention-task-list" className="attention-task-list" hidden={!activityExpanded || otherRows.length === 0}>
            {unreadNotices.length ? <TaskReadAllButton count={unreadNotices.length} onReadAll={readAllTaskMessages}/> : null}
            {activeOthers.length > 0 ? <section><h3>进行中</h3>{activeOthers.map(renderActivityRow)}</section> : null}
            {settledOthers.length > 0 ? <section><h3>{settledOthers.some(row => row.unread) ? "结果与最近" : "最近"}</h3>{settledOthers.slice(0, 5).map(renderActivityRow)}</section> : null}
            {otherRows.length === 0 ? <p className="attention-empty">当前没有其他事情。</p> : null}
            <button className="attention-all-tasks" type="button" onClick={() => setHistoryOpen(true)}>查看全部记录 <ArrowUpRight size={12} /></button>
          </div>
          {taskStatusUnavailable ? <button className="studio-status-retry" type="button" onClick={refreshExecutionTasks}>进度暂未连接 · 重试</button> : null}
        </section> : null}

        <div className="attention-receipt-slot" aria-live="polite" aria-atomic="true">
          {visibleReceipt ? <div className={`attention-receipt ${visibleReceipt.outcome}`} key={visibleReceipt.id}>
            {visibleReceipt.outcome === "failed" ? <span aria-hidden="true">!</span> : visibleReceipt.outcome === "cancelled" ? <Square size={10} aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}<button type="button" onClick={() => openReceipt(visibleReceipt)} title={visibleReceipt.title}><span>{visibleReceipt.outcome === "reply" ? "回复已返回" : visibleReceipt.outcome === "completed" ? "已完成 · 查看结果" : visibleReceipt.outcome === "failed" ? "未完成 · 查看原因" : "已停止"}</span><strong>{visibleReceipt.title}</strong></button>
            <button type="button" aria-label="收起这条提醒" onClick={() => acknowledgeConversation(visibleReceipt.conversationId)}><X size={12} /></button>
          </div> : null}
        </div>

        <form className="composer studio-composer" data-feature-armed={preview.enabled&&featureForNext.length>0} onSubmit={send}>
          {coordinator.enabled&&coordinator.state.boundTask&&coordinator.state.boundTask!==activeId?taskPauseNotice(coordinator.state.boundTask):null}
          {!models.length ? <div className="chat-error"><span>模型未就绪，请联系管理员。</span><button type="button" onClick={() => void refresh()}>重试</button></div> : null}
          {pendingRequests.length ? <details className="one-pending-answers"><summary>有 {pendingRequests.length} 条消息待确认 · 查看原结果，不重复扣费</summary>{pendingRequests.map(item => <button type="button" key={item.operationId} onClick={() => void recoverAnswer(item.operationId)}>查看 {dateTime(item.createdAt)} 的结果</button>)}</details> : null}
          {preview.enabled ? <div className={`studio-compose-context ${preview.state.boundTask?'is-bound':''}`}><span>{preview.state.boundTask ? `发送到任务：${preview.state.tasks.find(task=>task.id===preview.state.boundTask)?.title || '当前任务'}` : '与 ONE 对话'}</span>{preview.state.boundTask ? <button type="button" onClick={()=>preview.dispatch({type:'bind',taskId:null})}>回到主对话 <X size={12}/></button> : null}</div> : !studioIdle ? <div className="studio-compose-context">
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
              <AttachmentList attachments={pendingAttachments} removable onRemove={removePendingAttachment} onRetry={retryAttachment} />
            </div>
          ) : null}
          {preview.enabled && composeMode==="chat" ? featurePicker.panel : null}
          <div className="composer-energy-shell" data-armed={preview.enabled&&featureForNext.length>0}>
            {preview.enabled?<FeatureArmedRim armed={featureForNext.length>0}/>:null}
            {preview.enabled&&featureForNext.length>0?<div className="selected-feature-list" aria-label="下次回复将使用的超能力"><small>下次回复将使用超能力：</small>{featureForNext.map(feature=><button key={feature.id} type="button" className="selected-feature-chip" aria-label={`取消功能：${feature.name}`} onClick={()=>chooseFeature(feature)}><Sparkles size={13}/><span>{feature.name}</span><X size={12}/></button>)}</div>:null}
          <div className="composer-row">
            <textarea
              id="one-studio-input"
              ref={featurePicker.input}
              aria-controls={featurePicker.isOpen?featurePicker.listId:undefined}
              aria-expanded={featurePicker.isOpen}
              aria-activedescendant={featurePicker.activeOption}
              aria-label="给 ONE 发消息"
              value={content}
              onChange={(event) => {setContent(event.target.value);if(preview.enabled&&composeMode==="chat")featurePicker.update(event.target.value,event.target.selectionStart);}}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              placeholder={composeMode === "execution" ? "补充要求" : currentModel?.kind === "image" ? "描述你想怎么改" : "告诉我，你想做什么"}
              rows={1}
            />
            <button id="one-studio-send" className="primary send" type="submit" aria-label={composeMode === "execution" ? "发送并继续执行" : "发送消息"} title={targetLoading ? (preview.enabled ? "ONE 正在承接这句话，可以先编辑下一条" : "这件事正在回复，可以新开一件事") : "发送消息"} disabled={uploadingAttachments || pendingAttachments.some(a => a.status && a.status !== "ready") || (composeMode === "execution" ? taskStatusUnavailable || preparingExecution || executionBusy || !content.trim() || pendingAttachments.length > 0 : !activeModelId || targetLoading || (!content.trim() && !pendingAttachments.length))}>
              {composeMode === "execution" ? <Zap size={18} /> : <ArrowUp size={19} />}
            </button>
            {composeMode==='chat' && !demo.enabled && outputDestination !== 'notion' && currentModel?.kind==='chat' ? <button type="button" className="composer-execute" aria-label="发送并执行本机任务" title="把当前要求和相关上下文交给本机执行" disabled={!content.trim()||targetLoading||uploadingAttachments||pendingAttachments.length>0||preparingExecution||executionBusy||taskStatusUnavailable} onClick={event=>void executeDraft(content,event.currentTarget,coordinator.enabled?undefined:targetConversation?.id)}><Zap size={16}/><span>本机执行</span></button> : null}
          </div>
          </div>
          <div className="studio-compose-tools">
            <div className="studio-compose-tools-left">{preview.enabled && composeMode==="chat"?<button type="button" className="composer-add-feature" aria-label="添加下一条使用的功能" aria-expanded={featurePicker.isOpen} onClick={featurePicker.open}><Plus size={16}/><span>功能</span></button>:null}
            {canAttach && capabilities.attachments.enabled && composeMode === "chat" ? <label className="studio-attach" title="添加文件或图片"><Paperclip size={15} /><span>{uploadingAttachments ? "上传中" : "附件"}</span><input aria-label="添加附件" type="file" multiple accept={attachmentAccept} disabled={uploadingAttachments} onChange={event => { void uploadAttachments(event.target.files); event.target.value = ""; }} /></label> : <span />}</div>
            {!demo.enabled && composeMode === 'chat' && currentModel?.kind === 'chat' ? <DocumentDestinationPicker api={api} value={outputDestination} onChange={setOutputDestination} localDisabled={taskStatusUnavailable || executionBusy || preparingExecution} localDisabledHint={preparingExecution?'正在准备本机执行，请稍候':executionBusy?'本机任务结束后可保存':taskStatusUnavailable?'暂未确认本机连接，可到设置检查':undefined} onLocalSettings={()=>{setAccountSection('device');openSurface('account');}} onSettings={() => openSurface('knowledge')} /> : null}
            <span className="studio-keyboard-hint">Enter 发送 · ⇧ Enter 换行</span>
          </div>
          <div className="studio-composer-status">
            {!fluidEnabled && active && !composeNew && executionTask && !isExecutionRunning(executionTask) ? <button type="button" className="studio-mode-switch" onClick={() => setComposeMode(mode => mode === "chat" ? "execution" : "chat")}>{composeMode === "execution" ? "切回对话" : "切换到执行"}</button> : executionBusy && composeMode === "chat" ? <p className="studio-context-hint">本机任务仍在执行。</p> : null}
          </div>
        </form>
          {studioIdle ? (
            <div className="studio-suggestions">
              <span>试试这些</span>
              <button type="button" onClick={() => setContent(demo.enabled ? "UI 保留独立输入框，其他事情先收起来" : "帮我回想最近反复提到的重要想法")}><span>{demo.enabled ? '接着上次的 UI 想一想' : '我最近在反复想什么？'}</span><i aria-hidden="true">↗</i></button>
              <button type="button" onClick={() => setContent(demo.enabled ? "明天去露营，先准备个安排" : "结合我的知识，把现在最重要的事情整理成一个行动方案")}><span>{demo.enabled ? '明天去露营，准备一下' : '把一个想法变成行动'}</span><i aria-hidden="true">↗</i></button>
              <button type="button" onClick={() => setContent(demo.enabled ? "UI 先记着这个想法，不要执行" : "从我的个人知识中，找出现在最值得重新关注的内容")}><span>{demo.enabled ? '有个想法，先帮我记着' : '找找被我忘掉的好东西'}</span><i aria-hidden="true">↗</i></button>
            </div>
          ) : null}
        <footer className="studio-assistant-footer"><span className={`connection-dot ${[knowledgeConnection, notionConnection, yinxiangConnection, flowusConnection, flomoConnection].some(item => item.status === "connected") ? "connected" : "disconnected"}`} /><button type="button" onClick={() => openSurface("knowledge")}>{[knowledgeConnection, notionConnection, yinxiangConnection, flowusConnection, flomoConnection].some(item => item.status === "connected") ? "知识已连接" : "连接知识"}</button></footer>
      </aside>

      {fluidEnabled?<>
        <section className="fluid-activity-panel" data-open={fluidPanels.activityOpen} aria-label="任务动态" aria-hidden={!fluidPanels.activityOpen} inert={!fluidPanels.activityOpen} {...fluidInteraction('activity')}>
          <header className="fluid-panel-heading"><h2>任务动态</h2><button type="button" aria-label="收起任务动态" onClick={()=>toggleFluidPanel('activity')}><X size={15}/></button></header>
          <div className="fluid-panel-content" data-fluid-panel-content="activity">
          {renderAttentionInbox()}{renderGuideDelivery()}
          {featureRuns.length?<div className="fluid-feature-runs" aria-label="功能运行进展">{featureRuns.map(run=><article key={run.operationId} data-status={run.status}><button type="button" onClick={()=>openFeatureRun(run.operationId)}><strong>{run.name}</strong><small>{({pending:'正在处理',completed:'成果已返回',failed:'需要查看',interrupted:'已中断'} as Record<string,string>)[run.status]||'查看进展'} ↗</small></button>{run.status!=='pending'?<button type="button" aria-label={`收起${run.name}的动态`} onClick={()=>setFeatureRuns(old=>old.filter(item=>item.operationId!==run.operationId))}><X size={13}/></button>:null}</article>)}</div>:null}
          {featureRunIssue?<p className="fluid-queue-note" role="status">{featureRunIssue}</p>:null}
          {coordinator.enabled ? <TaskTransferRail animateNotes={false} tasks={uniqueTransfers} busy={Boolean(isComposing || coordinator.state.pending)} departureAnchor={()=>document.querySelector<HTMLElement>('[data-task-dispatch-anchor]') || document.querySelector<HTMLElement>('.studio-presence')} returnAnchor={()=>document.querySelector<HTMLElement>('[data-task-return-anchor]') || document.querySelector<HTMLElement>('.coordinator-message.assistant:last-of-type')} recentReportedReceiptIds={coordinator.snapshot?.recentReportedReceiptIds} onReadAll={readAllTaskMessages} onOpenAll={()=>openSurface('things')} onDismiss={task=>coordinator.acknowledge(task.taskId,dismissibleReceiptIds(uniqueTransfers,task.taskId))} onOpen={id=>{const item=conversations.find(c=>c.id===id);if(item)void openConversation(item);}} onStop={async(task,source)=>{const local=executionTasks.find(t=>t.id===task.id&&isExecutionRunning(t));if(local)await cancelExecution(source,local);else await coordinator.stopTask(task.taskId);}} onReport={ids=>coordinator.report(ids)} /> : null}
          {!fluidFeedback.length&&!featureRuns.length&&!attentionCount&&(!delivery||delivery.operationId===dismissedDelivery)?<div className="fluid-panel-empty"><p>这里会接住交出去的任务。</p><small>你可以留在主对话继续聊。</small><button type="button" onClick={()=>openSurface('things')}>查看所有任务 <ArrowUpRight size={12}/></button></div>:null}
                  </div>
        </section>
        <section className="fluid-local-panel" data-open={fluidPanels.localOpen} aria-label="接管任务" aria-hidden={!fluidPanels.localOpen} inert={!fluidPanels.localOpen} {...fluidInteraction('local')}>
          <header className="fluid-panel-heading"><h2>接管任务</h2><button type="button" aria-label="收起本机执行" onClick={()=>toggleFluidPanel('local')}><X size={15}/></button></header>
          <div className="fluid-panel-content" data-fluid-panel-content="local">
          <div className="fluid-runtime-notices">{renderRuntimeNotices()}</div>
          {fluidLocalTask||preparingExecution||awaitingExecutionOperationId?<ExecutionDisclosure idPrefix="fluid-local" task={fluidLocalTask} events={fluidLocalTask?eventsByTask[fluidLocalTask.id]||[]:[]} preparing={preparingExecution||Boolean(awaitingExecutionOperationId)} expanded={true} onToggle={()=>toggleFluidPanel('local')} onStop={source=>void cancelExecution(source,fluidLocalTask)} onContinue={source=>void sendExecutionMessage(executionResumeInstruction,fluidLocalTask,source,true)} actorRole={user.role} onReconciled={rememberReconciledExecution} continuationDisabled={preparingExecution||executionBusy||taskStatusUnavailable} onCheck={()=>{if(fluidLocalTask)void loadLatestExecution(fluidLocalTask.conversationId,fluidLocalTask.id,true);}}/>:<div className="fluid-panel-empty"><p>电脑现在空闲。</p><small>需要整理文件、处理表格时，直接告诉 ONE。</small><button type="button" onClick={()=>{setAccountSection('device');openSurface('account');}}>本机设置 <ArrowUpRight size={12}/></button></div>}
          {runningExecutions.length>1?<p className="fluid-queue-note">另有 {runningExecutions.length-1} 个任务等待这台电脑处理</p>:null}
                  </div>
        </section>
      </>:null}
      {demo.enabled ? <details className="workspace-preview-debug"><summary>本地调试</summary><p>规则分流 / 合成结果，不调用 AI。自动分流示例：UI、露营；其他内容可手动指定。</p><label>任务等待（秒）<input type="number" min="1" max="120" value={preview.state.workerMs/1000} onChange={event=>preview.dispatch({type:'settings',workerMs:Math.max(1,Math.min(120,Number(event.target.value)||1))*1000})}/></label><label><input type="checkbox" checked={preview.state.manual} onChange={event=>preview.dispatch({type:'settings',manual:event.target.checked})}/>手动结束任务</label>{preview.state.tasks.map(task=><div key={task.id}><button type="button" onClick={()=>void openConversation(conversations.find(item=>item.id===task.id)!)}>{task.title}</button><span>{task.status} · 排队 {task.queue.length}</span><button type="button" disabled={task.status!=='running'} onClick={()=>preview.dispatch({type:'finish',taskId:task.id,round:task.round,now:Date.now()})}>模拟完成</button></div>)}</details> : null}
      </div>
      {preview.enabled?<>
        {visitedLayers.includes('features')||workLayer==='features'?<FluidWorkLayer title="功能与分身" open={workLayer==='features'} className="fluid-work-layer-features" onClose={closeWorkLayer}>{renderFeatures()}</FluidWorkLayer>:null}
        {visitedLayers.includes('account')||workLayer==='account'?<FluidWorkLayer title="设置" open={workLayer==='account'} className="fluid-work-layer-account" onClose={closeWorkLayer}>{renderAccount()}</FluidWorkLayer>:null}
        {workLayer==='things'?<FluidWorkLayer title="任务与成果" className="fluid-work-layer-things" onClose={closeWorkLayer}>{renderThings()}</FluidWorkLayer>:null}
        {workLayer==='history'?<FluidWorkLayer title={showArchived?'已归档记录':'历史记录'} className="fluid-work-layer-history" onClose={closeWorkLayer}>{renderHistory()}</FluidWorkLayer>:null}
        {workLayer==='admin'&&user.role==='admin'?<FluidWorkLayer title="管理" initialMaximized onClose={closeWorkLayer}><AdminPanel actorId={user.id} refreshModels={refresh} onOpenSidebar={openHistory}/></FluidWorkLayer>:null}
        {workLayer==='company'&&user.access?.role==='company_admin'?<FluidWorkLayer title="公司管理" initialMaximized onClose={closeWorkLayer}><CompanyPanel api={api}/></FluidWorkLayer>:null}
        {workLayer==='guide'?<FluidWorkLayer title="重新认识 ONE" className="fluid-work-layer-guide" onClose={dismissStory}>{renderStory()}</FluidWorkLayer>:null}
        {featureRuns.filter(run=>run.status==='pending').map(run=><FeatureRunMonitor key={run.operationId} api={api} operationId={run.operationId} enabled={viewedFeatureOperation!==run.operationId} onStatus={updateFeatureRun} onUnavailable={setFeatureRunIssue}/>) }
      </>:null}
      {preview.enabled?<FeatureHandoff transfer={featureTransfer} target={()=>document.querySelector<HTMLElement>('.studio-composer .composer-energy-shell')}  onComplete={()=>setFeatureTransfer(current=>current?.id===featureTransfer?.id?null:current)}/>:null}
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
          <label>固定模型<SearchPicker label="固定模型" value={draft.modelId} onChange={modelId => setDraft({ ...draft, modelId })} options={chatModels.map(model => ({ value: model.id, label: model.name }))} /><small>保存后，使用者无法更改此智能体的模型</small></label>
        </section>
        <section><h3>外观</h3><div className="appearance-options"><div>{emojis.map((emoji) => <button type="button" key={emoji} className={draft.avatar === emoji ? "active" : ""} onClick={() => setDraft({ ...draft, avatar: emoji })}>{emoji}</button>)}</div><div>{colors.map((color) => <button type="button" aria-label={color} key={color} className={draft.color === color ? "active" : ""} style={{ background: color }} onClick={() => setDraft({ ...draft, color })} />)}</div></div></section>
        <section><h3>指令</h3><label>系统提示词<textarea rows={10} maxLength={6000} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder="角色、流程、边界、输出格式" /><small>{draft.prompt.length} / 6000</small></label></section>
        <fieldset className="agent-tool-settings"><legend>可用能力</legend><label><input type="checkbox" checked={draft.allowFileUpload} onChange={(e) => setDraft({ ...draft, allowFileUpload: e.target.checked, allowImageInput: e.target.checked ? draft.allowImageInput : false })} /><span><Paperclip size={16} />文件上传</span></label><label><input type="checkbox" checked={draft.allowImageInput} disabled={!draft.allowFileUpload} onChange={(e) => setDraft({ ...draft, allowImageInput: e.target.checked })} /><span><Image size={16} />图片理解</span></label><label><input type="checkbox" checked={draft.allowWebSearch} onChange={(e) => setDraft({ ...draft, allowWebSearch: e.target.checked })} /><span><Globe2 size={16} />联网搜索</span></label></fieldset>
        {error ? <div className="error">{error}</div> : null}
      </form>
      <section className="agent-debug"><header><div><strong>预览与调试</strong><small>{chatModels.find((model) => model.id === draft.modelId)?.name || "尚未选择模型"}</small></div><button className="secondary" onClick={() => setDebugMessages([])}>清空</button></header><div className="debug-messages">{debugMessages.length ? debugMessages.map((message, index) => <div key={index} className={`debug-message ${message.role}`}><MessageMarkdown>{message.content}</MessageMarkdown></div>) : <div className="debug-empty"><span style={{ background: draft.color }}>{draft.avatar}</span><h3>{draft.name || "你的智能体"}</h3><p>{draft.description || "发一条消息测试"}</p></div>}{debugging ? <div className="typing">正在生成测试回答…</div> : null}</div><form className="debug-composer" onSubmit={debug}><textarea rows={2} value={debugInput} onChange={(e) => setDebugInput(e.target.value)} placeholder="输入一条测试消息" /><button className="primary send" disabled={!debugInput.trim() || !draft.modelId || debugging}><Send size={17} /></button></form></section>
    </div>
  </section>;
}

function AccountPage({ user, profile, onSaveProfile, onOpenGuide, models, defaultModelId, onModelChange, onOpenSidebar, section, setSection, knowledge }: { user: User; profile: AccountProfile; onSaveProfile: (patch: ProfilePatch) => Promise<unknown>; onOpenGuide:()=>Promise<unknown>; models: Model[]; defaultModelId: string; onModelChange: () => Promise<void>; onOpenSidebar: () => void; section: string; setSection: (section: string) => void; knowledge: React.ReactNode }) {
  const api = useContext(PrivateApiContext);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState("");
  const [openingGuide,setOpeningGuide]=useState(false);
  const [passwordOpen,setPasswordOpen]=useState(false);
  const guidePending=!!profile.onboarding.journey&&profile.onboarding.journey.stage!=='complete';
  const guideButton=<button type="button" disabled={openingGuide} onClick={()=>{setOpeningGuide(true);void onOpenGuide().catch(e=>setNotice(e.message)).finally(()=>setOpeningGuide(false));}}>{openingGuide?'正在打开…':guidePending?'继续新手引导':'重新走一遍引导'}<ArrowUpRight size={15}/></button>;
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
      setPasswordOpen(false);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "密码修改失败");
    }
  }

  return (
    <section className="account-page account-preferences">
      <header className="admin-header">
        <button className="mobile-menu" title="打开导航" onClick={onOpenSidebar}><Menu size={20} /></button>
        <div>
          <h2>设置</h2>
          <p>{profile.displayName || user.username} · {user.role === "admin" ? "管理员" : "ONE 用户"}</p>
        </div>
      </header>
      <AccountPreferencesLayout section={section} onChange={setSection}>
        {guidePending&&section!=='profile'?<div className="story-settings-return"><span>新手引导还在，接好后回来继续。</span>{guideButton}</div>:null}
        {section === "device" ? <LocalDeviceSettings key={user.id} api={api}/> : section === "knowledge" ? <>{knowledge}<FeatureBudgetSettings key={user.id} api={api}/></> : section === "power" ? user.access?.kind === "company" ? <div className="settings-empty"><p>费用由公司按协议对公打款承担，无需个人充值。</p><p>公司可用电力：{((billing?.availableMicros??0)/1e6).toFixed(3)}；个人额度由公司管理员配置。</p></div> : billing ? <PaymentPanel userId={user.id} api={api} rate={billing.rechargeCnyPerPower} balance={billing.balanceMicros} reserved={billing.reservedMicros} onPaid={loadBilling} /> : <p className="settings-empty">正在加载会员与额度…</p> : <>
        <div className="account-profile-grid">
        <AppearanceSettings profile={profile} onSave={onSaveProfile}/>
        <section className="account-panel"><h3>个人资料</h3><ProfileNameEditor profile={profile} onSave={onSaveProfile} /></section>
        <ContextSettings key={'context-'+user.id} api={api}/>
        <AttentionSettings key={'attention-'+user.id} api={api}/>
        <SavedWelcomeGuides api={api}/>
        <section className="account-panel story-settings-entry"><h3>新手引导</h3><p className="settings-muted">重新填写偏好，现有资料和任务都保留。</p>{guideButton}</section>
        <details className="account-panel account-advanced-settings">
          <summary>高级设置 · 默认模型</summary>
          <SearchPicker label="默认模型" value={selectedModelId} onChange={chooseModel} options={models.filter(model => model.kind === "chat").map(model => ({ value: model.id, label: model.name }))} />
        </details>
        {user.role === "admin" ? <section className="account-panel account-span-full settings-security-entry"><div><div className="account-panel-title"><LockKeyhole size={18} /><h3>账号安全</h3></div><p className="settings-muted">需要时再更新登录密码。</p></div><button type="button" onClick={()=>{setNotice('');setPasswordOpen(true);}}>修改密码</button></section> : null}
        </div>
        {passwordOpen?<SettingsDialog title="修改密码" onClose={()=>{setPasswordOpen(false);setCurrentPassword('');setNewPassword('');setConfirmPassword('');}}><form className="settings-password-form" onSubmit={changePassword}>
          <label>当前密码<input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></label>
          <label>新密码<input type="password" autoComplete="new-password" placeholder="至少 8 个字符" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></label>
          <label>确认新密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
          {notice?<p role="status">{notice}</p>:null}
          <button className="primary" type="submit" disabled={!currentPassword || newPassword.length < 8 || !confirmPassword}>更新密码</button>
        </form></SettingsDialog>:null}
        </>}
        {notice ? <div className="notice account-wide-notice">{notice}</div> : null}
      </AccountPreferencesLayout>
    </section>
  );
}

function AdminPanel({ actorId, refreshModels, onOpenSidebar }: { actorId: string; refreshModels: () => Promise<void>; onOpenSidebar: () => void }) {
  const api = useContext(PrivateApiContext);
  const [billingSection, setBillingSection] = useState("pricing");
  const [tab, setTab] = useState<"overview" | "users" | "keys" | "models" | "billing" | "usage" | "contexts" | "logs" | "ai-tasks" | "official-features" | "companies">("overview");
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
          <button className={tab === "companies" ? "active" : ""} onClick={() => setTab("companies")}><Users size={16}/>企业</button>
          <button className={tab === "keys" ? "active" : ""} onClick={() => setTab("keys")}><Usb size={16} />ONE Key</button>
          <button className={tab === "models" ? "active" : ""} onClick={() => setTab("models")}><Bot size={16} />模型</button>
          <button className={tab === "ai-tasks" ? "active" : ""} onClick={() => setTab("ai-tasks")}><Bot size={16} />能力配置</button>
          <button className={tab === "official-features" ? "active" : ""} onClick={() => setTab("official-features")}><Bot size={16} />官方功能</button>
          <button className={tab === "billing" ? "active" : ""} onClick={() => setTab("billing")}><Wallet size={16} />电力与收费</button>
          <button className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}><ReceiptText size={16} />用户用量</button>
          <button className={tab === "contexts" ? "active" : ""} onClick={() => setTab("contexts")}><Eye size={16} />上下文</button>
          <button className={tab === "logs" ? "active" : ""} onClick={() => setTab("logs")}><FileText size={16} />日志</button>
        </nav>
        {notice ? <div className="notice">{notice}</div> : null}
        <div className="admin-body">
          {tab === "overview" ? <><ProductMetricsPanel api={api} accounts={users}/><details className="quiet-details"><summary>系统与账务状态</summary><AdminOverview operations={operations}/></details></> : null}
          {tab === "companies" ? <CompanyPanel api={api} platform/> : null}
          {tab === "users" ? <UsersTab users={users} reload={load} /> : null}
          {tab === "keys" ? <OneKeysTab users={users} devices={devices} reload={load} /> : null}
          {tab === "models" ? <ModelsTab models={models} reload={async () => { await load(); await refreshModels(); }} /> : null}
          {tab === "ai-tasks" ? <UnifiedCapabilityPanel api={api} models={models} /> : null}
          {tab === "official-features" ? <OfficialFeaturePanel api={api} /> : null}
          {tab === "billing" ? <div className="admin-pricing-center"><nav className="settings-tabs"><button aria-pressed={billingSection === "pricing"} onClick={() => setBillingSection("pricing")}>模型与定价</button><button aria-pressed={billingSection === "accounts"} onClick={() => setBillingSection("accounts")}>充值、赠送与汇率</button><button aria-pressed={billingSection === "membership"} onClick={() => setBillingSection("membership")}>会员与启动器</button></nav>{billingSection === "pricing" ? <PricingCatalog api={api} models={models} reload={load} /> : billingSection === "membership" ? <MembershipAdminPanel api={api} users={users} /> : <AdminBilling actorId={actorId} users={users} operations={operations} reload={load} />}</div> : null}
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
  const [batchGift, setBatchGift] = useState("10"); const [batchTitle, setBatchTitle] = useState("内测统一赠送"); const [rate, setRate] = useState(String(operations?.settings.rechargeCnyPerPower || 7)); const [notice, setNotice] = useState("");
  const [section, setSection] = useState("orders");
  const [orderQuery, setOrderQuery] = useState("");
  const orders = (operations?.pendingOrders || []).filter(o => `${o.username} ${o.id}`.toLowerCase().includes(orderQuery.trim().toLowerCase()));
  const [ordersOpen, setOrdersOpen] = useState(true); const [orderPage, setOrderPage] = useState(1); const orderPageSize = 10;
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
  const [approving, setApproving] = useState("");
  async function approve(order: RechargeOrder) {
    if (approving || (!order.payment && !confirm(`确认已收到 ${order.username} 的 ¥${order.amountCny.toFixed(2)}？`))) return;
    setApproving(order.id); setNotice("");
    try { const result = await api<{ message?: string }>(`/api/admin/recharge-orders/${order.id}/${order.payment ? "check" : "approve"}`, { method: "POST" }); setNotice(result.message || "充值已入账"); await reload(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "核对失败"); }
    finally { setApproving(""); }
  }
  return <div className="admin-billing-sections">
    <nav className="settings-tabs">{[["orders", "充值核对"], ["gift", "账户额度"], ["batch", "批量赠送"], ["history", "赠送记录"], ["rate", "充值汇率"]].map(([id, title]) => <button type="button" key={id} aria-pressed={section === id} onClick={() => { setSection(id); setNotice(""); }}>{title}</button>)}</nav>
    {notice ? <p className="notice" role="status">{notice}</p> : null}
    {section === "history" ? <GiftBatchHistory api={api} revision={notice} /> : null}
    <div className="admin-form-stack">
      <div hidden={section!=="gift"}><AdminPowerControls key={actorId} actorId={actorId} users={users} api={api} reload={reload}/></div>
      <form hidden={section !== "batch"} className="admin-form" onSubmit={giveBatch}><h3>批量赠送</h3><label>每位启用成员赠送<input type="number" min="0.000001" step="0.000001" value={batchGift} onChange={(event) => setBatchGift(event.target.value)} /></label><label>批次说明<input value={batchTitle} onChange={(event) => setBatchTitle(event.target.value)} maxLength={80} /></label><button className="secondary">给全部启用成员赠送</button><small className="hint">管理员也包含在启用成员内；每位成员都会留下独立电力账本记录。</small></form>
      <form hidden={section !== "rate"} className="admin-form" onSubmit={saveRate}><h3>人民币充值汇率</h3><p className="hint">1 电力对应 1 美元计价单位。这里仅决定人民币充值到账多少电力，不改变模型美元价格或已有余额。</p><label>1 电力 = 人民币<input type="number" min="0.01" step="0.01" value={rate} onChange={(event) => setRate(event.target.value)} /></label><button className="secondary">保存汇率</button></form>
    </div>
    <div className="table" hidden={section !== "orders"}><input type="search" aria-label="搜索充值订单" placeholder="搜索用户或订单号" value={orderQuery} onChange={e => { setOrderQuery(e.target.value); setOrderPage(1); }} /><button type="button" className="section-toggle" onClick={() => setOrdersOpen(open => !open)} aria-expanded={ordersOpen}><h3>待入账充值</h3><span>{orders.length || 0} 笔 · {ordersOpen ? "收起" : "展开"}</span></button>{ordersOpen ? orders.length ? <>{orders.slice((orderPage - 1) * orderPageSize, orderPage * orderPageSize).map((order) => <div className="table-row" key={order.id}><span>{order.username}<small>{dateTime(order.createdAt)}</small></span><span>{power(order.requestedMicros)} 电力 · ¥{order.amountCny.toFixed(2)}</span><button type="button" className="primary" disabled={!!approving} onClick={() => void approve(order)}>{approving === order.id ? "核对中…" : order.payment ? "核对微信支付" : "确认入账"}</button></div>)}<Pagination page={orderPage} total={orders.length} size={orderPageSize} onChange={setOrderPage} /></> : <div className="empty-state compact">暂无待处理充值</div> : null}</div>
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
  return activity === "attachment_summary" ? "附件分段总结" : activity === "execution_compile" ? "整理执行指令" : activity === "local_agent" ? "本机执行" : "AI 问答";
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
  const [cacheUsage, setCacheUsage] = useState(usage.cacheUsage || { read: 0, write: 0, write5m: 0, write1h: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function resolve(action: "waive" | "provider_usage") {
    if (!confirm(action === "waive" ? "确认不向该用户扣费并释放这次预占电力？此操作会留下核对记录。" : "确认输入的是中转站实际返回的 Token 用量？将按本次调用的价格结算。")) return;
    setBusy(true); setError("");
    try {
      await api(`/api/admin/users/${encodeURIComponent(userId)}/usage/${encodeURIComponent(usage.id)}/resolve`, { method: "POST", body: JSON.stringify(action === "waive" ? { action } : { action, inputTokens: Number(inputTokens), outputTokens: Number(outputTokens), cacheUsage }) });
      onResolved();
    } catch (err) { setError(err instanceof Error ? err.message : "核对失败"); }
    finally { setBusy(false); }
  }
  return <details className="usage-reconcile"><summary>核对这次调用</summary><p className="hint">按请求编号核对中转站账单。无法确认可暂存；免扣不代表上游免费。</p><div className="ops-list-toolbar"><label>普通输入 Token（不含缓存）<input type="number" min="0" step="1" value={inputTokens} onChange={(event) => setInputTokens(event.target.value)} /></label><label>实际输出 Token<input type="number" min="0" step="1" value={outputTokens} onChange={(event) => setOutputTokens(event.target.value)} /></label><button className="primary" type="button" disabled={busy || inputTokens === "" || outputTokens === "" || !Number.isSafeInteger(Number(inputTokens)) || Number(inputTokens) < 0 || !Number.isSafeInteger(Number(outputTokens)) || Number(outputTokens) < 0} onClick={() => void resolve("provider_usage")}>按实际用量结算</button><button className="secondary" type="button" disabled={busy} onClick={() => void resolve("waive")}>免扣并释放预占</button></div><details><summary>缓存用量（Token）</summary><div className="pricing-field-grid">{(["read", "write", "write5m", "write1h"] as const).map(key => <label key={key}>{({read:"缓存读取",write:"写入总量",write5m:"其中 5 分钟写入",write1h:"其中 1 小时写入"})[key]}<input type="number" min="0" step="1" value={cacheUsage[key]} onChange={e => setCacheUsage({ ...cacheUsage, [key]: Number(e.target.value) })} /></label>)}</div></details>{usage.cacheUsage && !usage.cachePricesSnapshot ? <p className="hint">该次调用缺少缓存价格快照，请免扣释放预占；先配置缓存价再继续调用。</p> : null}{error ? <div className="error">{error}</div> : null}</details>;
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
  const [userPage, setUserPage] = useState(1);
  useEffect(() => { setUserPage(1); setSelectedUserId(""); }, [search, status]);

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
    {!visible.length ? <div className="empty-state compact">没有符合条件的用户</div> : null}
    {visible.slice((userPage - 1) * 10, userPage * 10).map((item) => {
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
            <span><small>累计消耗电力</small><strong>{power(item.total.chargedMicros, 6)}</strong></span>
            <span><small>累计消耗 / 上游成本（电力）</small><strong>{power(item.total.chargedMicros, 4)} / {power(item.total.costMicros, 4)}</strong>{item.total.unknownCostCalls ? <small>{item.total.unknownCostCalls} 次成本未确认，合计仅含已知成本</small> : null}</span>
            <span><small>已知计费差额（非现金利润）</small><strong>{item.total.unknownCostCalls ? "成本未齐，暂不计算" : power(item.total.chargedMicros - item.total.costMicros, 4)}</strong></span>
            <span><small>对话 / 知识召回 / 本机执行</small><strong>{item.conversationCount} / {item.knowledgeRecallCount} / {item.executionCount}</strong></span>
          </div>
          <div className="ops-list-toolbar"><label>明细时间范围<select value={period} onChange={(event) => { setDetail(null); setPeriod(event.target.value); setOffset(0); }}><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="all">全部时间</option></select></label><span>日志时间按本机时区显示</span></div>
          {error ? <div className="error">{error}<button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>重试</button></div> : !currentDetail ? <div className="empty-state compact" role="status">正在读取 {item.username} 的用量…</div> : <>
            {currentDetail.diagnostics?<section className="usage-detail-section" aria-label="消耗重点"><h4>消耗重点 · 当前时间范围</h4><p>实际消耗 {power(currentDetail.diagnostics.chargedMicros,6)} 电力，其中缓存写入约 {power(currentDetail.diagnostics.cacheWriteMicros,6)}，缓存读取约 {power(currentDetail.diagnostics.cacheReadMicros,6)}。</p><p className="hint">缓存费用已包含在总消耗中，按售价快照归因，不是额外扣费或供应商账单。高消耗不等于全部浪费；未采集上下文大小的历史记录显示“—”。</p><div className="mini-ledger">{currentDetail.diagnostics.topRequests.slice(0,5).map(r=><div key={r.requestId}><span>{r.requestId}<small>{r.calls} 次调用 · {r.state==='failed'?'未完成':r.state==='completed'?'本轮已返回':r.state==='pending'?'进行中':'需结合任务核对'} · 输入合计 {r.profiledCalls?`${Math.round(r.inputBytes/1024)} KB（${r.profiledCalls}/${r.calls} 次有记录）`:'—'}</small></span><b>{power(r.chargedMicros,6)} 电力</b></div>)}</div></section>:null}
            <details className="usage-detail-section" open>
              <summary>逐次模型调用（共 {currentDetail.pagination.total} 次）</summary>
              {currentDetail.usage.length ? <div className="ops-table"><div className="ops-table-head"><span>用途 / 模型 / 状态</span><span>消耗明细（电力）</span><span>消耗 / 上游成本（电力）</span><span>时间 / 耗时 / 请求</span></div>{currentDetail.usage.map((usage) => {
                const costUnknown = usage.costMicros === undefined;
                return <React.Fragment key={usage.id}><div className="ops-table-row"><span><strong>{usageActivityLabel(usage.activity)}</strong><small>{usage.modelName || "模型已移除"}</small><small className={costUnknown ? "usage-review-status" : ""}>{usageStatusLabel(usage)}</small></span><span><CacheUsageDetails row={usage} /></span><span>{power(usage.chargedMicros, 6)} / {costUnknown ? "待核对" : power(usage.costMicros, 6)}</span><span>{dateTime(usage.createdAt)}{usage.durationMs !== undefined ? <small>耗时 {(usage.durationMs / 1000).toFixed(1)} 秒</small> : null}<small>{usage.requestId || "-"}</small></span></div>{usage.status === "needs_review" ? <UsageReconcileForm userId={item.userId} usage={usage} onResolved={() => { setRetry((value) => value + 1); void reload(); }} /> : null}</React.Fragment>;
              })}</div> : <div className="empty-state compact">该时间范围内没有模型调用</div>}
              {currentDetail.pagination.total > currentDetail.pagination.limit ? <div className="ops-pagination"><button className="secondary" type="button" disabled={offset === 0} onClick={() => { setDetail(null); setOffset(Math.max(0, offset - 20)); }}><ChevronLeft size={14} />上一页</button><span>第 {Math.floor(offset / 20) + 1} / {Math.ceil(currentDetail.pagination.total / 20)} 页</span><button className="secondary" type="button" disabled={!currentDetail.pagination.hasMore} onClick={() => { setDetail(null); setOffset(offset + 20); }}>下一页<ChevronRight size={14} /></button></div> : null}
            </details>
            <details className="usage-detail-section">
              <summary>使用活动日志（共 {currentDetail.activityTotal} 条{currentDetail.activityTotal > currentDetail.activity.length ? `，最近 ${currentDetail.activity.length} 条可见` : ""}）</summary>
              {currentDetail.activity.length ? <div className="mini-ledger">{currentDetail.activity.slice(activityLimit - 20, activityLimit).map((activity) => <div key={activity.id}><span><strong>{usageActionLabel(activity.action)}</strong><small>{activity.requestId || "无请求编号"}</small></span><b>{dateTime(activity.createdAt)}</b></div>)}</div> : <div className="empty-state compact">该时间范围内没有使用活动</div>}
              <Pagination page={activityLimit / 20} size={20} total={currentDetail.activity.length} onChange={page => setActivityLimit(page * 20)} />
            </details>
          </>}
        </div> : null}
      </section>;
    })}
    <Pagination page={userPage} total={visible.length} onChange={page => { setUserPage(page); setSelectedUserId(""); }} />
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
        <span>{trace.username} · {trace.modelName}{trace.executionStepCount ? ` · ${trace.executionStepCount} 个工具步骤` : ""}</span>
        <small>{dateTime(trace.createdAt)}</small>
      </button>)}
    </aside>
    <section className="context-detail">
      {error ? <div className="error">{error}</div> : null}
      {detail ? <>
        <header><div><small>{detail.username} · {detail.modelName}</small><h3>{detail.query}</h3></div><span>{dateTime(detail.createdAt)}<small>{detail.requestId || "-"}</small></span></header>
        {detail.executionSteps?.length ? <article className="context-section"><h4>调度步骤（按需展开）</h4>{detail.executionSteps.map((step, index) => <details key={`${step.step}-${index}`}><summary>第 {step.step} 步 · {step.tool} · {step.status} · {step.durationMs} ms</summary><p>{step.query || "无查询参数"}</p><pre>{step.resultPreview}</pre></details>)}</article> : null}
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
    <form className="admin-form" onSubmit={provision}><h3><Usb size={17} />初始化 ONE Key</h3><label>绑定用户<SearchPicker label="绑定用户" value={userId} onChange={setUserId} options={users.map(user => ({ value: user.id, label: user.profile?.displayName || user.username, hint: user.username }))} /></label><label>设备序列号<input value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} /></label><p className="hint">私钥仅下载一次；服务端仅存公钥。普通 U 盘可复制，不等同安全芯片。</p><button className="primary" disabled={!userId || !serialNumber.trim()}>生成并下载凭证</button>{notice ? <div className="notice">{notice}</div> : null}</form>
    <div className="table"><div className="ops-list-toolbar"><label>搜索用户或序列号<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>Key 状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="active">正常使用</option><option value="revoked">已挂失 / 归档</option><option value="all">全部</option></select></label></div>{matching.slice(limit - 20, limit).map((device) => <div className="table-row" key={device.id}><span><strong>{device.serialNumber}</strong><small>{device.username} · {device.lastUsedAt ? `最近使用 ${dateTime(device.lastUsedAt)}` : "尚未使用"}</small></span><span>{device.status === "active" ? "正常" : "已挂失 / 归档"}</span>{device.status === "active" ? <button className="danger" onClick={() => revoke(device)}>挂失</button> : <span />}</div>)}<Pagination page={limit / 20} size={20} total={matching.length} onChange={page => setLimit(page * 20)} />{!matching.length ? <p className="hint">没有符合条件的 Key</p> : null}</div>
  </div>;
}

function UsersTab({ users, reload }: { users: User[]; reload: () => Promise<void> }) {
  const api = useContext(PrivateApiContext);
  const [username, setUsername] = useState("");
  const [editing, setEditing] = useState<Record<string, { username: string; enabled: boolean }>>({});
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const filteredUsers = users.filter(user => `${user.username} ${user.profile?.displayName || ""}`.toLowerCase().includes(search.trim().toLowerCase()));

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
    try { await api(`/api/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !user.enabled }) }); await reload(); }
    catch(e) { setCreateNotice(e instanceof Error ? e.message : "更新失败"); }
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
        <div className="ops-list-toolbar"><label>搜索账号<input type="search" placeholder="用户名或称呼" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label><span>{filteredUsers.length} 个账号</span></div>
        {filteredUsers.slice((page - 1) * pageSize, page * pageSize).map((user) => (
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
        {!filteredUsers.length ? <p className="empty-state compact">没有符合条件的账号</p> : null}
        <Pagination page={page} total={filteredUsers.length} size={pageSize} onChange={setPage} />
      </div>
    </div>
  );
}


function ModelsTab({ models, reload }: { models: Model[]; reload: () => Promise<void> }) {
  const api = useContext(PrivateApiContext);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""), [page, setPage] = useState(1);
  const filtered = models.filter(m => `${m.name} ${m.model}`.toLowerCase().includes(query.trim().toLowerCase()));
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
    await api("/api/admin/models", { method: "POST", body: JSON.stringify({ ...form, enabled: false, isDefault: false, inputPowerPerMillion: 0, outputPowerPerMillion: 0, costInputPowerPerMillion: 0, costOutputPowerPerMillion: 0, imagePowerPerCall: 0, costImagePowerPerCall: 0 }) });
    setForm({ name: "", kind: "chat", protocol: "openai", baseUrl: "https://app.yylx.io/v1", apiKey: "", model: "", systemPrompt: "", inputPowerPerMillion: 3, outputPowerPerMillion: 15, costInputPowerPerMillion: 2, costOutputPowerPerMillion: 10, imagePowerPerCall: 0, costImagePowerPerCall: 0, enabled: true, isDefault: false });
    await reload();
  }

  async function toggle(model: Model) {
    try { await api(`/api/admin/models/${model.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !model.enabled }) }); await reload(); setNotice(""); }
    catch(e) { setNotice(e instanceof Error ? e.message : "更新失败"); }
  }

  async function saveModel(model: Model) {
    const draft = editing[model.id];
    if (!draft) return;
    const payload = { ...draft } as Record<string, unknown>;
    for (const field of ["inputPowerPerMillion", "outputPowerPerMillion", "costInputPowerPerMillion", "costOutputPowerPerMillion", "imagePowerPerCall", "costImagePowerPerCall"]) delete payload[field];
    await api(`/api/admin/models/${model.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
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
        {notice ? <p role="status" className="notice">{notice}</p> : null}
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
        <p className="hint">保存后，在「电力与收费 → 模型与定价」配置价格，再启用。</p>
        <textarea placeholder="模型默认 System Prompt，可留空" value={form.systemPrompt} rows={4} onChange={(event) => setForm({ ...form, systemPrompt: event.target.value })} />

        <button className="primary"><Plus size={16} />保存模型</button>
      </form>
      <div className="table">
        <input type="search" aria-label="搜索接入模型" placeholder="搜索模型" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} />
        {filtered.slice((page - 1) * 8, page * 8).map((model) => (
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
                <p className="hint">价格在「电力与收费 → 模型与定价」配置。</p>
                <label className="field-label model-prompt-field">System Prompt<textarea rows={4} value={editing[model.id].systemPrompt} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], systemPrompt: event.target.value } })} /></label>
                <label className="inline-check"><input type="checkbox" checked={editing[model.id].enabled} onChange={(event) => setEditing({ ...editing, [model.id]: { ...editing[model.id], enabled: event.target.checked } })} />启用</label>
                <label className="inline-check"><input type="radio" checked={editing[model.id].isDefault} disabled={editing[model.id].kind !== "chat" || !editing[model.id].enabled} onChange={() => setEditing({ ...editing, [model.id]: { ...editing[model.id], isDefault: true } })} />新聊天默认</label>
                <button className="secondary" onClick={() => saveModel(model)}><Save size={15} />保存</button>
              </>
            ) : (
              <>
                <span>{model.name}<small>{model.kind === "image" ? "图片" : model.protocol === "anthropic" ? "聊天 · Anthropic" : "聊天 · OpenAI"} · {model.model}{model.isDefault ? " · 新聊天默认" : ""}</small></span>
                <span>{model.hasApiKey ? "已配置 Key" : "缺少 Key"}<small>{model.kind === "image" ? `售价 ${model.imagePowerPerCall || "未配置"} 电力 / 次` : `售价 ${model.inputPowerPerMillion} / ${model.outputPowerPerMillion} 电力 / 百万 Token`}</small></span>
                {model.kind === "chat" && !model.pricing ? <small>请前往「模型与定价」发布价格</small> : null}
                <button className="secondary" onClick={() => setEditing({ ...editing, [model.id]: { name: model.name, kind: model.kind, protocol: model.protocol, baseUrl: model.baseUrl, model: model.model, apiKey: "", systemPrompt: model.systemPrompt || "", inputPowerPerMillion: model.inputPowerPerMillion, outputPowerPerMillion: model.outputPowerPerMillion, costInputPowerPerMillion: model.costInputPowerPerMillion, costOutputPowerPerMillion: model.costOutputPowerPerMillion, imagePowerPerCall: model.imagePowerPerCall ?? 0, costImagePowerPerCall: model.costImagePowerPerCall ?? 0, enabled: model.enabled, isDefault: model.isDefault } })}><Edit3 size={15} />编辑</button>
                <button className="secondary" onClick={() => toggle(model)}>{model.enabled ? "停用" : "启用"}</button>
                <button className="danger" onClick={() => deleteModel(model)}><Trash2 size={15} />删除</button>
              </>
            )}
          </div>
        ))}
        <Pagination page={page} total={filtered.length} size={8} onChange={setPage} />
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const privateApi = useMemo(() => user ? apiForUser(user.id,user.access?.workspaceId??user.defaultWorkspaceId) : api, [user?.id,user?.access?.workspaceId]);
  const [booting, setBooting] = useState(true);
  const [bootMessage, setBootMessage] = useState("加载中…");
  const [bootError, setBootError] = useState("");
  const [recoveryLogin, setRecoveryLogin] = useState(false);
  const [updateRecovery, setUpdateRecovery] = useState("");
  const bootGeneration = useRef(0);
  const currentUser = useRef<User | null>(null);
  currentUser.current = user;
  async function boot(quiet = false) {
    const generation = ++bootGeneration.current;
    expectUser(""); if (!quiet) setBooting(true); setBootError(""); setUser(null);
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const loginCode = fragment.get("one-key");
    if (loginCode) window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}`);
    try {
      setBootMessage(loginCode ? "正在验证 ONE Key…" : "正在连接…");
      const result = loginCode ? await api<{ user: User; access?: ReturnType<typeof identityAccess> }>("/api/auth/one-key/redeem", { method: "POST", body: JSON.stringify({ loginCode }) }) : await api<{ user: User; access?: ReturnType<typeof identityAccess> }>("/api/me");
      if (generation !== bootGeneration.current) return;
      expectUser(result.user.id,result.access?.workspaceId??result.user.defaultWorkspaceId); setUser({...result.user,access:result.access}); setRecoveryLogin(false); setUpdateRecovery("");
      if (loginCode) announceSessionChange();
    } catch (error) {
      if (generation !== bootGeneration.current) return;
      setBootError(error instanceof ApiError && error.status === 401 ? "请插入 ONE Key。首次使用请从 U 盘打开 ONE。" : error instanceof Error ? error.message : "暂时连不上 ONE，请检查网络后重试。");
      try {
        const runtime = await api<RuntimeUpdateStatus>("/api/runtime/update", { signal: AbortSignal.timeout(10_000) });
        if (generation === bootGeneration.current) setUpdateRecovery(runtimeRecoveryMessage(runtime));
      } catch {
        if (generation === bootGeneration.current) setUpdateRecovery("");
      }
    } finally { if (generation === bootGeneration.current) setBooting(false); }
  }
  useEffect(() => {
    void boot();
    const changed = () => { void boot(); };
    const storage = (event: StorageEvent) => { if (event.key === SESSION_STORAGE_KEY) changed(); };
    const checkIdentity = () => {
      if (document.visibilityState !== "visible") return;
      if (!currentUser.current) { void boot(); return; }
      void api<{ user: User; access?: ReturnType<typeof identityAccess> }>("/api/me").then(result => { if (result.user.id !== currentUser.current?.id || JSON.stringify(result.access)!==JSON.stringify(currentUser.current?.access)) void boot(); }).catch(error => {
        if (error instanceof ApiError && error.status === 401) void boot();
      });
    };
    window.addEventListener(SESSION_EVENT, changed);
    window.addEventListener("storage", storage);
    window.addEventListener("online", checkIdentity);
    document.addEventListener("visibilitychange", checkIdentity);
    return () => { bootGeneration.current++; window.removeEventListener(SESSION_EVENT, changed); window.removeEventListener("storage", storage); window.removeEventListener("online", checkIdentity); document.removeEventListener("visibilitychange", checkIdentity); };
  }, []);

  useEffect(() => {
    if (user || !updateRecovery || recoveryLogin) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void boot(true); }, 10_000);
    return () => window.clearInterval(timer);
  }, [user, updateRecovery, recoveryLogin]);

  if (booting) return <div className="boot">{bootMessage}</div>;
  if (!user) return recoveryLogin ? <><Login onDone={next => { expectUser(next.id,next.defaultWorkspaceId); setUser(next); announceSessionChange(); }} /><button className="one-login-back" onClick={() => setRecoveryLogin(false)}>返回 ONE Key 登录</button></> : <main className="one-key-welcome"><OneEye size="hero" /><h1>{updateRecovery ? "重新打开 ONE，完成更新" : "插入 ONE Key"}</h1><p role="status">{updateRecovery || bootError}</p><button className="primary" onClick={() => void boot()}>{updateRecovery ? "我已重新打开，检查连接" : "重新连接"}</button><details><summary>连接帮助</summary><p>{updateRecovery ? "网页不能替你启动本机程序。打开 U 盘，双击 ONE；如果出现系统权限提示，请按提示处理。若确实拔出了 Key，请插回同一枚。" : "检查 ONE Key、网络和启动器版本。Key 已挂失请联系管理员。"}</p><button className="secondary" onClick={() => setRecoveryLogin(true)}>超管登录</button></details></main>;
  return (
    <PrivateApiContext.Provider value={privateApi}><ChatApp
      key={`${user.id}:${user.access?.workspaceId??user.defaultWorkspaceId}:${user.access?.role??user.role}`}
      user={user}
      onLogout={() => {
        void privateApi("/api/auth/logout", { method: "POST" }).then(() => { expectUser(""); setUser(null); setBootError("已退出。插入 Key 后可以重新打开 ONE。"); announceSessionChange(); }).catch(error => setBootError(error.message));
      }}
    /></PrivateApiContext.Provider>
  );
}

const sharedSlug = /^\/s\/([A-Za-z0-9_-]{24})\/?$/.exec(window.location.pathname)?.[1];
const appRoot = import.meta.hot?.data.appRoot ?? createRoot(document.getElementById("root")!);
if(import.meta.hot)import.meta.hot.data.appRoot=appRoot;
appRoot.render(sharedSlug ? <PublicSharingPage slug={sharedSlug}/> : <App />);
