export type PowerUsage = {
  inputTokens?: number; outputTokens?: number; chargedMicros?: number; status?: string; source?: string;
  inputPowerPerMillionSnapshot?: number; outputPowerPerMillionSnapshot?: number;
  imagePowerPerCallSnapshot?: number;
  cacheUsage?: { read: number; write: number; write5m: number; write1h: number };
  cachePricesSnapshot?: { read: number; write: number; write1h: number };
};
export const powerText = (micros: number) => (micros / 1e6).toLocaleString("zh-CN", { maximumFractionDigits: 6 });
// Snapshot prices include the retail multiplier. Round once, as in settlement.
export function usagePower(row: PowerUsage) {
  if (row.source === "fixed" || row.imagePowerPerCallSnapshot !== undefined || row.source === "unknown" || ["pending", "needs_review", "waived", "failed"].includes(row.status || "")) return null;
  const c = row.cacheUsage, p = row.cachePricesSnapshot;
  if (row.inputPowerPerMillionSnapshot === undefined || row.outputPowerPerMillionSnapshot === undefined || (c && c.read + c.write > 0 && !p)) return null;
  const raw = [(row.inputTokens || 0) * row.inputPowerPerMillionSnapshot,
    (row.outputTokens || 0) * row.outputPowerPerMillionSnapshot,
    (c?.read || 0) * (p?.read || 0), ((c?.write || 0) - (c?.write1h || 0)) * (p?.write || 0),
    (c?.write1h || 0) * (p?.write1h || 0)];
  if (raw.some(n => !Number.isFinite(n) || n < 0)) return null;
  const total = Math.ceil(raw.reduce((a, b) => a + b, 0) - 1e-7);
  const parts = raw.map(Math.floor);
  const order = raw.map((n, i) => ({ i, fraction: n - parts[i] })).sort((a, b) => b.fraction - a.fraction);
  for (let i = 0, remaining = total - parts.reduce((a, b) => a + b, 0); i < remaining; i++) parts[order[i].i]++;
  return { ordinary: parts[0], output: parts[1], read: parts[2], write: parts[3], write1h: parts[4],
    input: parts[0] + parts[2] + parts[3] + parts[4], total, adjustment: (row.chargedMicros ?? total) - total };
}
