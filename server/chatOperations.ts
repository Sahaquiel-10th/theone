import { createHash } from "node:crypto";
import type { Store } from "./db.js";
import type { Conversation, Database, Message } from "./types.js";

/** Compact, durable tombstones: never keep a second copy of prompts or chat history. */
export type ChatOperation = {
  id: string; workspaceId: string; userId: string; operationId: string;
  payloadHash: string; requestId: string; status: "pending" | "completed" | "failed" | "interrupted";
  conversationId?: string; assistantMessageId?: string; knowledgeWarning?: string;
  retryable?: boolean; createdAt: string; updatedAt: string;
};
export type ChatOperationScope = { workspaceId: string; userId: string; operationId: string };
type ChatOperationDatabase = Database & { chatOperations?: ChatOperation[] };
export type ChatOperationResult = { conversation: Conversation; message: Message; knowledgeWarning?: string };

export class ChatOperationError extends Error {
  constructor(
    readonly code: "CHAT_OPERATION_INVALID" | "CHAT_OPERATION_NOT_FOUND" | "CHAT_OPERATION_CONFLICT" | "CHAT_OPERATION_PENDING" | "CHAT_CONVERSATION_BUSY" | "CHAT_OPERATION_FAILED" | "CHAT_OPERATION_INTERRUPTED" | "CHAT_RESULT_UNAVAILABLE" | "CHAT_OPERATION_FORBIDDEN",
    message: string,
    readonly status = 409,
    readonly details: { operationId?: string; conversationId?: string; requestId?: string; retryable?: boolean } = {}
  ) { super(message); this.name = "ChatOperationError"; }
}

function authorize(db: Database, scope: ChatOperationScope) {
  if (!db.users.some(user => user.id === scope.userId && user.enabled)
    || !db.workspaces.some(workspace => workspace.id === scope.workspaceId && workspace.status === "active")
    || !db.workspaceMembers.some(member => member.workspaceId === scope.workspaceId && member.userId === scope.userId)) {
    throw new ChatOperationError("CHAT_OPERATION_FORBIDDEN", "账号或个人空间不可用", 403);
  }
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(scope.operationId)) {
    throw new ChatOperationError("CHAT_OPERATION_INVALID", "消息提交标识无效，请刷新页面后重试", 400);
  }
}

function operationRecordId(scope: ChatOperationScope) {
  return `cop_${createHash("sha256").update(JSON.stringify([scope.workspaceId, scope.userId, scope.operationId])).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new ChatOperationError("CHAT_OPERATION_INVALID", "消息提交内容无效", 400);
}

function operationDetails(operation: ChatOperation) {
  return { operationId: operation.operationId, conversationId: operation.conversationId, requestId: operation.requestId, retryable: operation.retryable ?? false };
}

function assertReplayable(operation: ChatOperation) {
  if (operation.status === "pending") throw new ChatOperationError("CHAT_OPERATION_PENDING", "这条消息仍在处理中，请稍后查看结果；不会重复调用模型", 409, operationDetails(operation));
  if (operation.status === "interrupted") throw new ChatOperationError("CHAT_OPERATION_INTERRUPTED", "这次消息的处理结果尚未确认，请先查看对话或联系管理员；不会自动重复调用模型", 409, operationDetails(operation));
  if (operation.status === "failed") throw new ChatOperationError("CHAT_OPERATION_FAILED", operation.retryable
    ? "这次消息已结束且未成功。确认后可以重新提交，不会自动重复执行旧请求"
    : "这次消息未完成，可能已有模型用量，请先查看对话或联系管理员；不会自动重复调用模型", 409, operationDetails(operation));
}

function scopedOperationRecord(db: ChatOperationDatabase, scope: ChatOperationScope) {
  const operation = db.chatOperations?.find(item => item.id === operationRecordId(scope) && item.workspaceId === scope.workspaceId && item.userId === scope.userId);
  if (!operation) throw new ChatOperationError("CHAT_OPERATION_NOT_FOUND", "未找到这次消息提交", 404);
  return operation;
}

function ownOperation(db: ChatOperationDatabase, scope: ChatOperationScope) {
  authorize(db, scope);
  return scopedOperationRecord(db, scope);
}

/** Must run before any message creation, retrieval or model call. Store.mutate serializes starts. */
export async function beginChatOperation(store: Store, input: ChatOperationScope & { requestId: string; conversationId?: string; payload: unknown }) {
  const payloadHash = createHash("sha256").update(canonicalJson(input.payload)).digest("hex");
  return store.mutate(db => {
    authorize(db, input);
    const operations = (db as ChatOperationDatabase).chatOperations ??= [];
    const id = operationRecordId(input);
    const existing = operations.find(item => item.id === id && item.workspaceId === input.workspaceId && item.userId === input.userId);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new ChatOperationError("CHAT_OPERATION_CONFLICT", "同一提交标识不能用于不同的消息内容", 409, operationDetails(existing));
      assertReplayable(existing);
      return { kind: "completed" as const, operation: structuredClone(existing) };
    }
    if (input.conversationId) {
      if (!db.conversations.some(item => item.id === input.conversationId && item.workspaceId === input.workspaceId && item.userId === input.userId)) {
        throw new ChatOperationError("CHAT_OPERATION_NOT_FOUND", "对话不存在", 404);
      }
      assertConversationFree(operations, input, input.conversationId);
    }
    const timestamp = new Date().toISOString();
    const operation: ChatOperation = { id, workspaceId: input.workspaceId, userId: input.userId, operationId: input.operationId,
      payloadHash, requestId: input.requestId, conversationId: input.conversationId || undefined, status: "pending", createdAt: timestamp, updatedAt: timestamp };
    operations.push(operation);
    return { kind: "started" as const, operation: structuredClone(operation) };
  });
}

function assertConversationFree(operations: ChatOperation[], scope: ChatOperationScope, conversationId: string) {
  if (operations.some(item => item.workspaceId === scope.workspaceId && item.userId === scope.userId && item.operationId !== scope.operationId && item.conversationId === conversationId && item.status === "pending")) {
    throw new ChatOperationError("CHAT_CONVERSATION_BUSY", "这个对话还有一条消息正在处理中，请等它完成后再发送", 409, { conversationId, retryable: true });
  }
}

/** Call inside the same mutation that creates/appends the user message. */
export function bindChatOperationConversation(db: ChatOperationDatabase, scope: ChatOperationScope, conversationId: string) {
  const operation = ownOperation(db, scope);
  if (operation.status !== "pending" || (operation.conversationId && operation.conversationId !== conversationId)) {
    throw new ChatOperationError("CHAT_OPERATION_CONFLICT", "消息提交与对话不匹配");
  }
  if (!db.conversations.some(item => item.id === conversationId && item.workspaceId === scope.workspaceId && item.userId === scope.userId)) {
    throw new ChatOperationError("CHAT_OPERATION_NOT_FOUND", "对话不存在", 404);
  }
  assertConversationFree(db.chatOperations ?? [], scope, conversationId);
  operation.conversationId = conversationId;
  operation.updatedAt = new Date().toISOString();
}

/** Call INSIDE the assistant-message persistence mutation so reply and completion commit together. */
export function completeChatOperation(db: ChatOperationDatabase, scope: ChatOperationScope, result: { conversationId: string; assistantMessageId: string; knowledgeWarning?: string }) {
  // This is internal finalization of an already-authorized request. A user being
  // disabled mid-call must not prevent saving a billed answer. Public reads still
  // require current membership and enabled status via ownOperation.
  const operation = scopedOperationRecord(db, scope);
  if (operation.status === "completed" && operation.conversationId === result.conversationId && operation.assistantMessageId === result.assistantMessageId) return;
  if (operation.status !== "pending" || operation.conversationId !== result.conversationId) throw new ChatOperationError("CHAT_OPERATION_CONFLICT", "消息提交结果不匹配");
  const conversation = db.conversations.find(item => item.id === result.conversationId && item.workspaceId === scope.workspaceId && item.userId === scope.userId);
  if (!conversation?.messages.some(message => message.id === result.assistantMessageId && message.role === "assistant")) throw new ChatOperationError("CHAT_RESULT_UNAVAILABLE", "消息结果尚未保存");
  operation.status = "completed";
  operation.assistantMessageId = result.assistantMessageId;
  // Only use the application's sanitized knowledge warning, never an upstream raw response.
  operation.knowledgeWarning = result.knowledgeWarning?.slice(0, 500) || undefined;
  operation.updatedAt = new Date().toISOString();
}

/** Keep the operation tombstone even when a conversation is deleted: an old retry must never re-run. */
export function getChatOperationResult(db: ChatOperationDatabase, scope: ChatOperationScope): ChatOperationResult {
  const operation = ownOperation(db, scope);
  assertReplayable(operation);
  const conversation = db.conversations.find(item => item.id === operation.conversationId && item.workspaceId === scope.workspaceId && item.userId === scope.userId);
  const index = conversation?.messages.findIndex(item => item.id === operation.assistantMessageId && item.role === "assistant") ?? -1;
  if (!conversation || index < 0) throw new ChatOperationError("CHAT_RESULT_UNAVAILABLE", "这次消息的原对话或结果已不可用，不会重新调用模型", 409, operationDetails(operation));
  const messages = structuredClone(conversation.messages.slice(0, index + 1));
  return { conversation: { ...structuredClone(conversation), messages, updatedAt: messages[index].createdAt }, message: messages[index], knowledgeWarning: operation.knowledgeWarning };
}

/**
 * Internal finalization, in the SAME mutation as failed user-message removal and
 * attachment release. The conversation lock must not be released before cleanup.
 * retryable=true only when no uncertain/successful model usage occurred.
 */
export function failChatOperationInMutation(db: ChatOperationDatabase, scope: ChatOperationScope, options: { retryable?: boolean } = {}) {
  const operation = scopedOperationRecord(db, scope);
  if (operation.status !== "pending") return;
  operation.status = "failed";
  operation.retryable = options.retryable === true;
  operation.updatedAt = new Date().toISOString();
}

/** For failures with no message/attachment mutations to undo. */
export async function failChatOperation(store: Store, scope: ChatOperationScope, options: { retryable?: boolean } = {}) {
  await store.mutate(db => failChatOperationInMutation(db, scope, options));
}

/** Startup only. Never expire-and-replay a pending operation: the upstream may already have charged. */
export function reconcileInterruptedChatOperations(db: ChatOperationDatabase) {
  const timestamp = new Date().toISOString();
  for (const operation of db.chatOperations ?? []) {
    if (operation.status !== "pending") continue;
    operation.status = "interrupted";
    operation.retryable = false;
    operation.updatedAt = timestamp;
  }
}
