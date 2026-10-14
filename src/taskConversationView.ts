type ViewMessage = { id?: string; role: string; content: string };
type Handoff = { inputMessageId: string; instruction?: string };

/** Project only server-authorized handoffs; never replace the stored original. */
export function taskConversationView<T extends ViewMessage>(messages: T[], jobs: Handoff[] = []): (T & { originalContent?: string })[] {
  const handoffs = new Map(jobs.filter(job => job.instruction?.trim()).map(job => [job.inputMessageId, job.instruction!.trim()]));
  return messages.map(message => {
    const instruction = message.role === 'user' && message.id ? handoffs.get(message.id) : undefined;
    return instruction && instruction !== message.content
      ? { ...message, content: instruction, originalContent: message.content }
      : { ...message };
  });
}
