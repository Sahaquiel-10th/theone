import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { SettingsDialog } from "./SettingsControls";

export function matchesKnowledgeCard(label: string, id: string, connected: boolean, query = "", filter = "all") {
  return `${label} ${id}`.toLowerCase().includes(query.trim().toLowerCase()) && (filter === "all" || (filter === "connected" ? connected : !connected));
}

export function EnterpriseConnectionNotice() {
  return <section className="enterprise-connection-notice"><h3>需要企业管理员开通</h3><p>请让企业管理员联系我们</p><img src="/enterprise-contact-qr.png" alt="联系 ONE 的微信二维码" width={240} height={237} /><p className="hint">扫码联系，确认企业授权与可接入范围后开通。</p></section>;
}

export function EnterpriseKnowledgeCard({ id, label, query, filter }: { id: "dingtalk" | "wechat"; label: string; query: string; filter: string }) {
  const [open, setOpen] = useState(false);
  if (!matchesKnowledgeCard(label, id, false, query, filter)) return null;
  return <><button type="button" className="knowledge-source-card" onClick={() => setOpen(true)}><span className={`knowledge-source-mark ${id}`}>{label.slice(0, 1)}</span><span><strong>{label}</strong><small>企业接入 · 管理员开通</small></span><span className="knowledge-source-status">需管理员开通<ChevronRight size={14} /></span></button>{open ? <SettingsDialog title={label} onClose={() => setOpen(false)}><EnterpriseConnectionNotice /></SettingsDialog> : null}</>;
}

export function FlomoConnectionNotice() {
  return <p className="notice" role="note">需要 flomo MAX 会员，免费版和 PRO 暂不支持。授权后 ONE 仅按需搜索和读取笔记，不会修改或删除笔记。</p>;
}
