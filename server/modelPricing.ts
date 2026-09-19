import type { Database, ModelConfig } from "./types.js";
import { uid } from "./security.js";
export function effectiveModel(model: ModelConfig, at = Date.now()): ModelConfig {
  const due = model.pricingHistory?.filter(row => !row.cancelledAt && Date.parse(row.pricing.effectiveAt || row.pricing.publishedAt) <= at)
    .sort((a, b) => b.pricing.version - a.pricing.version)[0];
  if (due) model = { ...model, pricing: due.pricing, costInputPowerPerMillion: due.costInput, costOutputPowerPerMillion: due.costOutput };
  if (!model.pricing || model.kind !== "chat") return structuredClone(model);
  return { ...structuredClone(model), inputPowerPerMillion: model.pricing.referenceInput * model.pricing.multiplier,
    outputPowerPerMillion: model.pricing.referenceOutput * model.pricing.multiplier };
}
export function publishPricing(db: Database, modelId: string, actorUserId: string, body: Record<string, unknown>) {
  if (!db.users.some(u => u.id === actorUserId && u.enabled && u.role === "admin")) throw new Error("仅超管可发布价格");
  const model = db.models.find(m => m.id === modelId); if (!model || model.kind !== "chat") throw new Error("请选择聊天模型");
  const read = (field: string, min: number) => { const value = body[field]; if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > 1e6) throw new Error("价格无效"); return value; };
  const multiplier = read("multiplier", 0.001); if (multiplier > 100) throw new Error("倍率不能超过 100");
  const referenceInput = read("referenceInput", 0), referenceOutput = read("referenceOutput", 0);
  const costInput = read("costInput", 0), costOutput = read("costOutput", 0);
  const publishedAt = new Date().toISOString();
  const effectiveAt = body.effectiveAt ? String(body.effectiveAt) : publishedAt;
  if (!Number.isFinite(Date.parse(effectiveAt)) || Date.parse(effectiveAt) < Date.parse(publishedAt) - 60000) throw new Error("生效时间不能早于当前时间");
  const explanation = typeof body.explanation === "string" ? body.explanation.trim() : "";
  if (explanation.length > 1000 || (body.explanation !== undefined && !explanation)) throw new Error("请填写 1 至 1000 字的调价说明");
  if (model.pricingHistory?.some(row => !row.cancelledAt && Date.parse(row.pricing.effectiveAt || row.pricing.publishedAt) > Date.now())) throw new Error("请先撤回尚未生效的调价，再发布新价格");
  const pricing = { version: Math.max(model.pricing?.version ?? 0, ...(model.pricingHistory || []).map(row => row.pricing.version)) + 1, multiplier, referenceInput, referenceOutput,
    label: multiplier < 1 ? "优惠期" : multiplier > 1 ? `含 ${Number(((multiplier - 1) * 100).toFixed(2))}% 服务费` : "标准价格", publishedAt, effectiveAt: new Date(effectiveAt).toISOString(), explanation: explanation || "模型计费价格更新" };
  db.auditLogs.push({ id: uid("aud"), actorUserId, action: "admin.pricing.published", targetType: "model", targetId: model.id,
    details: { previous: model.pricing ?? null, pricing, previousCostInput: model.costInputPowerPerMillion, previousCostOutput: model.costOutputPowerPerMillion, costInput, costOutput }, createdAt: publishedAt });
  if (!model.pricingHistory?.length) model.pricingHistory = [{ pricing: model.pricing || { version: 0, label: "原价格", multiplier: 1, referenceInput: model.inputPowerPerMillion, referenceOutput: model.outputPowerPerMillion, publishedAt: "1970-01-01T00:00:00.000Z" }, costInput: model.costInputPowerPerMillion, costOutput: model.costOutputPowerPerMillion }];
  model.pricingHistory.push({ pricing, costInput, costOutput });
  const active = effectiveModel(model);
  model.pricing = active.pricing; model.inputPowerPerMillion = active.inputPowerPerMillion; model.outputPowerPerMillion = active.outputPowerPerMillion;
  model.costInputPowerPerMillion = active.costInputPowerPerMillion; model.costOutputPowerPerMillion = active.costOutputPowerPerMillion;
  return pricing;
}

export function cancelScheduledPricing(db: Database, modelId: string, actorUserId: string) {
  if (!db.users.some(u => u.id === actorUserId && u.enabled && u.role === "admin")) throw new Error("仅超管可撤回价格");
  const row = db.models.find(m => m.id === modelId)?.pricingHistory?.find(r => !r.cancelledAt && Date.parse(r.pricing.effectiveAt || r.pricing.publishedAt) > Date.now());
  if (!row) throw new Error("没有待生效的调价");
  row.cancelledAt = new Date().toISOString();
  db.auditLogs.push({ id: uid("aud"), actorUserId, action: "admin.pricing.cancelled", targetType: "model", targetId: modelId, details: { version: row.pricing.version }, createdAt: row.cancelledAt });
}

// Explicit public projection: never expose supplier prices or credentials with notices.
export function publicPrices(models: ModelConfig[], at = Date.now()) {
  return models.filter(m => m.enabled && m.apiKey).map(raw => {
    const m = effectiveModel(raw, at);
    return { id: m.id, name: m.name, pricing: m.pricing, input: m.inputPowerPerMillion, output: m.outputPowerPerMillion, image: m.imagePowerPerCall,
      notices: (raw.pricingHistory || []).filter(r => r.pricing.version > 0).map(r => {
        const previous = raw.pricingHistory?.filter(p => !p.cancelledAt && p.pricing.version < r.pricing.version).sort((a, b) => b.pricing.version - a.pricing.version)[0]?.pricing;
        return { ...r.pricing, previousInput: previous ? previous.referenceInput * previous.multiplier : undefined, previousOutput: previous ? previous.referenceOutput * previous.multiplier : undefined, cancelledAt: r.cancelledAt, status: r.cancelledAt ? "cancelled" : Date.parse(r.pricing.effectiveAt || r.pricing.publishedAt) > at ? "scheduled" : r.pricing.version === m.pricing?.version ? "active" : "past" };
      }).reverse() };
  });
}
