/** Configuration inventory, not a claim that the unified runner is enabled. */
export const aiTaskCatalog = [
  { id: 'welcome_manual', name: '个人使用说明策划', modelKind: 'chat', toolCapable: false, implementation: 'existing' },
  { id: "chat", name: "聊天回答", modelKind: "chat", toolCapable: false, implementation: "existing" },
  { id: "shared_answer", name: "分享分身问答", modelKind: "chat", toolCapable: false, implementation: "existing" },
  { id: "attachment_summary", name: "附件整理", modelKind: "chat", toolCapable: false, implementation: "existing" },
  { id: "execution_compile", name: "对话转执行指令", modelKind: "chat", toolCapable: false, implementation: "existing" },
  { id: "local_agent", name: "本地执行 Agent", modelKind: "chat", toolCapable: true, implementation: "existing" },
  { id: "codex_execution", name: "Codex 本机执行（ONE 网关）", modelKind: "chat", toolCapable: false, implementation: "existing" },
  { id: "image_generation", name: "图片生成", modelKind: "image", toolCapable: false, implementation: "existing" },
  { id: "orchestrator", name: "检索与工具调度（原聊天）", modelKind: "chat", toolCapable: true, implementation: "existing" },
  { id: "coordinator", name: "ONE 持续对话与任务分派", modelKind: "chat", toolCapable: true, implementation: "existing" },
  { id: "task_worker", name: "通用事情执行 AI", modelKind: "chat", toolCapable: true, implementation: "existing" },
  { id: 'notion_writer', name: 'Notion 写作模型与提示词', modelKind: 'chat', toolCapable: false, implementation: 'existing' }
] as const;

export type AiTaskKind = typeof aiTaskCatalog[number]["id"];

export function findAiTaskDefinition(id: string) {
  return aiTaskCatalog.find(task => task.id === id);
}

export type TaskEntryPoint = "workspace" | "published_web" | "published_api";

/** Code-owned capability ceiling. Public assistants may use only explicitly
 * bound reviewed feature wrappers and a small set of namespaced, server-local
 * helpers. This is not a grant: callers still intersect the exact publication
 * configuration, and knowledge handlers require an exact source binding.
 */
export function entryAllowsTool(entryPoint: TaskEntryPoint, name: string): boolean {
  if (entryPoint === "workspace") return true;
  if (entryPoint === "published_web" || entryPoint === "published_api") return name === "knowledge_search" || /^public_feature_[0-3]$/.test(name) || ["public_oneFinance", "public_oneTable", "public_oneHtml", "public_oneFlowchart", "public_oneWorkbook", "public_oneDocument"].includes(name);
  return false;
}

/** Caller must supply server-resolved grants, never client-supplied tool lists.
 * This pure intersection is only one gate; execution still requires current
 * ownership, connection, presence (workspace), budget and approval checks.
 */
export function intersectTaskTools(input: {
  configured: readonly string[];
  granted: readonly string[];
  available: readonly { name: string; localOnly: boolean }[];
  entryPoint: TaskEntryPoint;
}): string[] {
  // Fail closed even if a runtime caller bypasses TypeScript.
  if (!["workspace", "published_web", "published_api"].includes(input.entryPoint)) return [];
  const granted = new Set(input.granted);
  const available = new Map(input.available.map(tool => [tool.name, tool]));
  return [...new Set(input.configured)].filter(name => {
    const tool = available.get(name);
    return Boolean(tool && granted.has(name) && entryAllowsTool(input.entryPoint, name) && (!tool.localOnly || input.entryPoint === "workspace"));
  });
}
