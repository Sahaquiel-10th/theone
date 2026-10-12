import type { ExecutorValues } from "./executorProfiles.js";
import type { OfficialFeatureValues } from "./officialFeatures.js";
import type { CredentialBinding } from "./featureCredentials.js";
export type WorkRun = {
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
  resultMessageId?: string;
};
