import type { ExecutorValues } from "./executorProfiles.js";
import type { OfficialFeatureValues } from "./officialFeatures.js";
import type { CredentialBinding } from "./featureCredentials.js";
export type WorkRun = {
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
