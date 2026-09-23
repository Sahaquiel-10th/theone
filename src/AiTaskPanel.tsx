import { useEffect, useState } from "react";
import type { api as apiType } from "./oneApi";
import { Pagination, SearchPicker, SettingsDialog } from "./SettingsControls";

type Values = { modelId: string; prompt: string; tools: string[]; maxSteps: number };
type Version = Values & { version: number; publishedAt: string };
type Summary = { id: string; name: string; modelKind: string; implementation: string; version: number };
type Detail = { definition: Summary; revision: number; draft: Values; published?: Version; tools: string[]; history: Version[]; total: number };
type Model = { id: string; name: string; kind: string; enabled: boolean };
const toolNames: Record<string, string> = { list_files: "列出文件", read_file: "读取文件", search_text: "搜索文本", write_file: "写入文件", replace_in_file: "替换文本", run_command: "执行命令（仍需本机确认）" };

export function AiTaskPanel({ api, models }: { api: typeof apiType; models: Model[] }) {
  const [tasks, setTasks] = useState<Summary[]>([]), [query, setQuery] = useState(""), [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Summary | null>(null), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<{ tasks: Summary[] }>("/api/admin/ai-tasks", { signal: controller.signal }).then(r => setTasks(r.tasks)).catch(e => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [api, revision]);
  const filtered = tasks.filter(t => `${t.name} ${t.id}`.toLowerCase().includes(query.toLowerCase()));
  return <section>
    <h3>AI 任务配置</h3>
    <input type="search" aria-label="搜索 AI 任务" placeholder="搜索任务" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} />
    {error && <p role="alert">{error}</p>}
    <div className="settings-choice-list">{filtered.slice((page - 1) * 10, page * 10).map(task => <button key={task.id} onClick={() => setSelected(task)}><span><strong>{task.name}</strong><small>{task.implementation === "planned" ? "开发中 · 尚未启用" : task.version ? `已发布 v${task.version}` : "使用原有默认配置"}</small></span><span>详情</span></button>)}</div>
    <Pagination page={page} total={filtered.length} onChange={setPage} />
    {selected && <SettingsDialog title={selected.name} onClose={() => setSelected(null)}><TaskEditor key={selected.id} api={api} task={selected} models={models} onChanged={() => setRevision(n => n + 1)} /></SettingsDialog>}
  </section>;
}

function TaskEditor({ api, task, models, onChanged }: { api: typeof apiType; task: Summary; models: Model[]; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null), [values, setValues] = useState<Values | null>(null);
  const [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [historyPage, setHistoryPage] = useState(1), [history, setHistory] = useState<Version[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    api<Detail>(`/api/admin/ai-tasks/${task.id}`, { signal: controller.signal }).then(d => { setDetail(d); setValues(d.draft); setHistory(d.history); }).catch(e => { if (!controller.signal.aborted) setNotice(e.message); });
    return () => controller.abort();
  }, [api, task.id]);
  useEffect(() => {
    const controller = new AbortController();
    api<Detail>(`/api/admin/ai-tasks/${task.id}?page=${historyPage}`, { signal: controller.signal }).then(d => setHistory(d.history)).catch(e => { if (!controller.signal.aborted) setNotice(e.message); });
    return () => controller.abort();
  }, [api, task.id, historyPage]);
  async function save(action: string, version?: number) {
    if (!detail || !values) return;
    setBusy(true); setNotice("");
    try {
      await api(`/api/admin/ai-tasks/${task.id}`, { method: "POST", body: JSON.stringify({ revision: detail.revision, action, values, version }) });
      const d = await api<Detail>(`/api/admin/ai-tasks/${task.id}`);
      setDetail(d); setValues(d.draft); setHistoryPage(1); setHistory(d.history); onChanged();
      setNotice(action === "draft" ? "草稿已保存，尚未影响线上" : "已发布，仅影响新任务");
    } catch (e) { setNotice(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }
  if (!detail || !values) return <p role="status">{notice || "正在加载…"}</p>;
  if (task.implementation === "planned") return <p>核心调度执行器正在开发，暂不能发布配置。</p>;
  const dirty = JSON.stringify(values) !== JSON.stringify(detail.draft);
  return <div className="ai-task-editor">
    <p>未指定模型时沿用原有选择。价格在“模型与定价”统一维护。</p>
    <fieldset disabled={busy}>
      <label>任务模型</label>
      <SearchPicker label="模型" value={values.modelId} options={[{ value: "", label: "沿用原有模型" }, ...models.filter(m => m.enabled && m.kind === task.modelKind).map(m => ({ value: m.id, label: m.name }))]} onChange={modelId => setValues({ ...values, modelId })} />
      <label>任务补充提示词<textarea style={{ width: "100%" }} rows={9} maxLength={12000} value={values.prompt} onChange={e => setValues({ ...values, prompt: e.target.value })} /></label>
      <small>附加到原有指令；清空后恢复原有行为。权限与安全校验不会被替换。</small>
      {detail.tools.length > 0 && <><h4>允许使用的工具</h4>{detail.tools.map(tool => <label key={tool} style={{ display: "block" }}><input type="checkbox" checked={values.tools.includes(tool)} onChange={e => setValues({ ...values, tools: e.target.checked ? [...values.tools, tool] : values.tools.filter(t => t !== tool) })} />{toolNames[tool] || tool}</label>)}<label>最大步骤<input type="number" min={1} max={24} value={values.maxSteps} onChange={e => setValues({ ...values, maxSteps: Number(e.target.value) })} /></label></>}
      <div className="settings-pagination"><button onClick={() => void save("draft")}>保存草稿</button><button disabled={dirty} onClick={() => { if (confirm("发布后，新任务将使用这份模型、提示词和工具配置。确认发布？")) void save("publish"); }}>发布配置</button></div>
      {dirty && <p>先保存草稿，再发布。</p>}
    </fieldset>
    {notice && <p role="status">{notice}</p>}
    <details><summary>当前生效配置 · {detail.published ? `v${detail.published.version}` : "原有默认配置"}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail.published ? JSON.stringify(detail.published, null, 2) : "未发布覆盖配置"}</pre></details>
    <details><summary>发布历史 · {detail.total} 个版本</summary>{history.map(item => <details key={item.version}><summary>v{item.version} · {new Date(item.publishedAt).toLocaleString()}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(item, null, 2)}</pre><button disabled={busy} onClick={() => { if (confirm(`以 v${item.version} 的内容发布新版本？未保存的编辑将被替换。`)) void save("rollback", item.version); }}>恢复此版本并发布</button></details>)}<Pagination page={historyPage} size={5} total={detail.total} onChange={setHistoryPage} /></details>
  </div>;
}
