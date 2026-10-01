import type { Message, KnowledgeProviderId } from "./types.js";
export type SharedSource = { id: string; provider: KnowledgeProviderId; binding: string; label: string };
export type Publication = {
  version?: number; userPrompt?: string; updatedAt?: string;
  history?: Omit<Publication, 'history'>[];
  id: string; workspaceId: string; userId: string; slug: string; name: string; description: string;
  prompt: string; modelId: string; taskVersion: number; sources: SharedSource[]; attachments: boolean;
  status: "active" | "closed"; budgetMicros: number; perRunMicros: number; expiresAt: string; createdAt: string;
};
export type PublicSession = {
  publicationVersion?: number;
  id: string; workspaceId: string; userId: string; publicationId: string; tokenHash: string;
  createdAt: string; expiresAt: string; uploadBytes: number; uploadCount: number;
};
export type PublicRun = {
  publicationVersion?: number;
  id: string; workspaceId: string; userId: string; publicationId: string; sessionId: string; operationId: string;
  payloadHash: string; content: string; attachmentIds: string[]; status: "running" | "completed" | "failed" | "interrupted";
  response?: string; finishReason?: Message["finishReason"]; error?: string; warning?: string;
  createdAt: string; completedAt?: string;
};
