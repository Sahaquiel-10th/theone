import {useEffect, useRef, useState} from 'react';
import {previewReceiptMatches, previewUnavailableMessage, type PreviewReply} from './staticPreviewState';

export function StaticPreviewPanel({taskId, request}: {taskId: string; request: (action: 'start' | 'stop' | 'status', path?: string) => Promise<PreviewReply>}) {
  const [path, setPath] = useState('index.html');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const requestRef = useRef(request); requestRef.current = request;
  useEffect(() => { generation.current++; setUrl(''); setMessage(''); setPath('index.html'); setBusy(false); return () => { generation.current++; }; }, [taskId]);
  useEffect(() => {
    if (!url || busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const round = generation.current;
    async function check() {
      let reply: PreviewReply | undefined;
      try { reply = await requestRef.current('status'); } catch { /* A failed proof is not a live preview. */ }
      if (cancelled || round !== generation.current) return;
      if (!reply || !previewReceiptMatches(url, reply)) { setUrl(''); setMessage(previewUnavailableMessage(reply)); return; }
      timer = setTimeout(() => void check(), 3000);
    }
    timer = setTimeout(() => void check(), 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [taskId, url, busy]);
  async function change(action: 'start' | 'stop') {
    const round = ++generation.current;
    setBusy(true); setUrl(''); setMessage('');
    try { const result = await request(action, path.trim()); if (round !== generation.current) return; setUrl(result.status === 'ready' ? result.url || '' : ''); setMessage(action === 'stop' ? '预览已停止' : '仅在这台电脑可访问，最多保留30分钟；拔掉 Key、更换目录或连接断开后停止。'); }
    catch (error) { if (round === generation.current) { setUrl(''); setMessage(error instanceof Error ? error.message : '本机预览未确认'); } }
    finally { if (round === generation.current) setBusy(false); }
  }
  return <details className="execution-step-history"><summary>Mac 静态网页预览</summary>
    <p>只预览 HTML、CSS、JS、SVG，不运行工程命令。启动新预览会停止之前的预览。填写 ONE 工作文件夹里的相对路径，例如 qa-codex-20261010/index.html。</p>
    <label>网页相对路径 <input aria-label="预览网页相对路径" value={path} onChange={event => setPath(event.target.value)} disabled={busy}/></label>
    <button type="button" disabled={busy || !path.trim()} onClick={() => void change('start')}>{busy ? '正在确认…' : url ? '重新启动预览' : '启动本机预览'}</button>
    {url ? <a href={url} target="_blank" rel="noopener noreferrer">打开预览 ↗</a> : null}
    <button type="button" disabled={busy} onClick={() => void change('stop')}>停止本轮预览</button>
    {message ? <p role="status">{message}</p> : null}
  </details>;
}
