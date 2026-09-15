import type { Database } from "./types.js";

const dayMs = 86_400_000;
const reportingOffsetMs = 8 * 60 * 60 * 1_000;
const parsedTime = (value: string) => Date.parse(value) || 0;
const day = (value: string) => Math.floor((parsedTime(value) + reportingOffsetMs) / dayMs);

/** Content-free operations data. Route must require an admin Key; target identity comes from the database. */
export function betaEngagementSummary(db: Database, targetUserId: string, currentTime = Date.now()) {
  const target = db.users.find((item) => item.id === targetUserId);
  if (!target) return null;
  const own = (item: { workspaceId?: string; userId?: string; actorUserId?: string }) => item.workspaceId === target.defaultWorkspaceId && (item.userId ?? item.actorUserId) === target.id;
  const completed = new Map<string, { createdAt: string; knowledgeUsed: boolean }>();
  for (const event of db.auditLogs) {
    if (!own(event) || event.action !== "chat.completed" || parsedTime(event.createdAt) > currentTime) continue;
    completed.set(event.requestId || event.id, { createdAt: event.createdAt, knowledgeUsed: event.details?.knowledgeUsed === true });
  }
  const chats = [...completed.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const executions = db.executionTasks.filter((item) => own(item) && item.status === "completed" && item.completedAt && parsedTime(item.completedAt) <= currentTime);
  const meaningfulTimes = [...chats.map((item) => item.createdAt), ...executions.map((item) => item.completedAt!)].sort();
  const activeDays = new Set(meaningfulTimes.map(day));
  const today = Math.floor((currentTime + reportingOffsetMs) / dayMs);
  const todayCompletedAnswers = chats.filter((item) => day(item.createdAt) === today).length;
  return {
    completedAnswers: chats.length,
    todayCompletedAnswers,
    knowledgeGroundedAnswers: chats.filter((item) => item.knowledgeUsed).length,
    completedLocalTasks: executions.length,
    firstSuccessfulChatAt: chats[0]?.createdAt,
    firstKnowledgeAnswerAt: chats.find((item) => item.knowledgeUsed)?.createdAt,
    lastMeaningfulUseAt: meaningfulTimes.at(-1),
    meaningfulActiveDays7d: [...activeDays].filter((value) => value >= today - 6 && value <= today).length,
    returnedOnAnotherDay: activeDays.size > 1
  };
}
