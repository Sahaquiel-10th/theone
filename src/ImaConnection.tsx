import { useEffect, useId, useRef, useState, type FormEvent, type ClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import type { api as Api } from "./oneApi";
import { SettingsDialog } from "./SettingsControls";
import { parseImaCredentials } from "./imaCredentials";

export type ImaConnectionState = { provider: "ima"; status: "disconnected" | "pending" | "connected" | "error" | "revoked"; lastCheckedAt?: string; lastError?: string; retrievalScope?: { knowledgeBases: { id: string; name: string }[]; selectedIds: string[]; truncated: boolean } };
type State = { configured: boolean; connection: ImaConnectionState; managementRestricted?: boolean };
type Props = { api: typeof Api; query?: string; filter?: string; onConnectionChange?: (connection: ImaConnectionState) => void; open?: boolean; onOpenChange?: (open: boolean, source?: HTMLButtonElement) => void; detailTarget?: HTMLElement | null };
const empty: ImaConnectionState = { provider: "ima", status: "disconnected" };

export function ImaConnection({ api, query = "", filter = "all", onConnectionChange, open: controlledOpen, onOpenChange, detailTarget }: Props) {
  const [state, setState] = useState<State>(), [localOpen, setOpen] = useState(false), [notice, setNotice] = useState(""), [busy, setBusy] = useState("");
  const [clientId, setClientId] = useState(""), [apiKey, setApiKey] = useState(""), [updating, setUpdating] = useState(false), [selectedIds, setSelectedIds] = useState<string[]>([]);
  const active = useRef(true), pending = useRef(false), callback = useRef(onConnectionChange), formId = useId();
  callback.current = onConnectionChange;
  const open = controlledOpen ?? localOpen, connected = state?.connection.status === "connected";
  function changeOpen(value: boolean, source?: HTMLButtonElement) { if (controlledOpen === undefined) setOpen(value); onOpenChange?.(value, source); if (!value) { setClientId(""); setApiKey(""); } }
  function apply(next: State) { if (!active.current) return; setState(next); setSelectedIds(next.connection.retrievalScope?.selectedIds || []); if (next.managementRestricted) setNotice("当前空间的 ima 连接由空间管理员管理，请联系管理员。"); else if (!next.configured) setNotice("ima 连接暂未开通，请联系 ONE 管理员。"); else if (next.connection.status === "error" && next.connection.lastError) setNotice(next.connection.lastError); callback.current?.(next.connection); }
  useEffect(() => { active.current = true; api<State>("/api/knowledge/connections/ima").then(apply).catch(error => { if (active.current) { setState({ configured: false, connection: empty }); setNotice(error instanceof Error ? error.message : "无法读取 ima 连接状态，请稍后重试"); } }); return () => { active.current = false; }; }, [api]);
  useEffect(() => { if (!open) { setClientId(""); setApiKey(""); } }, [open]);
  async function action(kind: string, run: () => Promise<void>) {
    if (pending.current) return; pending.current = true; setBusy(kind); setNotice("");
    try { await run(); } catch (error) { if (active.current) setNotice((connected && kind === "connect" ? "更新未完成，现有连接仍保留。" : "") + (error instanceof Error ? error.message : "ima 操作未完成，请稍后重试")); }
    finally { pending.current = false; if (active.current) setBusy(""); }
  }
  async function connect(event: FormEvent) {
    event.preventDefault();
    await action("connect", async () => {
      const result = await api<{ connection: ImaConnectionState }>("/api/knowledge/connections/ima", { method: "PUT", body: JSON.stringify({ clientId: clientId.trim(), apiKey: apiKey.trim() }) });
      if (!active.current) return; setClientId(""); setApiKey(""); setUpdating(false); apply({ configured: true, connection: result.connection });
      setNotice(result.connection.retrievalScope && !result.connection.retrievalScope.selectedIds.length && result.connection.retrievalScope.knowledgeBases.length ? "ima 已连接。知识库较多，请在下方选择检索范围；个人笔记已可检索。" : "ima 已连接，读取接口检查通过。可以回到对话中搜索相关笔记和资料片段。");
    });
  }
  function pasteCredentials(event: ClipboardEvent<HTMLInputElement>) {
    const parsed = parseImaCredentials(event.clipboardData.getData("text"));
    if (parsed) { event.preventDefault(); setClientId(parsed.clientId); setApiKey(parsed.apiKey); }
  }
  const scope = state?.connection.retrievalScope;
  const scopeChanged = JSON.stringify([...selectedIds].sort()) !== JSON.stringify([...(scope?.selectedIds || [])].sort());
  const detail = <section className="ima-connection-detail">
    <p className="knowledge-connection-purpose">{connected ? updating ? "填写官网的新凭据，检查通过后才会替换；更新失败会保留现有连接。" : "ONE 会按问题检索你的个人笔记和下方选中的知识库。你可以调整范围、检查连接或随时断开。" : "首次从 ima 官网获取两项凭据，填好后即可连接。之后 ONE 会按问题检索个人笔记和所选知识库。"}</p>
    <p className="hint">此连接只读：不新建、修改或删除 ima 内容，不同步整个知识库。资料按关键词检索，效果不等同于 ima 内置的语义问答。</p>
    {connected && !updating ? <div className="notice" role="status">ima 已连接</div> : <form onSubmit={event => void connect(event)} className="ima-credential-form" aria-label="连接腾讯 ima">
      <a href="https://ima.qq.com/agent-interface" target="_blank" rel="noopener noreferrer">打开 ima 官网获取凭据</a>
      <p className="hint" id={`${formId}-help`}>在官网生成凭据，分别填入下方；也可将官网复制的整段配置信息粘贴到任意一栏，自动填好两项。不要发到聊天里，连接成功后输入框会自动清空。</p>
      <label htmlFor={`${formId}-client`}>Client ID<input id={`${formId}-client`} type="password" autoComplete="off" spellCheck={false} required maxLength={2000} value={clientId} disabled={!!busy} onPaste={pasteCredentials} onChange={e => setClientId(e.target.value)} aria-describedby={`${formId}-help`} /></label>
      <label htmlFor={`${formId}-key`}>API Key<input id={`${formId}-key`} type="password" autoComplete="new-password" spellCheck={false} required minLength={8} maxLength={8192} value={apiKey} disabled={!!busy} onPaste={pasteCredentials} onChange={e => setApiKey(e.target.value)} aria-describedby={`${formId}-help`} /></label>
      <p className="hint">凭据仅加密保存在服务端，不会回显或交给 AI。官方凭据可能含写入能力，ONE 只调用审核过的读取接口。</p>
      <button className="primary" type="submit" disabled={!state?.configured || !!busy || !clientId.trim() || apiKey.trim().length < 8}>{busy === "connect" ? "正在检查并连接…" : updating ? "检查并更新凭据" : "检查并连接 ima"}</button>
      {updating ? <button className="secondary" type="button" disabled={!!busy} onClick={() => { setUpdating(false); setClientId(""); setApiKey(""); setNotice("已保留现有连接，未修改凭据。"); }}>保留现有连接</button> : null}
    </form>}
    {connected && scope ? <fieldset className="ima-scope" disabled={!!busy}>
      <legend>知识库检索范围</legend><p className="hint">最多选择 5 个知识库。个人笔记始终参与检索；不选知识库时只检索个人笔记。</p>
      {scope.knowledgeBases.length ? <div className="ima-scope-list">{scope.knowledgeBases.map(library => <label key={library.id}><input type="checkbox" checked={selectedIds.includes(library.id)} disabled={!selectedIds.includes(library.id) && selectedIds.length >= 5} onChange={e => setSelectedIds(ids => e.target.checked ? [...ids, library.id] : ids.filter(id => id !== library.id))} /><span>{library.name}</span></label>)}</div> : <p className="hint">ima 尚未返回可检索的知识库，仍可搜索本人的笔记。</p>}
      {scope.truncated ? <p className="hint">本次显示前 100 个知识库。如未找到目标库，请联系 ONE 管理员。</p> : null}
      <button className="secondary" type="button" disabled={!scopeChanged || !!busy} onClick={() => void action("scope", async () => { const result = await api<State>("/api/knowledge/connections/ima/scope", { method: "PATCH", body: JSON.stringify({ selectedIds }) }); apply(result); if (active.current) setNotice("检索范围已保存，后续问题会使用新范围。"); })}>{busy === "scope" ? "正在保存…" : "保存检索范围"}</button>
      <button className="secondary" type="button" disabled={!!busy || scopeChanged} onClick={() => void action("libraries", async () => { apply(await api<State>("/api/knowledge/connections/ima/libraries/refresh", { method: "POST" })); if (active.current) setNotice("知识库列表已刷新。新增知识库不会自动勾选，请按需选择并保存。"); })}>{busy === "libraries" ? "正在刷新…" : "刷新知识库列表"}</button>
    </fieldset> : null}
    {connected ? <div className="ima-connection-actions"><button className="secondary" type="button" disabled={!!busy} onClick={() => void action("check", async () => { await api("/api/knowledge/connections/ima/check", { method: "POST" }); if (active.current) setNotice("ima 读取接口检查通过。"); })}>{busy === "check" ? "正在检查…" : "检查连接"}</button><button className="secondary" type="button" disabled={!!busy} onClick={() => { setUpdating(true); setNotice(""); }}>更新凭据</button><button className="danger" type="button" disabled={!!busy} onClick={() => { if (!window.confirm("断开 ima？ONE 将停止使用这组凭据，不会删除 ima 中的内容。")) return; void action("disconnect", async () => { await api("/api/knowledge/connections/ima", { method: "DELETE" }); apply({ configured: true, connection: empty }); if (active.current) { setClientId(""); setApiKey(""); setUpdating(false); setNotice("已断开 ima。如需使凭据本身失效，请前往 ima 官网撤销。"); } }); }}>断开连接</button></div> : null}
    {notice ? <p role="status" className="ima-connection-feedback">{notice}</p> : null}
  </section>;
  const visible = `腾讯 ima`.toLowerCase().includes(query.trim().toLowerCase()) && (filter === "all" || (filter === "connected" ? connected : !connected));
  return <>{visible ? <button type="button" className={`knowledge-source-card${open ? " is-selected" : ""}`} aria-expanded={open} onClick={event => changeOpen(true, event.currentTarget)}><span className="knowledge-source-mark ima">i</span><span><strong>腾讯 ima</strong><small>个人笔记 · 知识库片段</small></span><span className="knowledge-source-status">{!state ? "检查中" : connected ? "已连接" : state.connection.status === "error" ? "需重连" : "连接"}<ChevronRight size={14} /></span></button> : null}{detailTarget !== undefined ? detailTarget ? createPortal(detail, detailTarget) : null : open ? <SettingsDialog title="腾讯 ima" onClose={() => changeOpen(false)}>{detail}</SettingsDialog> : null}</>;
}
