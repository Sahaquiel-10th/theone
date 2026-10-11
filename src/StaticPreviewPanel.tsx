import {useEffect, useState} from 'react';

export function StaticPreviewPanel({taskId, request}: {taskId: string; request: (action: 'start' | 'stop', path?: string) => Promise<{status: string; url?: string}>}) {
  const [path, setPath] = useState('index.html');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => { setUrl(''); setMessage(''); setPath('index.html'); }, [taskId]);
  async function change(action: 'start' | 'stop') {
    setBusy(true); setMessage('');
    try { const result = await request(action, path.trim()); setUrl(result.url || ''); setMessage(action === 'stop' ? '预览已停止' : '仅在这台电脑可访问，最多保留30分钟；拔掉 Key、更换目录或连接断开后停止。'); }
    catch (error) { setUrl(''); setMessage(error instanceof Error ? error.message : '本机预览未确认'); }
    finally { setBusy(false); }
  }
  return <details className="execution-step-history"><summary>Mac 静态网页预览</summary>
    <p>只预览 HTML、CSS、JS、SVG，不运行工程命令。启动新预览会停止之前的预览。路径相对于上方授权文件夹，例如 qa-codex-20261010/index.html。</p>
    <label>网页相对路径 <input aria-label="预览网页相对路径" value={path} onChange={event => setPath(event.target.value)} disabled={busy}/></label>
    <button type="button" disabled={busy || !path.trim()} onClick={() => void change('start')}>{busy ? '正在确认…' : url ? '重新启动预览' : '启动本机预览'}</button>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer">打开预览 ↗</a> : null}
    <button type="button" disabled={busy} onClick={() => void change('stop')}>停止本轮预览</button>
    {message ? <p role="status">{message}</p> : null}
  </details>;
}
