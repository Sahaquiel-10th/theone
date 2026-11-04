import type { ExecutorValues } from "./executorProfiles.js";
import type { OfficialFeatureValues } from "./officialFeatures.js";
import type { CredentialBinding } from "./featureCredentials.js";
export type WorkRun = {
  /** Exact original input is bound by the server, never copied by the router. */
  inputSource?:import('./taskInputSource.js').TaskInputSourceReference;
  materialScope?:'current'|'conversation';
  /** The selected material revision survives short later instructions. */
  materialSource?:import('./taskInputSource.js').TaskInputSourceReference;
  /** A multi-goal batch keeps its scoped brief; its full raw message is
   * provenance, not fresh instructions for every child. */
  inputContentMode?:'material'|'brief';
  /** Private model-only retry claims and conservative uncertain-cost bounds. */
  textModelAttempts?:Record<string,import('./modelStepRecovery.js').TextModelAttempt>;
  /** Server-owned execution identity, never a browser/model parameter. State
   * alone cannot identify local work after a failed admission. */
  executionMode?:'local';
  localExecution?:{deviceId:string;installationId?:string;targetName?:string;admissionRevision?:number};
  /** Server-created practice contract. No source body or browser authority. */
  onboardingPractice?:{id:string;stage:'first'|'web';material?:import('./onboardingPractice.js').PracticeMaterial};
  workflow?:import('./taskWorkflow.js').WorkflowRun;
  /** Server-resolved published execution choices, never function arguments. */
  workflowModels?:Record<string,{modelId:string;systemPrompt:string;executorId:string;executorVersion:number}>;
  runtimeContext?:import('./runtimeContext.js').RuntimeContext;
  /** Prior connection failures stay auditable when the same durable run is
   * explicitly resumed. Refer to retained messages, not duplicate their body. */
  connectionRecoveries?:{operationId:string;sourceUpdatedAt:string;failureCode:string;failure?:import('../src/coordinatorRecovery.js').CoordinatorFailure;resultMessageId?:string;resultOutcome?:'completed'|'failed'|'partial'|'needs_input'|'returned';at:string}[];
  fixedWorkflow?:import('./fixedWorkflows.js').FixedWorkflowInvocation;
  steps?:import('./taskSteps.js').TaskStep[];
  contract?:{version:1;requiredFeatureIds:string[];requiredTools:string[];knowledgeSourceIds?:string[];execution:'model'|'direct'};
  directVisual?:{tool:'oneHtml'|'oneFlowchart';document:import('./visualDocument.js').VisualDocument};
  userReport?:string;
  /** Reviewed code-owned classification, never raw parameters/provider text. */
  toolRecovery?:import('./toolRecovery.js').ToolRecoveryDiagnostic;
  retryOfOperationId?:string;
  dependencyBlocked?:boolean;
  /** Reporting to ONE and the user's review are independent durable acknowledgements. */
  reportedToCoordinatorAt?: string;
  reportMessageId?: string;
  /** Explicit server-confirmed material update; legacy receipts keep revision zero. */
  reportRevision?: number;
  reportRevisionAt?: string;
  reviewedAt?: string;
  resultOutcome?: 'completed' | 'failed' | 'partial' | 'needs_input' | 'returned';
  notionTarget?: NonNullable<import('./types.js').Conversation['notionDocument']> & { referenceIds: string[] };
  /** Server-selected exact existing result, never a model-provided body or ID.
   * Digests bind both the original message and the body without ONE's known
   * appended delivery status. An old partial result remains partial. */
  notionArticleSource?: {conversationId:string;operationId:string;messageId:string;messageDigest:string;digest:string};
  /** Explicit manual read-only authorization to finish only this exact saved
   * attempt after delayed proof; never an authorization to replay its work. */
  notionVerificationSelection?:{operationId:string;expectedDigest:string;pageId?:string;asyncTaskId?:string;checkpointKey?:string;version:number;connectionId:string;grantId:string;parentId:string;requestedAt:string};
  notionReceipt?: { state: 'pending' | 'verified' | 'uncertain'; pageId?: string; url?: string; asyncTaskId?: string; expectedDigest?: string; digest?: string;
    /** The user selected an existing page and it was strictly read back. This
     * proves delivery content, never an acknowledgement of the original write. */
    linkRecovery?:{version:1;source:'user_supplied_page';selectionId:string;pageId:string;parentId:string;connectionId:string;grantId:string;checkpointKey:string;expectedRawDigest:string;expectedDigest:string;expectedCanonicalDigest:string;expectedLength:number;selectedAt:string;verifiedAt:string};
    /** Private create title captured before dispatch; never inferred from a
     * later conversation title when recovering an unknown create result. */
    expectedPageTitle?:string;
    /** Versioned, server-owned evidence of the exact write being checked. */
    checkpointKey?:string; canonicalVersion?:import('./notionCanonical.js').NotionCanonicalVersion; expectedCanonicalDigest?:string; expectedRawDigest?:string;expectedLength?:number;
    /** Comparison metadata only. Neither the authored text nor fetched title/body
     * belongs in diagnostics; old source/version digests remain immutable. */
    comparison?:{version:1;kind:'matched'|'title_missing'|'title_changed'|'body_mismatch'|'incomplete'|'read_failed';checkedAt:string;comparatorVersion:1|import('./notionCanonical.js').NotionCanonicalVersion;actualBodyDigest?:string;actualBodyLength?:number;actualSourceDigest?:string;actualSourceLength?:number;actualCanonicalDigest?:string;expectedCanonicalDigest?:string;expectedTitleDigest?:string;actualTitleDigest?:string};
    /** Explicit authored-H1/page-title boundary; source digests stay unchanged. */
    titleProjection?:import('./notionTitleProjection.js').NotionTitleProjection;
    /** Final intent is retained while readback is pending; it is not proof by itself. */
    final?:boolean;
    /** Durable read-only follow-up, never a queued model/write retry. Old receipts are not implicitly enrolled. */
    verification?:{state:'scheduled'|'checking'|'exhausted';version:number;attempt:number;nextCheckAt:string;deadlineAt:string;leaseId?:string;leaseUntil?:string;resumeCheckUsed?:boolean;lastReason?:'read_failed'|'mismatch'|'incomplete'|'authorization'|'stale'|'no_page'};
    error?: string; delivery?: 'not_sent' | 'rejected' | 'unknown'; diagnostic?: {phase: string; reason: string; upstreamCode?: string}; failureCode?: 'preflight_failed' | 'write_unconfirmed' | 'response_unrecognized' | 'async_unconfirmed' | 'readback_failed' | 'readback_mismatch' };
  featurePricingVersion?: 1;
  featureApprovals?: import('./featurePricing.js').FeatureApproval[];
  kind?: "image";
  /** Server-created welcome handoff. Retained on explicit retries; never client input. */
  welcomeOperationId?: string;
  welcomeSponsored?: boolean;
  welcomeGuide?:import('./welcomeGuide.js').WelcomeGuideFacts;
  welcomeManual?:import('./welcomeManual.js').WelcomeManualSnapshot;
  welcomeImageAttachmentId?:string;
  welcomeArtifacts?:{flowId?:string;pageId?:string};
  imagePrice?: number;
  imageCost?: number;
  state:
    "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled" | "prepared";
  executorId: string;
  executorVersion: number;
  values: ExecutorValues;
  modelId: string;
  modelPrompt: string;
  instruction: string;
  inputMessageId: string;
  originConversationId?: string;
  originMessageId?: string;
  parentOperationId?: string;
  expectedOutput?:'text'|'image'|'local_file';
  dependsOnOperationIds?: string[];
  budget: number;
  webSearch: boolean;
  sources: { id: string; binding: string }[];
  skills: {
    id: string;
    releaseId: string;
    version: number;
    values: OfficialFeatureValues;
  }[];
  credentials: CredentialBinding[];
  unread?: boolean;
  error?: string;
  retryProgress?: { attempt: number; maxRetries: number; nextRetryAt: string };
  failureCode?: string;
  resultMessageId?: string;
};
