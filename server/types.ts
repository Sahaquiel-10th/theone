export type Role = "admin" | "user";

export type User = { id: string; username: string; passwordHash: string; role: Role; defaultWorkspaceId: string; preferredModelId?: string; enabled: boolean; createdAt: string };
export type Workspace = { id: string; name: string; slug: string; status: "active" | "suspended"; createdAt: string; updatedAt: string };
export type WorkspaceMember = { id: string; workspaceId: string; userId: string; role: "owner" | "member"; createdAt: string };
export type ConversationFolder = { id: string; workspaceId: string; userId: string; name: string; createdAt: string };

export type ModelConfig = {
  id: string; name: string; provider: string; kind: "chat" | "image"; protocol: "openai" | "anthropic";
  baseUrl: string; apiKey: string; encryptedApiKey?: string; model: string; systemPrompt: string; enabled: boolean; isDefault: boolean;
  inputPowerPerMillion: number; outputPowerPerMillion: number; costInputPowerPerMillion: number; costOutputPowerPerMillion: number;
  createdAt: string;
};

export type Message = {
  id?: string; role: "user" | "assistant" | "system"; content: string; imageUrl?: string;
  attachments?: AttachmentSummary[]; sources?: SearchSource[]; inputImageDataUrls?: string[]; createdAt: string; modelId?: string;
};

export type MessageRecord = Required<Pick<Message, "id" | "role" | "content" | "createdAt">> & {
  workspaceId: string; userId: string; conversationId: string; modelId?: string; imageUrl?: string;
  attachmentIds?: string[]; sources?: SearchSource[]; tokenCount?: number;
};

export type Conversation = {
  id: string; workspaceId: string; userId: string; modelId: string; agentId?: string; folderId?: string;
  archived: boolean; title: string; messages: Message[]; createdAt: string; updatedAt: string;
};

export type Agent = {
  id: string; workspaceId: string; ownerId: string; name: string; description: string; prompt: string; modelId: string;
  group: string; avatar: string; color: string; favoriteUserIds: string[]; useCount: number; allowFileUpload: boolean;
  allowImageInput: boolean; allowWebSearch: boolean; published: boolean; publicSlug: string; createdAt: string; updatedAt: string;
};

export type AttachmentKind = "image" | "document" | "spreadsheet" | "presentation" | "text";
export type Attachment = {
  id: string; workspaceId: string; userId: string; originalName: string; mimeType: string; kind: AttachmentKind;
  size: number; storagePath: string; extractedText: string; conversationId?: string; messageId?: string; createdAt: string;
};
export type AttachmentSummary = Pick<Attachment, "id" | "originalName" | "mimeType" | "kind" | "size">;
export type SearchSource = { title: string; url: string; snippet: string };
export type SystemSettings = { safetyRules: string; rechargeCnyPerPower: number };

export type UserSavedMemory = {
  id: string; workspaceId: string; userId: string; conversationId?: string; sourceMessageId?: string;
  content: string; status: "active" | "deleted"; createdAt: string; updatedAt: string;
};

export type RetrievalLog = {
  id: string; workspaceId: string; userId: string; conversationId: string; query: string; provider: "getnote";
  matchedItemsJson: unknown; injectedContext: string; createdAt: string;
};

export type ContextTraceSection = {
  key: "safety" | "model_prompt" | "knowledge" | "attachments" | "web_search" | "history" | "current_input";
  title: string;
  content: string;
};

export type ContextTrace = {
  id: string; workspaceId: string; userId: string; conversationId: string; assistantMessageId: string;
  modelId: string; requestId?: string; query: string; responsePreview: string;
  sections: ContextTraceSection[]; createdAt: string;
};

export type ModelUsageRecord = {
  id: string; workspaceId: string; userId: string; conversationId: string; modelId: string; inputTokens: number;
  outputTokens: number; totalTokens: number; source: "provider" | "estimated"; chargedMicros?: number; costMicros?: number;
  inputPowerPerMillionSnapshot?: number; outputPowerPerMillionSnapshot?: number;
  costInputPowerPerMillionSnapshot?: number; costOutputPowerPerMillionSnapshot?: number;
  requestId?: string; status?: "success" | "failed"; createdAt: string;
};

export type PowerAccount = { id: string; workspaceId: string; userId: string; balanceMicros: number; createdAt: string; updatedAt: string };
export type PowerLedgerEntry = {
  id: string; workspaceId: string; userId: string; type: "gift" | "recharge" | "usage" | "adjustment" | "refund";
  amountMicros: number; balanceBeforeMicros: number; balanceAfterMicros: number; title: string;
  modelId?: string; usageRecordId?: string; createdByUserId?: string; createdAt: string;
};
export type RechargeOrder = {
  id: string; workspaceId: string; userId: string; requestedMicros: number; amountCny: number; cnyPerPowerSnapshot: number;
  status: "pending" | "paid" | "cancelled"; createdAt: string; paidAt?: string;
};
export type AuditLog = {
  id: string; workspaceId?: string; actorUserId?: string; action: string; targetType: string; targetId?: string;
  details?: Record<string, unknown>; requestId?: string; createdAt: string;
};

export type KnowledgeConnection = {
  id: string; workspaceId: string; provider: "getnote"; status: "pending" | "connected" | "error" | "revoked";
  clientId: string; encryptedApiKey?: string; providerSpaceId?: string; providerSpaceName?: string;
  credentialExpiresAt?: string; lastCheckedAt?: string; lastError?: string; createdAt: string; updatedAt: string;
};

export type ExecutionTaskStatus = "queued" | "selecting_target" | "running" | "completed" | "failed" | "cancelled";
export type ExecutionTask = {
  id: string; workspaceId: string; userId: string; conversationId: string; sourceMessageId: string;
  provider: "codex" | "local_agent"; status: ExecutionTaskStatus; instruction: string; deviceId: string;
  targetName?: string; providerThreadId?: string; finalResponse?: string; lastError?: string;
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string;
};
export type ExecutionEvent = {
  id: string; workspaceId: string; userId: string; taskId: string;
  kind: "status" | "user_message" | "message" | "command" | "file_change" | "error";
  text: string; createdAt: string;
};

export type OneKeyDevice = {
  id: string; serialNumber: string; workspaceId: string; userId: string; status: "active" | "revoked";
  publicKey: string; createdAt: string; lastUsedAt?: string; revokedAt?: string;
};

export type DeviceChallenge = {
  id: string; deviceId: string; nonce: string; expiresAt: string; attempts: number; createdAt: string; usedAt?: string;
};

export type OneTimeLoginCode = {
  id: string; tokenHash: string; deviceId: string; workspaceId: string; userId: string;
  expiresAt: string; createdAt: string; usedAt?: string;
};

export type Database = {
  users: User[]; workspaces: Workspace[]; workspaceMembers: WorkspaceMember[]; conversationFolders: ConversationFolder[];
  models: ModelConfig[]; conversations: Conversation[]; messages: MessageRecord[]; userSavedMemories: UserSavedMemory[];
  retrievalLogs: RetrievalLog[]; contextTraces: ContextTrace[]; modelUsageRecords: ModelUsageRecord[]; knowledgeConnections: KnowledgeConnection[];
  oneKeyDevices: OneKeyDevice[]; deviceChallenges: DeviceChallenge[]; oneTimeLoginCodes: OneTimeLoginCode[];
  powerAccounts: PowerAccount[]; powerLedger: PowerLedgerEntry[]; rechargeOrders: RechargeOrder[]; auditLogs: AuditLog[];
  agents: Agent[]; attachments: Attachment[]; executionTasks: ExecutionTask[]; executionEvents: ExecutionEvent[]; settings: SystemSettings;
};

export type PublicUser = Omit<User, "passwordHash">;
export type PublicModel = Omit<ModelConfig, "apiKey" | "encryptedApiKey" | "systemPrompt" | "costInputPowerPerMillion" | "costOutputPowerPerMillion"> & { hasApiKey: boolean };
export type AdminModel = PublicModel & { systemPrompt: string; costInputPowerPerMillion: number; costOutputPowerPerMillion: number };
