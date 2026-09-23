import type { ModelToolDefinition, ModelToolMessage, ToolChatResult } from "./modelGateway.js";
import type { ExecutionTraceStep } from "./types.js";
import { taskToolDescriptions } from "./aiTaskPresets.js";

export type OrchestrationTool = { name: string; description?: string; run: (query: string) => Promise<unknown> };

/** Sequential, bounded read-only execution. Handlers own scope and fresh authorization. */
export async function runTaskOrchestrator(input: {
  messages: ModelToolMessage[];
  tools: OrchestrationTool[];
  maxSteps: number;
  beforeStep: () => Promise<void>;
  call: (messages: ModelToolMessage[], tools: ModelToolDefinition[]) => Promise<ToolChatResult>;
}) {
  const messages = structuredClone(input.messages);
  const tools: ModelToolDefinition[] = input.tools.map(tool => ({ type: "function", function: {
    name: tool.name, description: tool.description ?? taskToolDescriptions[tool.name],
    parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string", minLength: 1, maxLength: 1000 } }, required: ["query"] }
  } }));
  const trace: ExecutionTraceStep[] = [];
  const steps = Math.min(4, Math.max(1, Math.floor(input.maxSteps)));
  const cache = new Map<string, unknown>();
  for (let step = 1; step <= steps; step++) {
    await input.beforeStep();
    const result = await input.call(messages, step === steps ? [] : tools);
    if (!result.toolCalls.length) {
      if (!result.content.trim()) throw new Error("调度模型没有返回结果");
      return { content: result.content, messages, trace };
    }
    if (step === steps) throw new Error("已达到调度步骤上限，未完成任务；请缩小问题范围");
    if (result.toolCalls.length > 2 || new Set(result.toolCalls.map(call => call.id)).size !== result.toolCalls.length) throw new Error("调度模型返回了过多或重复的工具调用，已停止");
    messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      await input.beforeStep();
      const tool = input.tools.find(tool => tool.name === call.function.name);
      let query: string | undefined;
      try {
        const args = JSON.parse(call.function.arguments);
        if (args && Object.keys(args).length === 1 && typeof args.query === "string" && args.query.trim() && args.query.length <= 1000) query = args.query.trim();
      } catch { /* Invalid parameters are returned to the model, never executed. */ }
      let output: unknown; let status = "rejected"; const started = Date.now();
      if (!tool || !query) output = { status: "rejected", error: "工具未授权或参数无效" };
      else {
        const key = JSON.stringify([tool.name, query]);
        if (cache.has(key)) { output = cache.get(key); status = "reused"; }
        else {
          // Handler errors propagate: do not disguise revoked authorization as no matches.
          output = await tool.run(query); cache.set(key, output); status = "returned";
        }
      }
      const serialized = JSON.stringify(output);
      trace.push({ step, tool: tool?.name ?? "unavailable", status: status as ExecutionTraceStep["status"], query, resultPreview: serialized.length > 12000 ? `${serialized.slice(0, 12000)}…` : serialized, durationMs: Date.now() - started });
      messages.push({ role: "tool", tool_call_id: call.id, content: serialized.length > 28000 ? JSON.stringify({ status: "truncated", excerpt: serialized.slice(0, 27000) }) : serialized });
    }
  }
  throw new Error("调度未完成");
}
