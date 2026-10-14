import { useEffect, useState } from "react";
import type { api as Api } from "./oneApi";
import type { CapabilityCard } from "../server/capabilityCatalog";
import type { ExecutorValues } from "../server/executorProfiles";
import { aiTaskCatalog } from "../server/aiTaskCatalog";
import { ExecutorEditor } from "./ExecutorPanel";
import { FeatureEditor } from "./OfficialFeaturePanel";
import { AiTaskPanel, TaskEditor } from "./AiTaskPanel";
import { Pagination, SettingsDialog } from "./SettingsControls";
import { OneSkillLibrary } from "./OneSkillLibrary";

type Model = { id: string; name: string; kind: string; enabled: boolean };
type Catalog = { items: CapabilityCard[]; executorDefaults: ExecutorValues; defaultPlan: { id: string; name: string; family: string; installed: boolean }[] };
const kindNames = { executor: "执行 AI", feature: "业务功能", builtin: "平台能力" };
const outputNames = { text: "文字成果", image: "图片", local_file: "本机文件" };

export function UnifiedCapabilityPanel({ api, models }: { api: typeof Api; models: Model[] }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [query, setQuery] = useState(""), [page, setPage] = useState(1), [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<CapabilityCard | "new-executor" | "new-feature" | null>(null);
  const [technical, setTechnical] = useState(false), [library, setLibrary] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<Catalog>("/api/admin/capabilities", { signal: controller.signal }).then(setCatalog).catch((error) => { if (!controller.signal.aborted) setNotice(error.message); });
    return () => controller.abort();
  }, [api, refresh]);
  const items = (catalog?.items ?? []).filter((card) => (card.kind !== "builtin" || ["image_generation", "codex_execution", "local_agent", "notion_writer"].includes(card.taskKind ?? "")) && `${card.name} ${card.description}`.toLowerCase().includes(query.toLowerCase()));
  async function setup() {
    setBusy(true); setNotice("");
    try {
      const result = await api<{ added: string[]; existing: string[]; unavailable: { id: string; reason: string }[]; coordinatorUpdated: boolean }>("/api/admin/capabilities/defaults/setup", { method: "POST", body: JSON.stringify({ publish: true }) });
      setRefresh((n) => n + 1);
      setNotice([result.added.length ? "已建立默认能力，请查看各能力的启用状态和执行模型。" : "已有能力配置已保留，请查看当前启用状态。", result.coordinatorUpdated ? "调度的多任务分派与图片生成工具配置已更新。" : "", ...result.unavailable.map((item) => item.reason)].filter(Boolean).join(" "));
    } catch (error) { setNotice(error instanceof Error ? error.message : "配置未完成"); }
    finally { setBusy(false); }
  }
  const changed = () => setRefresh((n) => n + 1);
  const task = typeof selected === "object" && selected ? aiTaskCatalog.find((entry) => entry.id === (selected.executorId === "general" ? "task_worker" : selected.taskKind)) : undefined;
  return <section className="official-feature-admin">
    <header className="section-toolbar"><h3>能力配置</h3><button type="button" disabled={busy || !catalog} onClick={() => void setup()}>应用默认分工</button><button type="button" onClick={() => setLibrary(true)}>添加内置功能</button><button type="button" disabled={!catalog} onClick={() => setSelected("new-executor")}>＋ 执行 AI</button><button type="button" onClick={() => setSelected("new-feature")}>＋ 功能</button></header>
    <p className="hint">调度根据“什么时候用”选择能力；执行 AI 按“具体怎么做”完成任务。默认方案新增缺少的执行 AI，并更新已启用调度的分派工具；现有提示词和价格保留。</p>
    <input type="search" aria-label="搜索能力" placeholder="搜索执行 AI 或功能" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
    <div className="settings-choice-list">{items.slice((page - 1) * 10, page * 10).map((card) => <button type="button" key={card.id} onClick={() => setSelected(card)}><span><strong>{card.name}</strong><small>{kindNames[card.kind]} · {card.modelName ?? "待选择模型"} · {card.outputKinds.map((output) => outputNames[output]).join("、")}{card.usageMultiplier !== undefined ? ` · ${card.usageMultiplier} 倍` : ""} · {card.available ? `可用${card.version ? ` v${card.version}` : ""}` : card.unavailableReason}</small><small>{card.description}</small></span><span>配置</span></button>)}</div>
    <Pagination page={page} total={items.length} onChange={setPage} />
    <button type="button" onClick={() => setTechnical(true)}>调度 AI 与内部步骤配置</button>
    {notice ? <p role="status">{notice}</p> : null}
    {library ? <SettingsDialog title="添加 ONE 内置功能" onClose={() => setLibrary(false)}><OneSkillLibrary api={api} onInstalled={changed} /></SettingsDialog> : null}
    {technical ? <SettingsDialog title="调度 AI 与内部步骤配置" onClose={() => setTechnical(false)}><AiTaskPanel api={api} models={models} /></SettingsDialog> : null}
    {selected && catalog ? <SettingsDialog title={typeof selected === "string" ? selected === "new-executor" ? "新增执行 AI" : "新增功能" : selected.name} onClose={() => setSelected(null)}>
      {selected === "new-executor" ? <ExecutorEditor key="new-executor" api={api} id="new" defaults={catalog.executorDefaults} models={models} onChanged={(id) => { changed(); setSelected({ id: `executor:${id}`, executorId: id, kind: "executor", mode: "text", name: "执行 AI 配置", description: "", version: 0, available: false, outputKinds: ["text"], tools: [] }); }} />
        : selected === "new-feature" ? <FeatureEditor api={api} featureId="" onChanged={changed} />
        : selected.kind === "feature" ? <FeatureEditor key={selected.id} api={api} featureId={selected.featureId!} onChanged={changed} />
        : task ? <TaskEditor key={task.id} api={api} models={models} task={{ ...task, version: selected.version }} onChanged={changed} />
        : <ExecutorEditor key={selected.id} api={api} id={selected.executorId!} defaults={catalog.executorDefaults} models={models} onChanged={changed} />}
    </SettingsDialog> : null}
  </section>;
}
