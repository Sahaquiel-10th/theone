import type { Database, ModelConfig } from "./types.js";
import { uid } from "./security.js";
export function effectiveModel(model: ModelConfig): ModelConfig {
  if (!model.pricing || model.kind !== "chat") return structuredClone(model);
  return { ...structuredClone(model), inputPowerPerMillion: model.pricing.referenceInput * model.pricing.multiplier,
    outputPowerPerMillion: model.pricing.referenceOutput * model.pricing.multiplier };
}
export function publishPricing(db: Database, modelId: string, actorUserId: string, body: Record<string, unknown>) {
  if (!db.users.some(u => u.id === actorUserId && u.enabled && u.role === "admin")) throw new Error("仅超管可发布价格");
  const model = db.models.find(m => m.id === modelId); if (!model || model.kind !== "chat") throw new Error("请选择聊天模型");
  const read = (field: string, min: number) => { const value = Number(body[field]); if (body[field] === "" || !Number.isFinite(value) || value < min || value > 1e6) throw new Error("价格无效"); return value; };
  const multiplier = read("multiplier", 0.001); if (multiplier > 100) throw new Error("倍率不能超过 100");
  const referenceInput = read("referenceInput", 0), referenceOutput = read("referenceOutput", 0);
  const costInput = read("costInput", 0), costOutput = read("costOutput", 0);
  const publishedAt = new Date().toISOString();
  const pricing = { version: (model.pricing?.version ?? 0) + 1, multiplier, referenceInput, referenceOutput,
    label: multiplier < 1 ? "优惠期" : multiplier > 1 ? `含 ${Number(((multiplier - 1) * 100).toFixed(2))}% 服务费` : "标准价格", publishedAt };
  db.auditLogs.push({ id: uid("aud"), actorUserId, action: "admin.pricing.published", targetType: "model", targetId: model.id,
    details: { previous: model.pricing ?? null, pricing, previousCostInput: model.costInputPowerPerMillion, previousCostOutput: model.costOutputPowerPerMillion, costInput, costOutput }, createdAt: publishedAt });
  model.pricing = pricing; model.inputPowerPerMillion = referenceInput * multiplier; model.outputPowerPerMillion = referenceOutput * multiplier;
  model.costInputPowerPerMillion = costInput; model.costOutputPowerPerMillion = costOutput;
  return pricing;
}
