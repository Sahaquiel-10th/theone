import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Search, X } from "lucide-react";
export function SettingsDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); dialog.querySelector<HTMLInputElement>('input[type="search"]')?.focus(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="one-settings-dialog" aria-labelledby={titleId} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}>
    <header><h2 id={titleId}>{title}</h2><button type="button" aria-label="关闭" className="settings-icon-button" onClick={onClose}><X size={20} /></button></header><div className="settings-dialog-body">{children}</div>
  </dialog>;
}
export function SearchPicker({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string; hint?: string }[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [page, setPage] = useState(1);
  const selected = options.find(o => o.value === value);
  const filtered = options.filter(o => `${o.label} ${o.hint || ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const pages = Math.max(1, Math.ceil(filtered.length / 8)), current = Math.min(page, pages);
  return <div className="settings-picker"><button type="button" className="settings-picker-trigger" aria-label={`${label}：${selected?.label || "请选择"}`} onClick={() => { setQuery(""); setPage(1); setOpen(true); }}><span>{selected?.label || `选择${label}`}</span><ChevronRight size={16} /></button>
    {open ? <SettingsDialog title={`选择${label}`} onClose={() => setOpen(false)}><div className="settings-search"><Search size={17} /><input autoFocus type="search" aria-label={`搜索${label}`} placeholder={`搜索${label}`} value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} /></div><div className="settings-choice-list">{filtered.slice((current - 1) * 8, current * 8).map(o => <button type="button" key={o.value} aria-pressed={o.value === value} onClick={() => { onChange(o.value); setOpen(false); }}><span><strong>{o.label}</strong>{o.hint ? <small>{o.hint}</small> : null}</span>{o.value === value ? <Check size={18} /> : null}</button>)}{!filtered.length ? <p className="settings-empty">没有匹配结果，换个关键词试试</p> : null}</div><div className="settings-pagination"><button type="button" disabled={current <= 1} onClick={() => setPage(current - 1)}>上一页</button><span>{current} / {pages} · {filtered.length} 项</span><button type="button" disabled={current >= pages} onClick={() => setPage(current + 1)}>下一页</button></div></SettingsDialog> : null}
  </div>;
}
