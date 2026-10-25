import type { ExecutorValues } from "./executorProfiles.js";
import type { OfficialFeatureValues } from "./officialFeatures.js";
import type { CredentialBinding } from "./featureCredentials.js";
export type WorkRun = {
  runtimeContext?:import('./runtimeContext.js').RuntimeContext;
  fixedWorkflow?:import('./fixedWorkflows.js').FixedWorkflowInvocation;
  steps?:import('./taskSteps.js').TaskStep[];
  contract?:{version:1;requiredFeatureIds:string[];requiredTools:string[];knowledgeSourceIds?:string[];execution:'model'|'direct'};
  directVisual?:{tool:'oneHtml'|'oneFlowchart';document:import('./visualDocument.js').VisualDocument};
  userReport?:string;
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
  notionReceipt?: { state: 'pending' | 'verified' | 'uncertain'; pageId?: string; url?: string; asyncTaskId?: string; expectedDigest?: string; digest?: string;
    /** Versioned, server-owned evidence of the exact write being checked. */
    checkpointKey?:string; canonicalVersion?:2; expectedCanonicalDigest?:string; expectedRawDigest?:string;
    /** Final intent is retained while readback is pending; it is not proof by itself. */
    final?:boolean;
    /** Durable read-only follow-up, never a queued model/write retry. Old receipts are not implicitly enrolled. */
    verification?:{state:'scheduled'|'checking'|'exhausted';version:number;attempt:number;nextCheckAt:string;deadlineAt:string;leaseId?:string;leaseUntil?:string;lastReason?:'read_failed'|'mismatch'|'incomplete'|'authorization'|'stale'|'no_page'};
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
