import { useState } from "react";
import {createPortal} from 'react-dom';
import { ChevronRight } from "lucide-react";
import { SettingsDialog } from "./SettingsControls";

export function matchesKnowledgeCard(label: string, id: string, connected: boolean, query = "", filter = "all") {
  return `${label} ${id}`.toLowerCase().includes(query.trim().toLowerCase()) && (filter === "all" || (filter === "connected" ? connected : !connected));
}

export function EnterpriseConnectionNotice() {
  return <section className="enterprise-connection-notice"><h3>需要企业管理员开通</h3><p>请让企业管理员联系我们</p><img src="/enterprise-contact-qr.png" alt="联系 ONE 的微信二维码" width={240} height={237} /><p className="hint">扫码联系，确认企业授权与可接入范围后开通。</p></section>;
}

export type KnowledgeCardDetailControl={open?:boolean;onOpenChange?:(open:boolean,source?:HTMLButtonElement)=>void;detailTarget?:HTMLElement|null};
export function EnterpriseKnowledgeCard({ id, label, query, filter,open:controlledOpen,onOpenChange,detailTarget }: { id: "dingtalk" | "wechat"; label: string; query: string; filter: string }&KnowledgeCardDetailControl) {
  const [localOpen, setLocalOpen] = useState(false),open=controlledOpen??localOpen;
  function changeOpen(next:boolean,source?:HTMLButtonElement){if(controlledOpen===undefined)setLocalOpen(next);onOpenChange?.(next,source);}
  const card=matchesKnowledgeCard(label,id,false,query,filter)?<button type="button" className={`knowledge-source-card${open?' is-selected':''}`} aria-expanded={open} onClick={event=>changeOpen(true,event.currentTarget)}><span className={`knowledge-source-mark ${id}`}>{label.slice(0,1)}</span><span><strong>{label}</strong><small>企业接入 · 管理员开通</small></span><span className="knowledge-source-status">需管理员开通<ChevronRight size={14}/></span></button>:null;
  // A supplied host belongs to the persistent split pane. Keep its content
  // mounted through closing so it merges instead of becoming an empty shell.
  return <>{card}{detailTarget!==undefined?detailTarget?createPortal(<EnterpriseConnectionNotice/>,detailTarget):null:open&&card?<SettingsDialog title={label} onClose={()=>changeOpen(false)}><EnterpriseConnectionNotice/></SettingsDialog>:null}</>;
}

export function FlomoConnectionNotice() {
  return <p className="notice" role="note">需要 flomo MAX 会员，免费版和 PRO 暂不支持。授权后 ONE 仅按需搜索和读取笔记，不会修改或删除笔记。</p>;
}
