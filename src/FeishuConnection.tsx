import { useEffect, useState } from "react";
import type { api as Api } from "./oneApi";
import { SettingsDialog } from "./SettingsControls";
type Connection = { status: string; providerSpaceName?: string; accountId?: string };
type State = { configured: boolean; installUrl?: string; connection: Connection };
export function FeishuConnection({ api }: { api: typeof Api }) {
  const [state, setState] = useState<State>(), [open, setOpen] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = () => api<State>("/api/knowledge/connections/feishu").then(setState);
  useEffect(() => { let active = true; api<State>("/api/knowledge/connections/feishu").then(s => { if (active) setState(s); }).catch(() => {}); return () => { active = false; }; }, [api]);
  async function connect() { setBusy(true); setError(""); try { const r = await api<{ authorizationUrl: string }>("/api/knowledge/connections/feishu/oauth/start", { method: "POST" }); window.location.assign(r.authorizationUrl); } catch (e) { setError(e instanceof Error ? e.message : "暂时无法连接"); setBusy(false); } }
  async function disconnect() { if (!confirm("断开飞书连接？")) return; setBusy(true); try { await api("/api/knowledge/connections/feishu", { method: "DELETE" }); await load(); } catch (e) { setError(e instanceof Error ? e.message : "断开失败"); } finally { setBusy(false); } }
  return <><button className="knowledge-source-card" type="button" onClick={() => setOpen(true)}><span className="knowledge-source-mark">飞</span><span><strong>飞书</strong><small>搜索云文档 · 保存回答</small></span><span>{state?.connection.status === "connected" ? "已连接" : "连接"}</span></button>
    {open ? <SettingsDialog title="飞书" onClose={() => setOpen(false)}><p>{state?.connection.providerSpaceName || "连接你的飞书账号"}</p>
      {state?.connection.status === "connected" ? <button type="button" className="secondary" disabled={busy} onClick={() => void disconnect()}>断开连接</button> : <button className="primary" type="button" disabled={!state?.configured || busy} onClick={() => void connect()}>连接飞书</button>}
      <details><summary>请管理员开通</summary><ol><li>请企业管理员安装 ONE，并批准文档搜索、读取和新建权限。</li><li>将你的账号加入应用可用范围。</li><li>返回这里，点击“连接飞书”。</li></ol>{state?.installUrl ? <a href={state.installUrl} target="_blank" rel="noreferrer">打开管理员安装入口</a> : <p>ONE 应用安装入口准备中，请联系 ONE 管理员。</p>}</details>
      {error ? <p role="status">{error}</p> : null}</SettingsDialog> : null}</>;
}
export function SaveToFeishu({ api, messageId, content }: { api: typeof Api; messageId: string; content: string }) {
  const [open, setOpen] = useState(false), [state, setState] = useState<State>(), [title, setTitle] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [operationId] = useState(() => crypto.randomUUID());
  const [receipt, setReceipt] = useState<{ status: string; documentId?: string; url?: string }>();
  async function preview() { setOpen(true); setError(""); setTitle(content.split("\n").find(s => s.trim())?.replace(/^#+\s*/, "").slice(0, 80) || "ONE 回答"); try { setState(await api<State>("/api/knowledge/connections/feishu")); } catch (e) { setError(e instanceof Error ? e.message : "读取连接失败"); } }
  async function save() { setBusy(true); setError(""); try { const r = await api<{ receipt: { status: string; documentId?: string; url?: string } }>("/api/knowledge/connections/feishu/documents", { method: "POST", body: JSON.stringify({ operationId, sourceMessageId: messageId, title, expectedAccount: state?.connection.accountId, confirmed: true }) }); setReceipt(r.receipt); } catch(e) { setError(e instanceof Error ? e.message : "保存未完成"); } finally { setBusy(false); } }
  return <><button className="message-text-action" type="button" title="保存到飞书" onClick={() => void preview()}>保存到飞书</button>{open ? <SettingsDialog title="保存到飞书" onClose={() => setOpen(false)}>
    {state?.connection.status === "connected" ? <><p>目标账号：{state.connection.providerSpaceName || "飞书账号"}</p><label>文档标题<input maxLength={200} value={title} disabled={busy || !!receipt} onChange={e => setTitle(e.target.value)} /></label><details><summary>预览正文（纯文本）</summary><pre style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>{content}</pre></details>
      {!receipt ? <button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void save()}>{busy ? "正在保存…" : "确认新建文档"}</button> : <p role="status">{receipt.status === "completed" ? "已保存到飞书" : "保存结果待核对，请先查看飞书，避免重复创建"}{receipt.url ? <> · <a href={receipt.url} target="_blank" rel="noreferrer">打开文档</a></> : receipt.documentId ? ` · 文档编号 ${receipt.documentId}` : null}</p>}</> : <p>请先在“知识连接”中连接飞书。</p>}
    {error ? <p role="status">{error}</p> : null}</SettingsDialog> : null}</>;
}
