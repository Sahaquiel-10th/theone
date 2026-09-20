import { useEffect, useState } from "react";
import type { api as apiType } from "./oneApi";
import { SettingsDialog } from "./SettingsControls";
import { Bell } from "lucide-react";
type Notice = { model: string; version: number; label: string; explanation: string; effectiveAt: string; publishedAt: string; multiplier: number; referenceInput: number; referenceOutput: number; referenceCache?: { read: number; write: number; write1h: number }; status: string; previousInput?: number; previousOutput?: number };
const time = (date: string) => new Date(date).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
export function PriceNotices({ api, userId }: { api: typeof apiType; userId: string }) {
  const [items, setItems] = useState<Notice[]>([]), [open, setOpen] = useState(false), [page, setPage] = useState(1);
  const key = `one-price-notices:${userId}`;
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(key) || ""; } catch { return ""; } });
  useEffect(() => { const abort = new AbortController(); const load = () => api<{ prices: { name: string; notices?: Omit<Notice, "model">[] }[] }>("/api/pricing", { signal: abort.signal }).then(r => setItems(r.prices.flatMap(m => (m.notices || []).map(n => ({ ...n, model: m.name }))).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)))).catch(() => {}); void load(); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 60000); return () => { abort.abort(); window.clearInterval(timer); }; }, [api]);
  if (!items.length) return null;
  const signature = JSON.stringify(items.map(n => [n.model, n.version, n.status, n.publishedAt, n.explanation]));
  const unread = seen !== signature;
  const read = () => { setOpen(true); setSeen(signature); try { localStorage.setItem(key, signature); } catch { /* Storage is optional. */ } };
  const status = (n: Notice) => n.status === "cancelled" ? "已撤回" : n.status === "scheduled" ? "即将生效" : n.status === "past" ? "历史价格" : "当前价格";
  return <><button type="button" className="price-notice-bell" aria-label={unread ? "价格通知，有新通知" : "价格通知"} onClick={read}><Bell size={18} />{unread ? <i /> : null}</button>{open ? <SettingsDialog title="价格通知" onClose={() => setOpen(false)}><div className="price-notice-history">{items.slice((page - 1) * 5, page * 5).map(n => <article key={`${n.model}-${n.version}`}><strong>{n.model} · {status(n)}</strong><p className="price-notice-message">{n.explanation}</p><p>本版输入 {(n.referenceInput * n.multiplier).toLocaleString("zh-CN", { maximumFractionDigits: 6 })} / 输出 {(n.referenceOutput * n.multiplier).toLocaleString("zh-CN", { maximumFractionDigits: 6 })} 电力 / 百万计量单位（已含费率调整）</p><small>{time(n.effectiveAt || n.publishedAt)} 生效（北京时间） · v{n.version}</small></article>)}</div><div className="settings-pagination"><button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button><span>{page} / {Math.ceil(items.length / 5)}</span><button type="button" disabled={page * 5 >= items.length} onClick={() => setPage(page + 1)}>下一页</button></div></SettingsDialog> : null}</>;
}
