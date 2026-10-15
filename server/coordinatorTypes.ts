import type { ExecutorValues } from "./executorProfiles.js";
import type { OfficialFeatureValues } from "./officialFeatures.js";
import type { CredentialBinding } from "./featureCredentials.js";
export type WorkRun = {
  /** Reporting to ONE and the user's review are independent durable acknowledgements. */
  reportedToCoordinatorAt?: string;
  reportMessageId?: string;
  reviewedAt?: string;
  resultOutcome?: 'completed' | 'failed' | 'partial' | 'needs_input' | 'returned';
  notionTarget?: NonNullable<import('./types.js').Conversation['notionDocument']> & { referenceIds: string[] };
  notionReceipt?: { state: 'pending' | 'verified' | 'uncertain'; pageId?: string; url?: string; asyncTaskId?: string; expectedDigest?: string; digest?: string; error?: string };
  featurePricingVersion?: 1;
  featureApprovals?: import('./featurePricing.js').FeatureApproval[];
  kind?: "image";
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
