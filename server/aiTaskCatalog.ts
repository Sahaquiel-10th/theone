/** Configuration inventory, not a claim that the unified runner is enabled. */
export const aiTaskCatalog = [
  { id: "chat", name: "聊天回答", modelKind: "chat", toolCapable: false, implementation: "existing" },
  { id: "attachment_summary", name: "附件整理", modelKind: "chat", toolCapable: false, implementation: "existing" },
  { id: "execution_compile", name: "对话转执行指令", modelKind: "chat", toolCapable: false, implementation: "existing" },
  { id: "local_agent", name: "本地执行 Agent", modelKind: "chat", toolCapable: true, implementation: "existing" },
  { id: "image_generation", name: "图片生成", modelKind: "image", toolCapable: false, implementation: "existing" },
  { id: "orchestrator", name: "核心调度 Agent", modelKind: "chat", toolCapable: true, implementation: "existing" }
] as const;

export type AiTaskKind = typeof aiTaskCatalog[number]["id"];

export function findAiTaskDefinition(id: string) {
  return aiTaskCatalog.find(task => task.id === id);
}

export type TaskEntryPoint = "workspace" | "published_web" | "published_api";

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
    return Boolean(tool && granted.has(name) && (!tool.localOnly || input.entryPoint === "workspace"));
  });
}
