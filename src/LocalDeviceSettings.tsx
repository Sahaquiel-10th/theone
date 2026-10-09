import { useEffect, useState } from 'react';
import type { api as Api } from './oneApi';
import './local-device.css';
type ExecutorState = { available: boolean; preparing?: boolean; phase?: string; installedVersion?: string; version?: string; size?: number; message?: string; error?: string };
const preparationMessages: Record<string,string> = { confirming:'请确认电脑上的准备窗口', downloading:'正在下载执行工具', verifying:'正在校验并安装执行工具', checking:'正在检查工具能否启动' };

export function LocalDeviceSettings({ api }: { api: typeof Api }) {
  const [directory, setDirectory] = useState(''), [busy, setBusy] = useState(false), [choosing, setChoosing] = useState(false), [error, setError] = useState('');
  const [executor, setExecutor] = useState<ExecutorState>(), [preparing, setPreparing] = useState(false), [executorError, setExecutorError] = useState('');
  async function checkExecutor(install = false) {
    setPreparing(install); setExecutorError('');
    try { setExecutor(await api<ExecutorState>('/api/me/executor', { method: install ? 'POST' : 'GET' })); }
    catch (e) { setExecutorError(e instanceof Error ? e.message : '工具状态暂时无法确认，请重新检查'); }
    finally { setPreparing(false); }
  }
  async function load(change = false) {
    setBusy(true); setChoosing(change); setError('');
    try {
      const result = await api<{ targetName?: string }>('/api/me/local-device', { method: change ? 'POST' : 'GET' });
      setDirectory(result.targetName ?? '');
    } catch (e) { setError(e instanceof Error ? e.message : '无法取得本机设置'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); void checkExecutor(); }, [api]);
  useEffect(() => {
    if (!preparing && !executor?.preparing) return;
    const timer = window.setInterval(() => {
      void api<ExecutorState>('/api/me/executor').then(setExecutor).catch(() => { /* The final request reports failures; polling never retries an install. */ });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [api, preparing, executor?.preparing]);
  return <section className="account-panel local-device-settings" aria-label="本机执行授权">
    <div className="account-panel-title"><h3>本机执行</h3></div>
    <p>工作文件夹</p>
    <p style={{ overflowWrap: 'anywhere' }}>{directory || (busy ? '正在读取本机设置…' : error ? '暂时无法确认授权范围' : '尚未选择，第一次执行时会询问')}</p>
    <div className="local-directory-actions"><button type="button" className="primary" disabled={busy || preparing} onClick={() => void load(true)}>{busy ? choosing ? '请查看电脑上的选择窗口' : '正在检查…' : directory ? '更换文件夹' : '选择文件夹'}</button>
    <button type="button" disabled={busy} onClick={() => void load()}>重新检查</button></div>
    <p className="hint">本设置只属于当前电脑。执行过程中不能更换；外部执行器的权限与 ONE 原生文件工具的目录限制不同。</p>
    {error ? <p role="alert">{error}</p> : null}
    <p>工程执行工具</p>
    <p role="status">{preparing || executor?.preparing ? `${preparationMessages[executor?.phase || 'confirming'] || '正在准备工具'}，不会自动执行任务。` : executor?.installedVersion ? `已准备 Codex ${executor.installedVersion}，通过 ONE 使用，无需第三方登录` : executor?.message || (executor?.available ? `可准备 Codex ${executor.version}（约 ${Math.max(1, Math.ceil((executor.size || 0) / 1024 / 1024))} MB）` : '正在确认工具状态…')}</p>
    <div className="local-directory-actions">
      {executor?.available ? <button type="button" className="primary" disabled={busy || preparing || executor.preparing || executor.installedVersion === executor.version} onClick={() => void checkExecutor(true)}>{preparing ? '正在准备…' : executor.installedVersion ? '更新执行工具' : '准备本机执行'}</button> : null}
      <button type="button" disabled={preparing} onClick={() => void checkExecutor()}>检查工具状态</button>
    </div>
    <p className="hint">工具安装与工作文件夹授权分开。准备工具不授予全盘权限，也不会改写个人 Codex 配置。</p>
    {executorError ? <p role="alert">{executorError}</p> : null}
    {executor?.error ? <p role="alert">{executor.error}</p> : null}
  </section>;
}
