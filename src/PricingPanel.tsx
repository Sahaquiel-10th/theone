import { useState } from "react";
import type { api as apiType } from "./oneApi";
export function PricingPanel({ api, model, reload }: { api: typeof apiType; model: { id: string; inputPowerPerMillion: number; outputPowerPerMillion: number; costInputPowerPerMillion: number; costOutputPowerPerMillion: number; pricing?: { referenceInput: number; referenceOutput: number; multiplier: number; version: number; label: string } }; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState({ referenceInput: model.pricing?.referenceInput ?? model.inputPowerPerMillion, referenceOutput: model.pricing?.referenceOutput ?? model.outputPowerPerMillion,
    multiplier: model.pricing?.multiplier ?? 1, costInput: model.costInputPowerPerMillion, costOutput: model.costOutputPowerPerMillion });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  async function publish() {
    if (!confirm(`发布新价格？新请求按 ×${draft.multiplier} 结算，历史账单保持原价。`)) return;
    setBusy(true); try { await api(`/api/admin/models/${model.id}/pricing`, { method: "POST", body: JSON.stringify(draft) }); setMessage("价格已发布"); await reload(); }
    catch (e) { setMessage(e instanceof Error ? e.message : "发布失败"); } finally { setBusy(false); }
  }
  return <details><summary>计费价格 · {model.pricing ? `${model.pricing.label} ×${model.pricing.multiplier} / v${model.pricing.version}` : "待配置官方参考价"}</summary>
    {(Object.keys(draft) as (keyof typeof draft)[]).map(key => <label key={key}>{({ referenceInput: "官方输入参考价", referenceOutput: "官方输出参考价", multiplier: "用户消费倍率", costInput: "供应商输入进价", costOutput: "供应商输出进价" })[key]}<input type="number" min={key === "multiplier" ? 0.001 : 0} step="0.000001" value={draft[key]} onChange={e => setDraft({ ...draft, [key]: Number(e.target.value) })} /></label>)}
    <p>单位：电力 / 百万 Token。新售价 {draft.referenceInput * draft.multiplier} / {draft.referenceOutput * draft.multiplier}</p>
    <button className="secondary" disabled={busy} onClick={() => void publish()}>发布价格</button>{message ? <p>{message}</p> : null}</details>;
}
