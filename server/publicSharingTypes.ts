import type { Message, KnowledgeProviderId } from "./types.js";
export type SharedSource = { id: string; provider: KnowledgeProviderId; binding: string; label: string };
export type Publication = {
  visitorMultiplier?:number; requireLogin?:boolean; allowedUserIds?:string[]; sponsorships?:VisitorSponsorship[];
  apiGrants?: PublicApiGrant[];
  version?: number; userPrompt?: string; updatedAt?: string;
  history?: Omit<Publication, 'history'>[];
  id: string; workspaceId: string; userId: string; slug: string; name: string; description: string;
  prompt: string; modelId: string; taskVersion: number; sources: SharedSource[]; attachments: boolean;
  status: "active" | "closed"; budgetMicros: number; perRunMicros: number; expiresAt: string; createdAt: string;
};
export type PublicSession = {
  apiGrantId?: string; accountUserId?: string; accountWorkspaceId?: string;
  publicationVersion?: number;
  id: string; workspaceId: string; userId: string; publicationId: string; tokenHash: string;
  createdAt: string; expiresAt: string; uploadBytes: number; uploadCount: number;
};
export type PublicRun = {
  commerce?: PublicCommerceSnapshot;
  apiGrantId?: string; entryPoint?: 'published_web'|'published_api';
  publicationVersion?: number;
  id: string; workspaceId: string; userId: string; publicationId: string; sessionId: string; operationId: string;
  payloadHash: string; content: string; attachmentIds: string[]; status: "running" | "completed" | "failed" | "interrupted";
  response?: string; finishReason?: Message["finishReason"]; error?: string; warning?: string;
  createdAt: string; completedAt?: string;
};
export type PublicApiGrant={id:string;workspaceId:string;userId:string;name:string;tokenHash:string;publicationVersion:number;status:'active'|'revoked';budgetMicros:number;perRunMicros:number;expiresAt:string;createdAt:string;revokedAt?:string;sessionId:string};
export type VisitorSponsorship={id:string;workspaceId:string;userId:string;visitorUserId:string;name:string;budgetMicros:number;status:'active'|'revoked';createdAt:string};
export type PublicCommercePolicy={revision:number;visitorPaymentsEnabled:boolean;publisherShareBps:number};
export type PublicCommerceSnapshot={publicationId:string;publicationVersion:number;publisherWorkspaceId:string;publisherUserId:string;payerWorkspaceId:string;payerUserId:string;multiplier:number;publisherShareBps:number;policyRevision:number;sponsorshipId?:string};
export type CommercialUsage={snapshot:PublicCommerceSnapshot;payerReservedMicros:number;publisherReservedMicros:number;payerChargedMicros?:number;publisherChargedMicros?:number;paidPrincipalMicros?:number;bonusMicros?:number;publisherRevenueMicros?:number;platformRevenueMicros?:number;settledAt?:string;status:'pending'|'settled'|'released'};
