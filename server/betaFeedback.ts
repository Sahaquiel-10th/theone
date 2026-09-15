import { uid } from "./security.js";
import type { AuditLog, Database } from "./types.js";
import { accountInScope, BetaInputError, type AccountScope } from "./betaProfile.js";

export type BetaFeedbackRating = "helped" | "not_solved";
export type OwnBetaFeedback = {
  id: string; messageId: string; rating: BetaFeedbackRating; requestId?: string;
  comment?: string; sharedComment: boolean; updatedAt: string;
};
export type BetaFeedbackInput = { messageId?: unknown; rating?: unknown; comment?: unknown; shareComment?: unknown };

function feedbackFromLog(log: AuditLog): OwnBetaFeedback | undefined {
  const rating = log.details?.rating;
  if (log.action !== "beta.feedback" || log.targetType !== "message" || !log.targetId || (rating !== "helped" && rating !== "not_solved")) return undefined;
  const sharedComment = log.details?.shareComment === true && typeof log.details?.comment === "string" && Boolean(log.details.comment);
  return { id: log.id, messageId: log.targetId, rating, requestId: log.requestId,
    comment: sharedComment ? log.details!.comment as string : undefined, sharedComment, updatedAt: log.createdAt };
}

function feedbackRevision(log: AuditLog) {
  const value = log.details?.feedbackRevision;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function latestFeedbackLogs(db: Database, scope: AccountScope) {
  const latest = new Map<string, AuditLog>();
  // SQL row order is unspecified. A per-answer revision preserves the latest
  // choice across restarts, including two updates within one millisecond.
  for (const log of db.auditLogs) {
    if (log.workspaceId !== scope.workspaceId || log.actorUserId !== scope.userId) continue;
    const feedback = feedbackFromLog(log);
    if (!feedback) continue;
    const previous = latest.get(feedback.messageId);
    if (!previous || feedbackRevision(log) > feedbackRevision(previous)
      || feedbackRevision(log) === feedbackRevision(previous) && (log.createdAt > previous.createdAt
        || log.createdAt === previous.createdAt && log.id > previous.id)) latest.set(feedback.messageId, log);
  }
  return [...latest.values()];
}

function latestFeedback(db: Database, scope: AccountScope) {
  return latestFeedbackLogs(db, scope).map(log => feedbackFromLog(log)!).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function ownBetaFeedback(db: Database, scope: AccountScope, conversationId: string) {
  accountInScope(db, scope);
  const conversation = db.conversations.find((item) => item.id === conversationId && item.userId === scope.userId && item.workspaceId === scope.workspaceId);
  if (!conversation) throw new BetaInputError("对话不存在", 404, "NOT_FOUND");
  const messageIds = new Set(db.messages.filter((item) => item.conversationId === conversationId && item.workspaceId === scope.workspaceId && item.userId === scope.userId && item.role === "assistant").map((item) => item.id));
  return latestFeedback(db, scope).filter((item) => messageIds.has(item.messageId));
}

/** Store only a rating and an explicitly shared note, never any transcript or source. */
export function saveBetaFeedback(db: Database, scope: AccountScope, input: BetaFeedbackInput, currentTime = new Date().toISOString()) {
  accountInScope(db, scope);
  if (!input || typeof input !== "object") throw new BetaInputError("反馈内容无效");
  if (typeof input.messageId !== "string" || !input.messageId || input.messageId.length > 96) throw new BetaInputError("反馈消息无效");
  if (input.rating !== "helped" && input.rating !== "not_solved") throw new BetaInputError("请选择这次回答是否帮上忙");
  const message = db.messages.find((item) => item.id === input.messageId && item.role === "assistant" && item.workspaceId === scope.workspaceId && item.userId === scope.userId);
  if (!message || !db.conversations.some((item) => item.id === message.conversationId && item.workspaceId === scope.workspaceId && item.userId === scope.userId)) throw new BetaInputError("消息不存在", 404, "NOT_FOUND");
  if (input.comment !== undefined && typeof input.comment !== "string") throw new BetaInputError("反馈说明请使用文字");
  const comment = typeof input.comment === "string" ? input.comment.trim() : "";
  if ([...comment].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(comment)) throw new BetaInputError("反馈说明最多 500 个字符，请勿包含控制字符");
  if (comment && input.shareComment !== true) throw new BetaInputError("发送说明前，请确认同意把这段说明交给内测管理员");
  const trace = db.contextTraces.find((item) => item.assistantMessageId === message.id && item.workspaceId === scope.workspaceId && item.userId === scope.userId && item.conversationId === message.conversationId);
  const previousLog = latestFeedbackLogs(db, scope).find((item) => item.targetId === message.id);
  const previous = previousLog ? feedbackFromLog(previousLog) : undefined;
  if (previous && previous.rating === input.rating && previous.comment === (comment || undefined)) return previous;
  const log: AuditLog = {
    id: uid("aud"), workspaceId: scope.workspaceId, actorUserId: scope.userId, action: "beta.feedback",
    targetType: "message", targetId: message.id, requestId: message.requestId || trace?.requestId || previous?.requestId,
    details: { rating: input.rating, feedbackRevision: previousLog ? feedbackRevision(previousLog) + 1 : 1, shareComment: Boolean(comment), ...(comment ? { comment } : {}) }, createdAt: currentTime
  };
  db.auditLogs.push(log);
  return feedbackFromLog(log)!;
}

/** Call only from the admin + current-Key route. Re-check the current admin role here. */
export function adminBetaFeedback(db: Database, adminScope: AccountScope, targetUserId: string, limit = 20, offset = 0) {
  const admin = accountInScope(db, adminScope);
  if (admin.role !== "admin") throw new BetaInputError("仅超管可查看内测反馈", 403, "ADMIN_REQUIRED");
  const target = db.users.find((item) => item.id === targetUserId);
  if (!target) throw new BetaInputError("用户不存在", 404, "NOT_FOUND");
  const items = latestFeedback(db, { userId: target.id, workspaceId: target.defaultWorkspaceId });
  const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 20;
  const boundedOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  return { helped: items.filter((item) => item.rating === "helped").length,
    notSolved: items.filter((item) => item.rating === "not_solved").length,
    items: items.slice(boundedOffset, boundedOffset + boundedLimit),
    pagination: { total: items.length, offset: boundedOffset, limit: boundedLimit, hasMore: boundedOffset + boundedLimit < items.length } };
}
