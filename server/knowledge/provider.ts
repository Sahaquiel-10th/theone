export type KnowledgeCredentials = { clientId: string; apiKey: string };
export type KnowledgeChunk = { id?: string; title: string; content: string; score?: number; sourceUrl?: string };

export interface KnowledgeProvider {
  search(credentials: KnowledgeCredentials, query: string, topK: number): Promise<KnowledgeChunk[]>;
}
