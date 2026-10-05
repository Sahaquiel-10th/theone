import { useEffect, useState } from "react";
import type { api as Api } from "./oneApi";
import type { OfficialFeatureValues } from "../server/officialFeatures";
import { SearchPicker } from "./SettingsControls";
import { McpToolPicker, ToolAuthPicker, ToolCredentialEditor } from './FeatureConnections';

type Options = { models: { id: string; name: string }[]; tools: { id: string; name: string; description: string }[]; allowedEndpoints: string[]; mcpEndpoints?:string[] };
type Result = { content: string; finishReason?: string; trace: { step: number; tool: string; status: string; query?: string; resultPreview: string; durationMs: number }[]; charges: { model: string; power: number; status: string }[] };
export function FeatureBuilder({ api, values, onChange, disabled }: { api: typeof Api; values: OfficialFeatureValues; onChange: (v: OfficialFeatureValues) => void; disabled: boolean }) {
  const [options, setOptions] = useState<Options>({ models: [], tools: [], allowedEndpoints: [] }), [error, setError] = useState("");
  const [document, setDocument] = useState(""), [operationId, setOperationId] = useState("");
  useEffect(() => { let active = true; void api<Options>("/api/admin/official-features/options").then(v => { if (active) setOptions(v); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [api]);
  const tools = values.tools ?? [];
  return <fieldset disabled={disabled}><legend>模型与能力</legend>
    <SearchPicker label="模型" value={values.modelId ?? ""} options={options.models.map(m => ({ value: m.id, label: m.name }))} onChange={modelId => onChange({ ...values, modelId })}/>
    <p>使用者自己的知识</p><div className="settings-tabs">{([['none','不使用'],['optional','按需选择'],['required','必须选择']] as const).map(([mode,label])=><button type="button" key={mode} aria-pressed={(values.knowledgeMode??'none')===mode} onClick={()=>onChange({...values,knowledgeMode:mode})}>{label}</button>)}</div>
    <p className="hint">只声明能力，使用时由每位用户选择自己的来源，不共享管理员知识。后台试运行可验证外部工具；知识流程请上架给自己的账号后验证。</p>
    <p className="hint">按需添加工具。不添加工具时，按提示词回答。</p>
    {options.tools.map(tool => <label key={tool.id} className="sharing-check"><input type="checkbox" checked={tools.some(t => t.id === tool.id)} onChange={e => onChange({ ...values, tools: e.target.checked ? [...tools, { id: tool.id, description: tool.description }] : tools.filter(t => t.id !== tool.id) })}/>{tool.name}</label>)}
    {tools.map((tool, i) => <details key={tool.id} open><summary>{options.tools.find(t => t.id === tool.id)?.name ?? tool.id}</summary><label>什么时候调用、参数怎么填<textarea rows={3} maxLength={2000} value={tool.description} onChange={e => onChange({ ...values, tools: tools.map((t, n) => n === i ? { ...t, description: e.target.value } : t) })}/></label>{tool.document !== undefined ? <button type="button" onClick={() => onChange({ ...values, tools: tools.filter((_, n) => n !== i) })}>移除工具</button> : null}</details>)}
    {tools.map((tool,i)=><div key={`auth-${tool.id}`}><p>{tool.id} · 接口鉴权</p><ToolAuthPicker value={tool.auth} onChange={auth=>onChange({...values,tools:tools.map((t,n)=>n===i?{...t,auth}:t)})}/>{tool.mcp&&tool.auth?<ToolCredentialEditor api={api} endpoint={tool.mcp.endpoint} auth={tool.auth}/>:null}{tool.mcp?<button type="button" onClick={()=>onChange({...values,tools:tools.filter((_,n)=>n!==i)})}>移除 MCP 工具</button>:null}</div>)}
    <McpToolPicker api={api} endpoints={options.mcpEndpoints??[]} tools={tools} onAdd={tool=>onChange({...values,tools:[...tools,tool]})}/>
    <details><summary>添加 HTTP / OpenAPI 工具</summary><p className="hint">仅支持已审核地址的只读 GET 接口。定义中不要粘贴密钥；接口凭证独立加密保存。写入和 OAuth 暂未开放。</p>
      <details><summary>当前可用地址与本人凭证</summary>{options.allowedEndpoints.map(url => <details key={url}><summary style={{overflowWrap:'anywhere'}}>{url}</summary><ToolCredentialEditor api={api} endpoint={url} auth="bearer"/><ToolCredentialEditor api={api} endpoint={url} auth="api_key"/></details>)}</details>
      <label>接口定义（OpenAPI JSON）<textarea rows={6} value={document} maxLength={40000} onChange={e => setDocument(e.target.value)}/></label>
      <label>操作标识 operationId<input value={operationId} maxLength={64} onChange={e => setOperationId(e.target.value)}/></label>
      <button type="button" disabled={tools.length >= 6} onClick={() => { try { const parsed = JSON.parse(document); if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(operationId) || tools.some(t => t.id === operationId)) throw new Error("操作标识无效或重复"); onChange({ ...values, tools: [...tools, { id: operationId, operationId, document: parsed, description: "请填写该工具适用任务和参数规则" }] }); setDocument(""); setOperationId(""); setError(""); } catch (e) { setError(e instanceof Error ? e.message : "接口定义无效"); } }}>添加到智能体</button>
    </details>{error ? <p role="alert">{error}</p> : null}
  </fieldset>;
}
export function FeatureTrial({ api, id, revision, disabled }: { api: typeof Api; id: string; revision: number; disabled: boolean }) {
  const [prompt, setPrompt] = useState(""), [budget, setBudget] = useState("0.5"), [busy, setBusy] = useState(false), [error, setError] = useState(""), [result, setResult] = useState<Result>(), [operationId, setOperationId] = useState("");
  async function execute(recover = false) {
    if (!recover && !confirm(`试运行会从你的账户扣除实际模型用量，本次上限 ${budget} 电力。继续？`)) return;
    setBusy(true); setError(""); if (!recover) setResult(undefined);
    const key = recover ? operationId : crypto.randomUUID(); setOperationId(key);
    try { setResult(await api<Result>(`/api/admin/official-features/${id}/trial${recover ? `/${key}` : ""}`, recover ? {} : { method: "POST", body: JSON.stringify({ revision, operationId: key, prompt, budget: Number(budget), confirmed: true }) })); }
    catch (e) { setError(e instanceof Error ? e.message : "试运行失败"); } finally { setBusy(false); }
  }
  return <details><summary>试运行智能体</summary><div className="sharing-form">
    <label>测试任务<textarea rows={3} maxLength={4000} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="例如：会议室能预约多久？白板笔还有多少？"/></label>
    <label>本次电力上限<input type="number" min="0.001" max="10" step="0.001" value={budget} onChange={e => setBudget(e.target.value)}/></label>
    <p className="hint">只用已保存配置。试运行按实际模型用量计费，不会自动发布。</p>
    <button type="button" className="primary" disabled={busy || disabled || !prompt.trim()} onClick={() => void execute()}>{busy ? "执行中…" : "试运行"}</button>
    {operationId ? <button type="button" disabled={busy} onClick={() => void execute(true)}>查看本次结果（不重新执行）</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result ? <><article><h4>回答</h4><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{result.content}</p>{result.finishReason === "length" ? <p>达到回答长度上限，内容未完成。</p> : null}</article>
      <details><summary>工具调用 · {result.trace.length} 次</summary>{result.trace.map((step, i) => <details key={i}><summary>{step.tool} · {step.status === "returned" ? "已返回" : step.status === "reused" ? "复用结果" : step.status === "failed" ? "执行失败" : "已拒绝"} · {step.durationMs} ms</summary><p>输入</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{step.query}</pre><p>返回</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{step.resultPreview}</pre></details>)}</details>
      <details><summary>用量 · {result.charges.reduce((sum, c) => sum + c.power, 0).toFixed(6)} 电力</summary>{result.charges.map((c, i) => <p key={i}>{c.model} · {c.power.toFixed(6)} 电力 · {c.status === "success" ? "已结算" : "请查看账单状态"}</p>)}</details></> : null}
  </div></details>;
}
