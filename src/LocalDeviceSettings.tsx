import { useEffect, useState } from 'react';
import type { api as Api } from './oneApi';
import './local-device.css';

export function LocalDeviceSettings({ api }: { api: typeof Api }) {
  const [directory, setDirectory] = useState(''), [busy, setBusy] = useState(false), [choosing, setChoosing] = useState(false), [error, setError] = useState('');
  async function load(change = false) {
    setBusy(true); setChoosing(change); setError('');
    try {
      const result = await api<{ targetName?: string }>('/api/me/local-device', { method: change ? 'POST' : 'GET' });
      setDirectory(result.targetName ?? '');
    } catch (e) { setError(e instanceof Error ? e.message : '无法取得本机设置'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [api]);
  return <section className="account-panel local-device-settings" aria-label="本机执行授权">
    <div className="account-panel-title"><h3>本机执行</h3></div>
    <p>工作文件夹</p>
    <p style={{ overflowWrap: 'anywhere' }}>{directory || (busy ? '正在读取本机设置…' : error ? '暂时无法确认授权范围' : '尚未选择，第一次执行时会询问')}</p>
    <div className="local-directory-actions"><button type="button" className="primary" disabled={busy} onClick={() => void load(true)}>{busy ? choosing ? '请查看电脑上的选择窗口' : '正在检查…' : directory ? '更换文件夹' : '选择文件夹'}</button>
    <button type="button" disabled={busy} onClick={() => void load()}>重新检查</button></div>
    <p className="hint">本设置只属于当前电脑。执行过程中不能更换；外部执行器的权限与 ONE 原生文件工具的目录限制不同。</p>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
