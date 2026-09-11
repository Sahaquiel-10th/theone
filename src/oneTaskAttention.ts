type TaskSnapshot = {
  id: string;
  conversationId: string;
  status: string;
  updatedAt: string;
};

type ConversationSnapshot = {
  id: string;
  title: string;
  archived?: boolean;
  updatedAt: string;
};

export type TaskActivityRow = {
  conversationId: string;
  title: string;
  taskId?: string;
  status: "running" | "thinking" | "failed" | "completed" | "cancelled" | "recent";
  updatedAt: string;
  unread: boolean;
};

const runningStatuses = new Set(["queued", "selecting_target", "running"]);
const settledStatuses = new Set(["completed", "failed", "cancelled"]);

/** An explicit historical selection is local to its conversation, never global. */
export function selectConversationExecution<T extends TaskSnapshot>(tasks: T[], conversationId: string, selectedTaskId?: string): T | null {
  const candidates = [...latestById(tasks).values()].filter(task => task.conversationId === conversationId);
  const selected = selectedTaskId ? candidates.find(task => task.id === selectedTaskId) : undefined;
  if (selected) return selected;
  return candidates.sort((a, b) => Number(runningStatuses.has(b.status)) - Number(runningStatuses.has(a.status))
    || b.updatedAt.localeCompare(a.updatedAt)
    || a.id.localeCompare(b.id))[0] || null;
}

/** A background tab cannot have read a completion simply by retaining its view. */
export function shouldAutoReadTaskNotice(viewedConversationId: string, noticeConversationId: string, visible: boolean): boolean {
  return visible && Boolean(viewedConversationId) && viewedConversationId === noticeConversationId;
}

function latestById<T extends { id: string; updatedAt: string }>(items: T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const item of items) {
    const previous = latest.get(item.id);
    if (!previous || item.updatedAt >= previous.updatedAt) latest.set(item.id, item);
  }
  return latest;
}

/** Only a live task becoming settled earns attention; initial history is silent. */
export function getSettledTaskTransitions<T extends TaskSnapshot>(previous: T[], current: T[]): T[] {
  const previousById = latestById(previous);
  return [...latestById(current).values()].filter(task => {
    const before = previousById.get(task.id);
    return Boolean(before
      && before.conversationId === task.conversationId
      && runningStatuses.has(before.status)
      && settledStatuses.has(task.status)
      && task.updatedAt >= before.updatedAt);
  });
}

/** One row per conversation, with live work taking precedence over its history. */
export function buildTaskActivityRows(
  conversations: ConversationSnapshot[],
  tasks: TaskSnapshot[],
  loadingIds: Set<string>,
  failedIds: Set<string>,
  unreadConversationIds: Set<string>
): TaskActivityRow[] {
  const conversationsById = latestById(conversations);
  const tasksByConversation = new Map<string, TaskSnapshot>();
  for (const task of latestById(tasks).values()) {
    const previous = tasksByConversation.get(task.conversationId);
    const running = runningStatuses.has(task.status);
    const previousRunning = previous ? runningStatuses.has(previous.status) : false;
    if (!previous || (running && !previousRunning)
      || (running === previousRunning && task.updatedAt >= previous.updatedAt)) {
      tasksByConversation.set(task.conversationId, task);
    }
  }

  const conversationIds = new Set([...conversationsById.keys(), ...tasksByConversation.keys()]);
  const rows: TaskActivityRow[] = [];
  for (const conversationId of conversationIds) {
    const conversation = conversationsById.get(conversationId);
    const task = tasksByConversation.get(conversationId);
    const running = Boolean(task && runningStatuses.has(task.status));
    const thinking = loadingIds.has(conversationId);
    const unread = unreadConversationIds.has(conversationId);
    if (conversation?.archived && !running && !thinking && !unread) continue;

    let status: TaskActivityRow["status"] = "recent";
    if (running) status = "running";
    else if (thinking) status = "thinking";
    else if (failedIds.has(conversationId)) status = "failed";
    else if (task?.status === "completed" || task?.status === "failed" || task?.status === "cancelled") status = task.status;

    rows.push({
      conversationId,
      title: conversation?.title || "本机任务",
      ...(task ? { taskId: task.id } : {}),
      status,
      updatedAt: [conversation?.updatedAt || "", task?.updatedAt || ""].sort().at(-1) || "",
      unread
    });
  }

  const isBusy = (row: TaskActivityRow) => row.status === "running" || row.status === "thinking";
  return rows.sort((a, b) => Number(isBusy(b)) - Number(isBusy(a))
    || Number(b.unread) - Number(a.unread)
    || b.updatedAt.localeCompare(a.updatedAt)
    || a.conversationId.localeCompare(b.conversationId));
}
