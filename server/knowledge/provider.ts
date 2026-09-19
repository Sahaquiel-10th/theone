export type KnowledgeCredentials = { clientId: string; apiKey: string };
import type { KnowledgeProviderId } from "../types.js";
export type KnowledgeChunk = { id?: string; provider?: KnowledgeProviderId; title: string; content: string; score?: number; sourceUrl?: string };

export interface KnowledgeProvider {
  search(credentials: KnowledgeCredentials, query: string, topK: number): Promise<KnowledgeChunk[]>;
}
