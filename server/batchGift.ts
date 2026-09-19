import type { Database } from "./types.js";
import { creditPower, powerAccount } from "./powerBilling.js";
import { uid } from "./security.js";

// Called inside Store.mutate: balances, individual receipts and batch audit commit together.
export function batchGift(db: Database, actorUserId: string, operationId: string, amountMicros: number, title: string) {
  if (!db.users.some(u => u.id === actorUserId && u.enabled && u.role === "admin")) throw new Error("仅超管可以赠送");
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(operationId)) throw new Error("赠送操作编号无效");
  if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0 || amountMicros > 1e12) throw new Error("赠送金额无效");
  const batchId = `gift-${actorUserId}-${operationId}`;
  const existing = db.auditLogs.find(a => a.action === "admin.power.batch_gifted" && a.targetId === batchId);
  if (existing) {
    if (existing.details?.amountMicros !== amountMicros || existing.details?.title !== title) throw new Error("重试参数与原赠送不一致");
    return { batchId, recipientCount: Number(existing.details.recipientCount), amountMicros };
  }
  const recipients = db.users.filter(u => u.enabled && db.workspaces.some(w => w.id === u.defaultWorkspaceId && w.status === "active")
    && db.workspaceMembers.some(m => m.userId === u.id && m.workspaceId === u.defaultWorkspaceId));
  if (!recipients.length) throw new Error("没有可赠送的启用成员");
  if (!Number.isSafeInteger(amountMicros * recipients.length)) throw new Error("批次总额过大");
  for (const user of recipients) {
    const account = powerAccount(db, user.defaultWorkspaceId, user.id);
    if (!account || !Number.isSafeInteger(account.balanceMicros + amountMicros)) throw new Error("成员电力账户异常，未发放");
  }
  for (const user of recipients) creditPower(db, { workspaceId: user.defaultWorkspaceId, userId: user.id, amountMicros,
    type: "gift", title, batchId, createdByUserId: actorUserId });
  db.auditLogs.push({ id: uid("aud"), actorUserId, action: "admin.power.batch_gifted", targetType: "power_gift_batch", targetId: batchId,
    details: { amountMicros, title, recipientCount: recipients.length, totalMicros: amountMicros * recipients.length }, createdAt: new Date().toISOString() });
  return { batchId, recipientCount: recipients.length, amountMicros };
}
