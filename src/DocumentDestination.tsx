import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, FileText, Folder, MessageCircle, Settings2 } from 'lucide-react';
import type { api as Api } from './oneApi';
import './document-destination.css';
export type DocumentDestination = 'chat' | 'local' | 'notion';
export function NotionReceiptNotice({ api, taskId, receipt, onRefresh }: { api: typeof Api; taskId: string; receipt?: {state: string; url?: string; error?: string}; onRefresh: () => Promise<unknown> }) {
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  if (!receipt || receipt.state === 'verified') return null;
  return <section className="notion-writing-settings" aria-label="Notion 保存回执"><p>Notion 保存尚未确认，不会自动重复写入。</p>{receipt.url ? <a href={receipt.url} target="_blank" rel="noreferrer">打开原页面核对 ↗</a> : <p>暂未取得页面编号，请在 Notion 检查草稿目录。</p>}
    {receipt.url ? <button type="button" disabled={busy} onClick={async()=>{setBusy(true);setNotice('');try{await api(`/api/coordinator/tasks/${encodeURIComponent(taskId)}/notion/verify`,{method:'POST'});setNotice('已重新回读，保存内容一致。待办仍保持暂停，可确认处理最新要求。');await onRefresh();}catch(e){setNotice(e instanceof Error?e.message:'暂未确认，没有重发保存请求');}finally{setBusy(false);}}}>{busy?'正在回读核对…':'核对保存结果（不重写）'}</button> : null}
    {notice ? <p role="status">{notice}</p> : null}</section>;
}
type WritingSettings = { connected: boolean; writeAuthorized: boolean; ready: boolean; parentId: string; referenceIds: string[] };
const url = (id: string) => id ? `https://www.notion.so/${id}` : '';

export function DocumentDestinationPicker({ api, value, onChange, localDisabled, onSettings }: {
  api: typeof Api; value: DocumentDestination; onChange: (value: DocumentDestination) => void; localDisabled: boolean; onSettings: () => void;
}) {
  const [writing, setWriting] = useState<WritingSettings>(), [localReady, setLocalReady] = useState(false), [checking, setChecking] = useState(true);
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
      const [n, l] = await Promise.allSettled([api<WritingSettings>('/api/knowledge/connections/notion/writing'), api<{ installedVersion?: string; preparing?: boolean }>('/api/me/executor')]);
      if (!alive) return;
      setWriting(n.status === 'fulfilled' ? n.value : undefined);
      setLocalReady(l.status === 'fulfilled' && Boolean(l.value.installedVersion) && !l.value.preparing); setChecking(false);
    };
    void load(); window.addEventListener('focus', load); window.addEventListener('one-writing-settings', load);
    return () => { alive = false; window.removeEventListener('focus', load); window.removeEventListener('one-writing-settings', load); };
  }, [api]);
  const invalid = value === 'notion' ? !writing?.ready : value === 'local' ? !localReady || localDisabled : false;
  const options = [
    { id: 'chat' as const, label: '对话中', description: '在这里回复，不保存为文档', Icon: MessageCircle, disabled: false },
    { id: 'local' as const, label: '本地文件', description: !localReady ? '本机执行尚未就绪' : localDisabled ? '本机执行暂不可用' : '保存到已授权的文件夹', Icon: Folder, disabled: !localReady || localDisabled },
    ...(writing?.connected ? [{ id: 'notion' as const, label: 'Notion', description: !writing.writeAuthorized ? '需开启草稿写入' : !writing.ready ? '先选一次保存位置' : '新建草稿，续改同一篇', Icon: FileText, disabled: !writing.ready }] : []),
  ];
  const selected = options.find(option => option.id === value);
  const SelectedIcon = selected?.Icon || MessageCircle;
  return <div className="document-destination" ref={container}>
    <button ref={trigger} className={`destination-trigger ${value !== 'chat' ? 'is-selected' : ''}`} type="button" aria-label={`输出位置：${selected?.label || 'Notion'}`} aria-expanded={open} onClick={() => { setAbove((trigger.current?.getBoundingClientRect().top || 0) > 300); setOpen(previous => !previous); }}>
      <SelectedIcon size={14} aria-hidden="true" /><span>{selected?.label || 'Notion'}</span><ChevronDown size={12} aria-hidden="true" />
    </button>
    {!checking && invalid ? <span className="destination-warning" role="status">保存位置不可用，请重新选择</span> : null}
    {open ? <div className={`destination-menu ${above ? '' : 'opens-below'}`} aria-label="选择输出位置">
      <p className="destination-menu-title">这条消息的结果放在哪里？</p>
      {options.map(({ id, label, description, Icon, disabled }) => <button type="button" className="destination-option" key={id} disabled={disabled} aria-pressed={value === id} onClick={() => { onChange(id); setOpen(false); trigger.current?.focus(); }}>
        <Icon size={17} aria-hidden="true" /><span><strong>{label}</strong><small>{description}</small></span>{value === id ? <Check size={15} aria-hidden="true" /> : null}
      </button>)}
      <button type="button" className="destination-settings" onClick={() => { setOpen(false); onSettings(); }}><Settings2 size={14} aria-hidden="true" /><span>{writing?.connected && !writing.ready ? '设置 Notion 保存位置' : '管理连接与保存位置'}</span><ChevronRight size={13} aria-hidden="true" /></button>
    </div> : null}
  </div>;
}

export function NotionWritingSettings({ api }: { api: typeof Api }) {
  const [settings, setSettings] = useState<WritingSettings>(), [parent, setParent] = useState(''), [refs, setRefs] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  useEffect(() => { let alive = true; void api<WritingSettings>('/api/knowledge/connections/notion/writing').then(s => { if (alive) { setSettings(s); setParent(url(s.parentId)); setRefs(s.referenceIds.map(url).join('\n')); } }).catch(() => { if (alive) setNotice('写入设置暂未加载，请重新打开'); }); return () => { alive = false; }; }, [api]);
  async function authorize() {
    if (!window.confirm('新增权限：在你选择的页面下创建草稿，以及修订由 ONE 创建并绑定到任务的草稿。\n不会自动修改其他页面，也不调用 Notion AI。继续到 Notion 重新授权？')) return;
    setBusy(true); setNotice('');
    try { const r = await api<{ authorizationUrl: string }>('/api/knowledge/connections/notion/oauth/start', { method: 'POST', body: JSON.stringify({ enableWriting: true, confirmed: true }) }); window.location.assign(r.authorizationUrl); }
    catch (e) { setNotice(e instanceof Error ? e.message : '无法打开授权'); setBusy(false); }
  }
  async function save() {
    setBusy(true); setNotice('正在核对页面访问权限…');
    try {
      const next = await api<WritingSettings>('/api/knowledge/connections/notion/writing', { method: 'PUT', body: JSON.stringify({ parent, references: refs.split('\n').map(s => s.trim()).filter(Boolean) }) });
      setSettings(next); setNotice('保存位置已设置，可以在输入框选择 Notion。'); window.dispatchEvent(new Event('one-writing-settings'));
    } catch (e) { setNotice(e instanceof Error ? e.message : '保存未完成'); }
    finally { setBusy(false); }
  }
  return <section className="notion-writing-settings" aria-label="Notion 写入设置"><header className="notion-writing-heading"><div><h4>让 ONE 写到 Notion</h4><p>写作、保存、续改，都在 ONE 里完成。</p></div>{settings?.writeAuthorized ? <span className="notion-writing-badge"><Check size={12} />已授权</span> : null}</header>
    {!settings ? <p>{notice || '正在读取设置…'}</p> : !settings.writeAuthorized ? <><p>当前可读取知识。开启写入后，ONE 还能创建文章并继续修改自己的草稿。</p><button type="button" className="primary notion-writing-save" disabled={busy} onClick={() => void authorize()}>{busy ? '正在打开授权…' : '开启草稿写入'}<ChevronRight size={14} /></button></> : <>
      <label>保存位置<input aria-label="Notion 草稿保存页面" type="url" value={parent} onChange={e => setParent(e.target.value)} placeholder="粘贴一个已有 Notion 页面链接" disabled={busy} /><small>选一次即可，新文章会自动创建在这个页面下。</small></label>
      <details className="notion-reference-settings"><summary>参考我的文章风格{refs.trim() ? <span>已设置</span> : <span>可选</span>}</summary><label>参考文章<textarea aria-label="Notion 参考文章" placeholder="每行粘贴一篇文章链接，最多五篇" rows={3} value={refs} onChange={e => setRefs(e.target.value)} disabled={busy} /><small>写作时按需参考，不复制整库。</small></label></details>
      <button type="button" className="primary notion-writing-save" disabled={busy || !parent.trim()} onClick={() => void save()}>{busy ? '正在核对…' : settings.ready ? '保存修改' : '确认保存位置'}</button>
      <details className="notion-permission-details"><summary>权限与费用说明</summary><p>由 ONE 写作，使用 ONE 额度，不调用 Notion AI。只修订该任务绑定的草稿，不删除或移动页面，不修改数据库。</p><p>改变授权或保存位置后，旧任务会暂停。你在 Notion 手工修改过的内容，写入前会重新核对。</p></details>
    </>}
    {settings && notice ? <p role="status">{notice}</p> : null}
  </section>;
}
