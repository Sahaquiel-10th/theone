import type { Store } from "./db.js";
import { appendExecutionEvent, taskEvents } from "./executionService.js";
import { callModelWithTools, type ModelToolDefinition, type ModelToolMessage } from "./modelGateway.js";
import { calculateModelPower, chargePower, powerAccount } from "./powerBilling.js";
import { uid } from "./security.js";
import type { ExecutionTask, ModelConfig } from "./types.js";
import { OneKeyPresence, type LocalToolName } from "./oneKeyPresence.js";

const maxSteps = 24;
const allowedTools = new Set<LocalToolName>(["list_files", "read_file", "search_text", "write_file", "replace_in_file", "run_command"]);

const tools: ModelToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and folders inside the user-authorized workspace. Paths must be relative to that workspace.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          path: { type: "string", description: "Relative directory path; use . for the workspace root" },
          maxDepth: { type: "integer", minimum: 1, maximum: 4 }
        }, required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file inside the authorized workspace, with line numbers.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1, maximum: 5000 }
        }, required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description: "Search text across files inside the authorized workspace.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          query: { type: "string" }, path: { type: "string", description: "Relative path; use . for the workspace root" },
          maxResults: { type: "integer", minimum: 1, maximum: 200 }, caseSensitive: { type: "boolean" }
        }, required: ["query", "path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or fully overwrite a UTF-8 text file. This asks the user for approval on their computer.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Replace one exact text occurrence in a UTF-8 file. Read the file first. This asks the user for approval.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } },
        required: ["path", "oldText", "newText"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command from the authorized workspace. This asks the user for approval and may still access resources outside the folder, so use only when needed.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { command: { type: "string" }, timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 } },
        required: ["command"]
      }
    }
  }
];

const systemPrompt = `你是 ONE Local Agent，正在用户明确授权的本地文件夹内完成任务。

规则：
- 只使用提供的工具读取和修改本地内容；所有路径必须相对于授权文件夹。
- 先查看相关文件再修改。修改尽量小，不覆盖无关内容，不读取或输出密钥、令牌、密码和隐私文件。
- write_file、replace_in_file 和 run_command 会在用户电脑上要求确认；用户拒绝时尊重选择并调整方案。
- 命令可能突破目录边界，除非任务确实需要，否则不要运行命令；禁止破坏性删除、提权、持久化、自启动和绕过安全软件。
- 完成修改后尽量执行最小、相关的验证。无法完成时清楚说明阻碍，不要假装成功。
- 最终用简洁中文总结完成内容、验证结果和仍需用户处理的事项。`;

export class LocalAgentService {
  private running = new Set<string>();
  private cancelled = new Set<string>();

  constructor(private store: Store, private presence: OneKeyPresence) {}

  isRunning(taskId: string) { return this.running.has(taskId); }

  start(taskId: string, followup?: string) {
    if (this.running.has(taskId)) throw new Error("ONE Local Agent 正在执行当前任务");
    this.running.add(taskId);
    this.cancelled.delete(taskId);
    void this.run(taskId, followup).finally(() => this.running.delete(taskId));
  }

  async cancel(taskId: string) {
    this.cancelled.add(taskId);
    const db = await this.store.read();
    const task = db.executionTasks.find((item) => item.id === taskId);
    if (!task) throw new Error("执行任务不存在");
    await this.presence.cancelExecution(task.deviceId, task.id).catch(() => undefined);
    await this.finish(task, "cancelled", "执行已由用户停止");
  }

  private async run(taskId: string, followup?: string) {
    let task: ExecutionTask | undefined;
    try {
      let db = await this.store.read();
      task = db.executionTasks.find((item) => item.id === taskId);
      if (!task) throw new Error("执行任务不存在");
      const conversation = db.conversations.find((item) => item.id === task!.conversationId && item.workspaceId === task!.workspaceId && item.userId === task!.userId);
      const model = conversation ? db.models.find((item) => item.id === conversation.modelId && item.enabled && item.kind === "chat") : undefined;
      if (!model) throw new Error("当前对话没有可供 Local Agent 使用的模型");
      if (model.protocol !== "openai") throw new Error("当前 Local Agent 首版只支持 OpenAI 兼容 function calling 模型");

      await this.update(task, "selecting_target", task.targetName ? "正在确认本机授权文件夹" : "请在电脑上选择 ONE 可以操作的文件夹");
      const prepared = await this.presence.prepareLocalExecution(task.deviceId, task.id);
      if (this.cancelled.has(task.id)) return;
      task = { ...task, targetName: prepared.targetName || task.targetName || "已授权文件夹" };
      await this.update(task, "running", `ONE Local Agent 已连接：${task.targetName}`);

      const messages: ModelToolMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: task.instruction }
      ];
      if (followup) {
        const priorEvents = taskEvents(db, task).slice(-30).map((item) => `${item.kind}: ${item.text}`).join("\n");
        if (priorEvents) messages.push({ role: "assistant", content: `此前执行记录摘要：\n${priorEvents}` });
        messages.push({ role: "user", content: followup });
      }

      for (let step = 1; step <= maxSteps; step++) {
        if (this.cancelled.has(task.id)) return;
        db = await this.store.read();
        const account = powerAccount(db, task.workspaceId, task.userId);
        if (!account || account.balanceMicros <= 0) throw new Error("电力不足，Local Agent 已停止");
        const result = await callModelWithTools(model, messages, tools, `local-${task.id}-${step}`);
        await this.recordUsage(task, model, result.usage, step);
        messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls.length ? result.toolCalls : undefined });

        if (!result.toolCalls.length) {
          await this.finish(task, "completed", result.content.trim() || "本地任务已完成");
          return;
        }
        for (const call of result.toolCalls) {
          if (this.cancelled.has(task.id)) return;
          const tool = call.function.name as LocalToolName;
          let output: string;
          if (!allowedTools.has(tool)) {
            output = `错误：不支持工具 ${call.function.name}`;
          } else {
            let args: Record<string, unknown>;
            try {
              const parsed = JSON.parse(call.function.arguments || "{}");
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
              args = parsed;
            } catch {
              output = "错误：工具参数不是有效 JSON 对象";
              messages.push({ role: "tool", tool_call_id: call.id, content: output });
              continue;
            }
            await this.event(task, toolEventKind(tool), toolEventText(tool, args));
            try {
              const local = await this.presence.executeLocalTool(task.deviceId, task.id, tool, args);
              output = local.output || "完成";
            } catch (error) {
              output = `错误：${error instanceof Error ? error.message : "本机工具执行失败"}`;
            }
          }
          messages.push({ role: "tool", tool_call_id: call.id, content: output.slice(0, 120_000) });
        }
      }
      throw new Error(`Local Agent 已达到 ${maxSteps} 步上限，请缩小任务后继续`);
    } catch (error) {
      if (task && !this.cancelled.has(task.id)) await this.finish(task, "failed", error instanceof Error ? error.message : "Local Agent 执行失败");
    }
  }

  private async update(task: ExecutionTask, status: ExecutionTask["status"], text: string) {
    const timestamp = new Date().toISOString();
    await this.store.mutate((db) => {
      const target = db.executionTasks.find((item) => item.id === task.id && item.workspaceId === task.workspaceId && item.userId === task.userId);
      if (!target) return;
      target.status = status; target.updatedAt = timestamp;
      if (status === "running") target.startedAt ??= timestamp;
      if (task.targetName) target.targetName = task.targetName;
      appendExecutionEvent(db, { id: uid("exe"), workspaceId: target.workspaceId, userId: target.userId, taskId: target.id, kind: "status", text, createdAt: timestamp });
    });
  }

  private async event(task: ExecutionTask, kind: "status" | "command" | "file_change", text: string) {
    const timestamp = new Date().toISOString();
    await this.store.mutate((db) => {
      const target = db.executionTasks.find((item) => item.id === task.id && item.workspaceId === task.workspaceId && item.userId === task.userId);
      if (!target) return;
      target.updatedAt = timestamp;
      appendExecutionEvent(db, { id: uid("exe"), workspaceId: target.workspaceId, userId: target.userId, taskId: target.id, kind, text, createdAt: timestamp });
    });
  }

  private async finish(task: ExecutionTask, status: "completed" | "failed" | "cancelled", text: string) {
    const timestamp = new Date().toISOString();
    await this.store.mutate((db) => {
      const target = db.executionTasks.find((item) => item.id === task.id && item.workspaceId === task.workspaceId && item.userId === task.userId);
      if (!target) return;
      target.status = status; target.updatedAt = timestamp; target.completedAt = timestamp;
      if (status === "completed") { target.finalResponse = text; target.lastError = undefined; }
      else if (status === "failed") target.lastError = text;
      appendExecutionEvent(db, { id: uid("exe"), workspaceId: target.workspaceId, userId: target.userId, taskId: target.id, kind: status === "completed" ? "message" : status === "failed" ? "error" : "status", text, createdAt: timestamp });
    });
  }

  private async recordUsage(task: ExecutionTask, model: ModelConfig, usage: Awaited<ReturnType<typeof callModelWithTools>>["usage"], step: number) {
    if (!usage) return;
    const timestamp = new Date().toISOString();
    await this.store.mutate((db) => {
      const usageId = uid("use");
      const billing = calculateModelPower(model, usage.inputTokens, usage.outputTokens);
      chargePower(db, { workspaceId: task.workspaceId, userId: task.userId, amountMicros: billing.chargedMicros, modelId: model.id, usageRecordId: usageId, title: `ONE Local Agent 第 ${step} 步` });
      db.modelUsageRecords.push({
        id: usageId, workspaceId: task.workspaceId, userId: task.userId, conversationId: task.conversationId, modelId: model.id,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens, source: usage.source,
        chargedMicros: billing.chargedMicros, costMicros: billing.costMicros,
        inputPowerPerMillionSnapshot: model.inputPowerPerMillion, outputPowerPerMillionSnapshot: model.outputPowerPerMillion,
        costInputPowerPerMillionSnapshot: model.costInputPowerPerMillion, costOutputPowerPerMillionSnapshot: model.costOutputPowerPerMillion,
        requestId: `local-${task.id}-${step}`, status: "success", createdAt: timestamp
      });
    });
  }
}

function toolEventKind(tool: LocalToolName): "status" | "command" | "file_change" {
  if (tool === "run_command") return "command";
  if (tool === "write_file" || tool === "replace_in_file") return "file_change";
  return "status";
}

function toolEventText(tool: LocalToolName, args: Record<string, unknown>) {
  const path = typeof args.path === "string" ? args.path.slice(0, 300) : ".";
  if (tool === "list_files") return `正在查看：${path}`;
  if (tool === "read_file") return `正在读取：${path}`;
  if (tool === "search_text") return `正在搜索：${String(args.query ?? "").slice(0, 160)}`;
  if (tool === "write_file") return `请求写入：${path}`;
  if (tool === "replace_in_file") return `请求修改：${path}`;
  return `请求运行：${String(args.command ?? "").slice(0, 600)}`;
}
