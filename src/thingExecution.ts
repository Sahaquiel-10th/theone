type ExecutionThing = {
  id: string;
  messagesLoaded?: boolean;
  messages: { id?: string; role: string; content: string }[];
};

/** Execute the selected saved thread through its newest meaningful message. */
export function thingExecutionSource(thing?: ExecutionThing) {
  if (!thing || thing.messagesLoaded === false || thing.id.startsWith("tmp_")) return undefined;
  const message = [...thing.messages].reverse().find(m => m.id && m.content.trim() && ["user", "assistant"].includes(m.role));
  return message?.id ? { conversationId: thing.id, sourceMessageId: message.id } : undefined;
}
