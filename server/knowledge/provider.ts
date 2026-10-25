export type KnowledgeCredentials = { clientId: string; apiKey: string };
import type { KnowledgeProviderId } from "../types.js";
export type KnowledgeChunk = { id?: string; provider?: KnowledgeProviderId; title: string; content: string; score?: number; sourceUrl?: string; createdAt?:string; updatedAt?:string;
  dateEvidence?: { basis: 'event' | 'created' | 'updated'; date: string; status: 'requires_content_verification' | 'metadata_candidate_only' | 'metadata_match' };
};

export interface KnowledgeProvider {
  search(credentials: KnowledgeCredentials, query: string, topK: number): Promise<KnowledgeChunk[]>;
}
