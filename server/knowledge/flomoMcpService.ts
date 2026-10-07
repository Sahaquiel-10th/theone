import type { Store } from "../db.js";
import type { KnowledgeConnection } from "../types.js";
import type { KnowledgeChunk } from "./provider.js";
import { RemoteMcpKnowledgeService, mcpDeadline, closeMcpClient, type RemoteMcpServiceOptions, type RemoteMcpTool } from "./remoteMcpKnowledgeService.js";
import { flomoConfig } from "./remoteMcpProviders.js";

const incompatible = () => new Error("flomo 只读接口暂不兼容，请联系管理员");
type Schema = { type?: string; items?: { type?: string }; minimum?: number; maximum?: number };

/** Tool schemas are data, never executable instructions; only reviewed names and fields can be used. */
export function flomoArguments(tool: RemoteMcpTool, value: string | string[], limit: number): Record<string, unknown> {
  const props = tool.inputSchema?.properties;
  if (!props) throw incompatible();
  const aliases = tool.name === "memo_search" ? ["query", "keyword", "keywords"] : tool.name === "memo_batch_get" ? ["memo_ids", "ids"] : [];
  const field = aliases.find(name => Object.hasOwn(props, name));
  if (!field) throw incompatible();
  const schema = props[field] as Schema | null;
  const args: Record<string, unknown> = {};
  if (typeof value === "string" && schema?.type === "string") args[field] = value.slice(0, 4000);
  else if (schema?.type === "array" && schema.items?.type === "string") args[field] = typeof value === "string" ? [value.slice(0, 4000)] : value;
  else if (Array.isArray(value) && schema?.type === "array" && (schema.items?.type === "number" || schema.items?.type === "integer")) {
    if (value.some(id => !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)))) throw incompatible();
    args[field] = value.map(Number);
  } else throw incompatible();
  for (const name of ["limit", "page_size"]) {
    const size = props[name] as Schema | undefined;
    if (size?.type !== "integer" && size?.type !== "number") continue;
    const count = Math.min(limit, size.maximum ?? limit);
    if (!Number.isFinite(count) || count < 1 || (size.minimum ?? 1) > count) throw incompatible();
    args[name] = count;
  }
  if (tool.inputSchema?.required?.some(name => !Object.hasOwn(args, name))) throw incompatible();
  return args;
}

type Memo = { id: string; title?: string; content?: string; url?: string };
function memos(result: unknown): Memo[] {
  if (!result || typeof result !== "object") throw incompatible();
  const response = result as { isError?: boolean; structuredContent?: unknown; content?: { type?: string; text?: string }[] };
  if (response.isError) throw new Error("flomo 读取未完成，请稍后重试");
  if (JSON.stringify(result).length > 256_000) throw new Error("flomo 返回内容超过安全限制");
  let data = response.structuredContent;
  if (!data) {
    const text = response.content?.filter(b => b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
    if (!text) return [];
    try { data = JSON.parse(text); } catch { throw incompatible(); }
  }
  const found: Memo[] = [];
  function visit(value: unknown, depth = 0) {
    if (depth > 6 || found.length >= 100 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return; }
    const item = value as Record<string, unknown>;
    const rawId = item.id ?? item.memo_id;
    const id = typeof rawId === "string" ? rawId : typeof rawId === "number" && Number.isSafeInteger(rawId) ? String(rawId) : undefined;
    if (id && id.length <= 2000) found.push({ id, title: typeof item.title === "string" ? item.title : undefined, content: [item.content, item.text, item.markdown, item.snippet].find(v => typeof v === "string") as string | undefined, url: typeof item.url === "string" ? item.url : undefined });
    for (const key of ["memos", "data", "results", "items", "notes"]) visit(item[key], depth + 1);
  }
  visit(data);
  return [...new Map(found.map(m => [m.id, m])).values()];
}

function sourceUrl(input?: string) {
  if (!input) return undefined;
  try { const u = new URL(input); return u.protocol === "https:" && !u.username && !u.password && (!u.port || u.port === "443") && flomoConfig.sourceHosts.includes(u.hostname) ? u.toString() : undefined; } catch { return undefined; }
}

export class FlomoMcpService extends RemoteMcpKnowledgeService {
  constructor(store: Store, options: RemoteMcpServiceOptions = {}) { super(store, flomoConfig, options); }

  protected override validateTools(tools: RemoteMcpTool[]) {
    super.validateTools(tools);
    flomoArguments(tools.find(t => t.name === "memo_search")!, "接口检查", 5);
    flomoArguments(tools.find(t => t.name === "memo_batch_get")!, ["1"], 5);
  }

  protected override async searchConnected(connection: KnowledgeConnection, query: string, topK: number): Promise<KnowledgeChunk[]> {
    const client = await this.clientFor(connection);
    try {
      const { tools } = await mcpDeadline(client.listTools(), "flomo 工具查询超时");
      const search = tools.find(t => t.name === "memo_search"), read = tools.find(t => t.name === "memo_batch_get");
      if (!search || !read) throw incompatible();
      const limit = Math.max(1, Math.min(10, Number.isFinite(topK) ? Math.floor(topK) : 5));
      const selected = memos(await mcpDeadline(client.callTool({ name: search.name, arguments: flomoArguments(search, query, limit) }), "flomo 搜索超时")).slice(0, limit);
      if (!selected.length) return [];
      const fetched = memos(await mcpDeadline(client.callTool({ name: read.name, arguments: flomoArguments(read, selected.map(m => m.id), limit) }), "flomo 正文读取超时"));
      const byId = new Map(fetched.map(m => [m.id, m]));
      return selected.flatMap(hit => {
        const memo = byId.get(hit.id);
        if (!memo?.content) return [];
        const content = memo.content.replace(/<[^>]*>/g, " ").trim().slice(0, 24_000);
        return content ? [{ id: memo.id, provider: "flomo" as const, title: (memo.title || content.split("\n")[0] || "flomo 笔记").slice(0, 100), content, sourceUrl: sourceUrl(memo.url || hit.url) }] : [];
      });
    } finally { await closeMcpClient(client, "flomo"); }
  }
}
