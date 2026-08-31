import { ContextTraceSection, Message } from "./types.js";

type TraceInput = {
  safetyRules: string;
  modelPrompt: string;
  knowledgeContext: string;
  memoryContext: string;
  attachmentContext: string;
  webSearchContext: string;
  history: Message[];
  currentInput: string;
};

const empty = "（本次未使用）";

export function buildContextTraceSections(input: TraceInput): ContextTraceSection[] {
  return [
    section("safety", "平台安全提示词", input.safetyRules),
    section("model_prompt", "模型 System Prompt", input.modelPrompt),
    section("knowledge", "知识库召回（注入给 AI 的原文）", input.knowledgeContext),
    section("memory", "用户保存的记忆", input.memoryContext),
    section("attachments", "附件解析内容", input.attachmentContext),
    section("web_search", "联网搜索内容", input.webSearchContext),
    section("history", "本次携带的历史对话", formatHistory(input.history)),
    section("current_input", "用户本次问题", input.currentInput)
  ];
}

function section(key: ContextTraceSection["key"], title: string, content: string): ContextTraceSection {
  return { key, title, content: content.trim() || empty };
}

function formatHistory(messages: Message[]) {
  if (!messages.length) return empty;
  return messages.map((message, index) => {
    const role = message.role === "user" ? "用户" : message.role === "assistant" ? "AI" : "系统";
    return `【${index + 1} · ${role}】\n${message.content}`;
  }).join("\n\n");
}
