import { useEffect, useState } from 'react';
import type { api as Api } from './oneApi';
import './document-destination.css';
export type DocumentDestination = 'chat' | 'local' | 'notion';
export function NotionReceiptNotice({ api, taskId, receipt, onRefresh }: { api: typeof Api; taskId: string; receipt?: {state: string; url?: string; error?: string}; onRefresh: () => Promise<unknown> }) {
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  if (!receipt || receipt.state === 'verified') return null;
  return <section className="notion-writing-settings" aria-label="Notion 保存回执"><p>Notion 保存尚未确认，不会自动重复写入。</p>{receipt.url ? <a href={receipt.url} target="_blank" rel="noreferrer">打开原页面核对 ↗</a> : <p>暂未取得页面编号，请在 Notion 检查草稿目录。</p>}
    {receipt.url ? <button type="button" disabled={busy} onClick={async()=>{setBusy(true);setNotice('');try{await api(`/api/coordinator/tasks/${encodeURIComponent(taskId)}/notion/verify`,{method:'POST'});setNotice('已重新回读，保存内容一致。可以继续提出修改要求。');await onRefresh();}catch(e){setNotice(e instanceof Error?e.message:'暂未确认，没有重发保存请求');}finally{setBusy(false);}}}>{busy?'正在回读核对…':'核对保存结果（不重写）'}</button> : null}
    {notice ? <p role="status">{notice}</p> : null}</section>;
}
type WritingSettings = { connected: boolean; writeAuthorized: boolean; ready: boolean; parentId: string; referenceIds: string[] };
const url = (id: string) => id ? `https://www.notion.so/${id}` : '';

export function DocumentDestinationPicker({ api, value, onChange, localDisabled, onSettings }: {
  api: typeof Api; value: DocumentDestination; onChange: (value: DocumentDestination) => void; localDisabled: boolean; onSettings: () => void;
}) {
  const [writing, setWriting] = useState<WritingSettings>(), [localReady, setLocalReady] = useState(false), [checking, setChecking] = useState(true);
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
  return <div className="document-destination">
    <label>输出到 <select aria-label="输出位置" value={value} onChange={e => onChange(e.target.value as DocumentDestination)}>
      <option value="chat">对话中</option>
      <option value="local" disabled={!localReady || localDisabled}>本地文件{!localReady ? ' · 尚未就绪' : ''}</option>
      {writing?.connected ? <option value="notion" disabled={!writing.ready}>Notion{!writing.writeAuthorized ? ' · 需授权写入' : !writing.ready ? ' · 需选保存页面' : ''}</option> : null}
    </select></label>
    {checking ? <small>检查保存位置…</small> : invalid ? <span role="status">当前位置暂不可用，请重新选择</span> : value === 'notion' ? <small>保存为草稿 · 后续修改同一篇</small> : value === 'local' ? <small>使用当前授权文件夹</small> : null}
    <button type="button" onClick={onSettings}>{writing?.connected && !writing.ready ? '设置 Notion 写入' : '管理保存位置'}</button>
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
  return <section className="notion-writing-settings" aria-label="Notion 写入设置"><h4>写到 Notion</h4>
    {!settings ? <p>{notice || '正在读取设置…'}</p> : !settings.writeAuthorized ? <><p>当前连接只用于读取知识。重新授权后，可用 ONE 写作并保存草稿、继续修改同一篇。</p><button type="button" className="primary" disabled={busy} onClick={() => void authorize()}>{busy ? '正在打开授权…' : '授权创建与修订草稿'}</button></> : <>
      <label>草稿保存页面<input aria-label="Notion 草稿保存页面" type="url" value={parent} onChange={e => setParent(e.target.value)} placeholder="粘贴普通 Notion 页面链接" disabled={busy} /></label>
      <label>参考文章（可选，最多五篇，每行一个链接）<textarea aria-label="Notion 参考文章" rows={3} value={refs} onChange={e => setRefs(e.target.value)} disabled={busy} /></label>
      <button type="button" className="primary" disabled={busy || !parent.trim()} onClick={() => void save()}>{busy ? '正在核对…' : '保存写入设置'}</button>
      <details><summary>权限与保存说明</summary><p>新文章创建在所选普通页面下。只修订 ONE 任务绑定的草稿，不删除、移动页面或修改数据库。页面被手工修改时会重新核对。改变授权或保存页面后，旧任务会暂停，请确认后再继续。</p><p>你选择的参考文章按需读取，不会整库同步。内容由 ONE 的模型生成，使用统一 ONE 额度，不调用 Notion AI。</p></details>
    </>}
    {settings && notice ? <p role="status">{notice}</p> : null}
  </section>;
}
