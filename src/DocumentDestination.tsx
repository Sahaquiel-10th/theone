import { useEffect, useRef, useState } from 'react';
import {confirmAction} from './ConfirmAction';
import { Check, ChevronDown, ChevronRight, FileText, Folder, MessageCircle, Settings2 } from 'lucide-react';
import type { api as Api } from './oneApi';
import './document-destination.css';
import {parseNotionPageLink} from './notionPageLink';
import {notionVerificationPresentation,type NotionReceiptView} from './taskRecovery';
import {useLocalDeviceReadiness} from './useLocalDeviceReadiness';
import {localReadinessStatus} from './localDeviceReadiness';
export type DocumentDestination = 'chat' | 'local' | 'notion';
export function NotionReceiptNotice({ api, taskId, receipt, reviewWorkflow=false, onRefresh }: { api: typeof Api; taskId: string; receipt?: NotionReceiptView; reviewWorkflow?:boolean; onRefresh: () => Promise<unknown> }) {
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{setNotice('');},[taskId,receipt?.state,receipt?.verification?.version]);
  if (!receipt || receipt.state === 'verified'&&!reviewWorkflow) return null;
  const status=notionVerificationPresentation(receipt,reviewWorkflow);
  return <section className="notion-writing-settings" aria-label="Notion 保存进展" aria-busy={status.active||busy}><p role="status">{status.message}</p>{receipt.url ? <a href={receipt.url} target="_blank" rel="noreferrer">打开原页面核对 ↗</a> : !status.active?<p>暂未取得页面入口，请在 Notion 检查原保存位置。</p>:null}
    {status.canVerify ? <button type="button" disabled={busy} onClick={async()=>{setBusy(true);setNotice('');try{const result=await api<{state?:string}>(`/api/coordinator/tasks/${encodeURIComponent(taskId)}/notion/verify`,{method:'POST'});setNotice(result.state==='verified'?'刚才的 Notion 保存已回读核对，没有重写；这件事其余部分的进展会单独告诉你。':'正在只读核对保存结果，不会重新写入；确认后会在这里更新。');await onRefresh();}catch(e){setNotice(e instanceof Error?e.message:'暂未确认，没有重发保存请求');}finally{setBusy(false);}}}>{busy?'正在回读核对…':reviewWorkflow?'核对任务进度（不重写）':'核对保存结果（不重写）'}</button> : null}
    {notice ? <p role="status">{notice}</p> : null}</section>;
}
type WritingSettings = { connected: boolean; writeAuthorized: boolean; ready: boolean; parentId: string; referenceIds: string[] };
const url = (id: string) => id ? `https://www.notion.so/${id}` : '';

export function DocumentDestinationPicker({ api, value, onChange, localDisabled, localDisabledHint, onSettings, onLocalSettings }: {
  api: typeof Api; value: DocumentDestination; onChange: (value: DocumentDestination) => void; localDisabled: boolean; localDisabledHint?:string; onSettings: () => void; onLocalSettings?:()=>void;
}) {
  const [writing, setWriting] = useState<WritingSettings>(), [checking, setChecking] = useState(true);
  const local=useLocalDeviceReadiness(api),localReady=local.canRequestExecution;
  const localStatus=localReadinessStatus(local.value,local.status==='checking'||local.status==='idle',local.error);
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(true);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!container.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [n] = await Promise.allSettled([api<WritingSettings>('/api/knowledge/connections/notion/writing')]);
      if (!alive) return;
      setWriting(n.status === 'fulfilled' ? n.value : undefined);
      setChecking(false);
    };
    void load(); window.addEventListener('focus', load); window.addEventListener('one-writing-settings', load);
    return () => { alive = false; window.removeEventListener('focus', load); window.removeEventListener('one-writing-settings', load); };
  }, [api]);
  const invalid = value === 'notion' ? !writing?.ready : value === 'local' ? !localReady || localDisabled : false;
  const options = [
    { id: 'chat' as const, label: '对话中', description: '在这里回复，不保存为文档', Icon: MessageCircle, disabled: false },
    { id: 'local' as const, label: '本地文件', description: localDisabled&&localDisabledHint ? localDisabledHint : !localReady ? localStatus.description : localDisabled ? '本机执行暂不可用' : local.value?.folder.state==='unselected' ? '第一次处理本地文件时，再选择工作文件夹' : '保存到已授权的文件夹', Icon: Folder, disabled: !localReady || localDisabled },
    ...(writing?.connected ? [{ id: 'notion' as const, label: 'Notion', description: !writing.writeAuthorized ? '需开启草稿写入' : !writing.ready ? '先选一次保存位置' : '新建草稿，续改同一篇', Icon: FileText, disabled: !writing.ready }] : []),
  ];
  const selected = options.find(option => option.id === value);
  const SelectedIcon = selected?.Icon || MessageCircle;
  return <div className="document-destination" ref={container}>
    <button ref={trigger} className={`destination-trigger ${value !== 'chat' ? 'is-selected' : ''}`} type="button" aria-label={`输出位置：${selected?.label || 'Notion'}`} aria-expanded={open} onClick={() => { setAbove((trigger.current?.getBoundingClientRect().top || 0) > 300); setOpen(previous => !previous); }}>
      <SelectedIcon size={14} aria-hidden="true" /><span>{selected?.label || 'Notion'}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {(value==='local'||!checking) && invalid ? <span className="destination-warning" role="status">{value==='local'?(localDisabled&&localDisabledHint?localDisabledHint:localStatus.description):'保存位置不可用，请重新选择'}</span> : null}
    {open ? <div className={`destination-menu ${above ? '' : 'opens-below'}`} aria-label="选择输出位置">
      <p className="destination-menu-title">这条消息的结果放在哪里？</p>
      {options.map(({ id, label, description, Icon, disabled }) => <button type="button" className="destination-option" key={id} disabled={disabled} aria-pressed={value === id} onClick={() => { onChange(id); setOpen(false); trigger.current?.focus(); }}>
        <Icon size={17} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span>{value === id ? <Check size={15} aria-hidden="true" /> : null}
      </button>)}
      {(!localReady||localDisabled)&&onLocalSettings?<button type="button" className="destination-settings" onClick={()=>{setOpen(false);trigger.current?.focus();onLocalSettings();}}><Folder size={14} aria-hidden="true"/><span>检查本机设置</span><ChevronRight size={13} aria-hidden="true"/></button>:null}
      <button type="button" className="destination-settings" onClick={() => { setOpen(false); trigger.current?.focus(); onSettings(); }}><Settings2 size={14} aria-hidden="true" /><span>{writing?.connected && !writing.ready ? '设置 Notion 保存位置' : '管理连接与保存位置'}</span><ChevronRight size={13} aria-hidden="true" /></button>
    </div> : null}
  </div>;
}

export function NotionWritingSettings({ api }: { api: typeof Api }) {
  const [settings, setSettings] = useState<WritingSettings>(), [parent, setParent] = useState(''), [refs, setRefs] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => { let alive = true; void api<WritingSettings>('/api/knowledge/connections/notion/writing').then(s => { if (alive) { setSettings(s); setParent(url(s.parentId)); setRefs(s.referenceIds.map(url).join('\n')); } }).catch(() => { if (alive) setNotice('写入设置暂未加载，请重新打开'); }); return () => { alive = false; }; }, [api]);
  async function authorize() {
    if (!await confirmAction({title:'为 Notion 补充写作权限？',message:'接下来会打开 Notion 重新授权。',details:['新增：在你选择的页面下创建草稿，修订由 ONE 创建并绑定到任务的草稿。','不会自动修改其他页面，也不调用 Notion AI。'],confirmLabel:'前往重新授权'})) return;
    setBusy(true); setNotice('');
    try { const r = await api<{ authorizationUrl: string }>('/api/knowledge/connections/notion/oauth/start', { method: 'POST', body: JSON.stringify({ enableWriting: true, confirmed: true }) }); window.location.assign(r.authorizationUrl); }
    catch (e) { setNotice(e instanceof Error ? e.message : '无法打开授权'); setBusy(false); }
  }
  async function save() {
    const parsed=parseNotionPageLink(parent);
    if(parsed.error){setNotice(parsed.error);return;}
    const references=refs.split('\n').map(s=>s.trim()).filter(Boolean);
    if(references.length>5){setNotice('参考文章最多放五篇就好。');return;}
    for(const [index,reference] of references.entries()){
      const parsedReference=parseNotionPageLink(reference);
      if(parsedReference.error){setNotice(`第 ${index+1} 篇参考文章：${parsedReference.error}`);return;}
    }
    setBusy(true); setNotice('正在核对页面访问权限…');
    try {
      const next = await api<WritingSettings>('/api/knowledge/connections/notion/writing', { method: 'PUT', body: JSON.stringify({ parent, references }) });
      setSettings(next); setNotice('保存位置已设置，可以在输入框选择 Notion。'); window.dispatchEvent(new Event('one-writing-settings'));
    } catch (e) { setNotice(e instanceof Error ? e.message : '保存未完成'); }
    finally { setBusy(false); }
  }
  return <section className="notion-writing-settings" aria-label="Notion 写入设置"><header className="notion-writing-heading"><div><h4>保存到 Notion</h4></div>{settings?.writeAuthorized ? <span className="notion-writing-badge"><Check size={12} />已授权</span> : null}</header>
    {!settings ? <p>{notice || '正在读取设置…'}</p> : !settings.writeAuthorized ? <><p>当前可读取知识。开启写入后，ONE 还能创建文章并继续修改自己的草稿。</p><button type="button" className="primary notion-writing-save" disabled={busy} onClick={() => void authorize()}>{busy ? '正在打开授权…' : '开启草稿写入'}<ChevronRight size={14} /></button></> : <>
      <label>保存位置<input aria-label="Notion 草稿保存页面" type="text" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={parent} onChange={e => {setParent(e.target.value);setNotice('');}} placeholder="粘贴 Notion 页面里的“复制链接”" disabled={busy} aria-describedby="notion-parent-help" /><small id="notion-parent-help">粘贴已授权页面的链接，草稿会保存在该页面下。</small>{parent.trim()&&!parseNotionPageLink(parent).error?<small>链接格式已识别，点下方按钮核对访问权限。</small>:null}</label>
      <details className="notion-link-help"><summary>如何获取页面链接</summary><p>打开想放草稿的普通页面，点击右上角“分享”→“复制链接”。不用发布或公开页面；保存位置会保留。</p></details>
      <details className="notion-reference-settings"><summary>参考我的文章风格{refs.trim() ? <span>已设置</span> : <span>可选</span>}</summary><label>参考文章<textarea aria-label="Notion 参考文章" placeholder="每行粘贴一篇文章链接，最多五篇" rows={3} value={refs} onChange={e => setRefs(e.target.value)} disabled={busy} /><small>写作时参考所选文章。</small></label></details>
      <button type="button" className="primary notion-writing-save" disabled={busy || !parent.trim()} onClick={() => void save()}>{busy ? '正在核对…' : settings.ready ? '保存修改' : '确认保存位置'}</button>
      <details className="notion-permission-details"><summary>权限与费用说明</summary><p>由 ONE 写作，使用 ONE 额度，不调用 Notion AI。只修订该任务绑定的草稿，不删除或移动页面，不修改数据库。</p><p>改变授权或保存位置后，旧任务会暂停。你在 Notion 手工修改过的内容，写入前会重新核对。</p></details>
    </>}
    {settings && notice ? <p role="status">{notice}</p> : null}
  </section>;
}
