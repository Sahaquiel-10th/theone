import { useEffect, useState } from "react";
import type { api as apiType } from "./oneApi";
import { Pagination, SearchPicker, SettingsDialog } from "./SettingsControls";

type Values = { modelId: string; prompt: string; tools: string[]; maxSteps: number; promptMode?: "replace"; toolDescriptions?: Record<string, string>; enabled?: boolean; imageRoute?: "images" | "responses"; imageServiceModel?: string; imagePowerPerCall?: number; costImagePowerPerCall?: number };
type Version = Values & { version: number; publishedAt: string };
type Summary = { id: string; name: string; modelKind: string; implementation: string; version: number };
type Detail = { definition: Summary; revision: number; draft: Values; defaults: Values; published?: Version; tools: string[]; toolDefaults: Record<string, string>; registeredTools?: { name: string; label: string; localOnly: boolean; readOnly: boolean }[]; history: Version[]; total: number };
type Model = { id: string; name: string; kind: string; enabled: boolean;protocol?:string;inputPowerPerMillion?:number;outputPowerPerMillion?:number;imagePowerPerCall?:number;costImagePowerPerCall?:number;cachePrices?:{read?:number;write?:number;write1h?:number} };
const toolNames: Record<string, string> = { execute_local_task: "交给本机执行", search_tasks: "查找本人事情", read_task: "读取事情上下文", delegate_task: "分派到独立事情", knowledge_search: "检索已授权知识", web_search: "联网搜索", list_files: "列出文件", read_file: "读取文件", search_text: "搜索文本", write_file: "写入文件", replace_in_file: "替换文本", run_command: "执行命令（仍需本机确认）" };

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

export function TaskEditor({ api, task, models, onChanged }: { api: typeof apiType; task: Summary; models: Model[]; onChanged: () => void }) {
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
      let expectedRevision = detail.revision;
      if (action === "publish") {
        await api(`/api/admin/ai-tasks/${task.id}`, { method: "POST", body: JSON.stringify({ revision: expectedRevision, action: "draft", values }) });
        expectedRevision++;
      }
      await api(`/api/admin/ai-tasks/${task.id}`, { method: "POST", body: JSON.stringify({ revision: expectedRevision, action, values, version }) });
      const d = await api<Detail>(`/api/admin/ai-tasks/${task.id}`);
      setDetail(d); setValues(d.draft); setHistoryPage(1); setHistory(d.history); onChanged();
      setNotice(action === "draft" ? "草稿已保存，尚未影响线上" : "已发布，仅影响新任务");
    } catch (e) { setNotice(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }
  if (!detail || !values) return <p role="status">{notice || "正在加载…"}</p>;
  if (task.implementation === "planned") return <p>核心调度执行器正在开发，暂不能发布配置。</p>;
  const dirty = JSON.stringify(values) !== JSON.stringify(detail.draft);
  const selectedModel=models.find(m=>m.id===values.modelId);
  const imageTask = task.id === "image_generation";
  return <div className="ai-task-editor">
    <p>{imageTask ? "选择已接入的图片模型，或使用已有 GPT 模型的授权调用专用图片接口。图片按张计费；这里的配置不会改变普通文字价格。" : "未指定模型时沿用原有选择。价格在“模型与定价”统一维护。工具只能从已接入目录中选择，不能在后台凭空创建函数。"}</p>
    <fieldset disabled={busy}>
      {task.id === "orchestrator" && <label><input type="checkbox" checked={values.enabled === true} onChange={e => setValues({ ...values, enabled: e.target.checked })} />启用纯文本聊天调度（附件和图片沿用现有流程）</label>}
      {task.id === "coordinator" && <label><input type="checkbox" checked={values.enabled === true} onChange={e => setValues({ ...values, enabled: e.target.checked })} />启用持续对话与独立任务（发布后工作台采用新版流程；关闭后回到原聊天）</label>}
      <label>{imageTask ? "图片接口所用模型授权" : "任务模型"}</label>
      <SearchPicker label="模型" value={values.modelId} options={[{ value: "", label: imageTask ? "请选择已接入模型" : "沿用原有模型" }, ...models.filter(m => m.enabled && (imageTask ? m.protocol !== "anthropic" && (values.imageRoute === "responses" ? m.kind === "chat" : ["image", "chat"].includes(m.kind)) : m.kind === task.modelKind)).map(m => ({ value: m.id, label: m.name }))]} onChange={modelId => setValues({ ...values, modelId })} />
      {imageTask ? <>
        <label>作图接口<select value={values.imageRoute ?? "images"} onChange={e => setValues({ ...values, imageRoute: e.target.value as "images" | "responses" })}><option value="images">专用图片接口（推荐）</option><option value="responses">GPT 聊天工具作图（兼容测试）</option></select></label>
        <label>图片服务模型<input maxLength={100} placeholder={selectedModel?.kind === "image" ? "留空沿用已接入图片模型" : "默认 gpt-image-2"} value={values.imageServiceModel ?? ""} onChange={e => setValues({ ...values, imageServiceModel: e.target.value.trim() || undefined })} /></label>
        <label>每张图片售价（电力）<input type="number" min={0} max={1e6} step="0.01" placeholder={selectedModel?.kind === "image" ? "留空沿用图片模型售价" : "待确认价格"} value={values.imagePowerPerCall ?? ""} onChange={e => setValues({ ...values, imagePowerPerCall: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
        <label>每张图片采购成本（电力）<input type="number" min={0} max={1e6} step="0.01" placeholder={selectedModel?.kind === "image" ? "留空沿用图片模型成本" : "待填写成本"} value={values.costImagePowerPerCall ?? ""} onChange={e => setValues({ ...values, costImagePowerPerCall: e.target.value === "" ? undefined : Number(e.target.value) })} /></label>
        <p className="hint">一次生成一张 1K 图片。售价或成本未配置时能力不可用；新发布价格只影响新任务，已排队任务保留当时的费用。</p>
      </> : selectedModel?<details><summary>查看当前模型费用</summary>{selectedModel.kind==='image'?<p>每次生成 {selectedModel.imagePowerPerCall??'未配置'} 电力</p>:<><p>输入 {selectedModel.inputPowerPerMillion??'未配置'} · 输出 {selectedModel.outputPowerPerMillion??'未配置'} 电力 / 百万计量单位</p>{selectedModel.cachePrices?<p>缓存读取 {selectedModel.cachePrices.read??'未配置'} · 基础写入 {selectedModel.cachePrices.write??'未配置'} · 1 小时写入 {selectedModel.cachePrices.write1h??'未配置'} 电力 / 百万计量单位</p>:null}</>}<small>显示当前对外费率，折扣已包含；实际消耗查看本人任务账单。价格仍只在模型与定价中维护。</small></details>:<p className="hint">沿用运行时选择的模型；实际模型和消耗在本人任务记录中查看。</p>}
      <label>任务提示词<textarea style={{ width: "100%" }} rows={9} maxLength={12000} value={values.prompt} onChange={e => setValues({ ...values, prompt: e.target.value, promptMode: "replace" })} /></label>
      <button type="button" onClick={() => { if (confirm("用预制配置替换当前编辑内容？保存并发布后才生效。")) setValues(structuredClone(detail.defaults)); }}>恢复预制配置</button>
{detail.tools.length > 0 && <><h4>允许使用的工具</h4>{detail.tools.map(tool => <details key={tool}><summary>{toolNames[tool] || tool} · {values.tools.includes(tool) ? "已启用" : "未启用"}</summary><label><input type="checkbox" checked={values.tools.includes(tool)} onChange={e => setValues({ ...values, tools: e.target.checked ? [...values.tools, tool] : values.tools.filter(t => t !== tool) })} />允许调用</label><label>何时调用（提供给 AI）<textarea style={{ width: "100%" }} rows={4} maxLength={2000} value={values.toolDescriptions?.[tool] ?? detail.toolDefaults[tool] ?? ""} onChange={e => setValues({ ...values, toolDescriptions: { ...values.toolDescriptions, [tool]: e.target.value } })} /></label></details>)}<label>最大步骤<input type="number" min={1} max={task.id === "local_agent" ? 24 : 4} value={values.maxSteps} onChange={e => setValues({ ...values, maxSteps: Number(e.target.value) })} /></label></>}
      <div className="settings-pagination"><button onClick={() => void save("draft")}>保存草稿</button><button disabled={dirty} onClick={() => { if (confirm("发布后，新任务将使用这份模型、提示词和工具配置。确认发布？")) void save("publish"); }}>发布配置</button></div>
      {dirty && <p>先保存草稿，再发布。</p>}
    </fieldset>
    {notice && <p role="status">{notice}</p>}
    <details><summary>当前生效配置 · {detail.published ? `v${detail.published.version}` : "原有默认配置"}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{detail.published ? JSON.stringify(detail.published, null, 2) : "未发布覆盖配置"}</pre></details>
    <details><summary>发布历史 · {detail.total} 个版本</summary>{history.map(item => <details key={item.version}><summary>v{item.version} · {new Date(item.publishedAt).toLocaleString()}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(item, null, 2)}</pre><button disabled={busy} onClick={() => { if (confirm(`以 v${item.version} 的内容发布新版本？未保存的编辑将被替换。`)) void save("rollback", item.version); }}>恢复此版本并发布</button></details>)}<Pagination page={historyPage} size={5} total={detail.total} onChange={setHistoryPage} /></details>
  </div>;
}
