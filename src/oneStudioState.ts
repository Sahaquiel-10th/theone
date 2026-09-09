/** Keep navigation/history responses from rolling a live task back in time. */
export function mergeTaskSnapshots<T extends { id: string; updatedAt: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map(task => [task.id, task]));
  for (const task of incoming) {
    const previous = merged.get(task.id);
    if (!previous || task.updatedAt >= previous.updatedAt) merged.set(task.id, task);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type StudioDraft<T> = { content: string; attachments: T[] };

/** Failure recovery is scoped to the originating draft, including newer notes. */
export function recoverTaskDraft<T extends { id: string }>(sent: StudioDraft<T>, newer?: StudioDraft<T>): StudioDraft<T> {
  return {
    content: newer?.content ? `${sent.content}\n\n${newer.content}` : sent.content,
    attachments: [...sent.attachments, ...(newer?.attachments || []).filter(item => !sent.attachments.some(original => original.id === item.id))]
  };
}
