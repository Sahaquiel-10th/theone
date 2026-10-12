import { useEffect, useRef, useState } from 'react';
import type { api as Api } from './oneApi';
import './local-device.css';
type ExecutorState = { available: boolean; preparing?: boolean; phase?: string; installedVersion?: string; installedSource?: 'existing' | 'managed'; version?: string; size?: number; message?: string; error?: string };
const preparationMessages: Record<string,string> = { confirming:'请确认电脑上的准备窗口', downloading:'正在下载执行工具', verifying:'正在校验并安装执行工具', checking:'正在检查本机已有工具' };

export function LocalDeviceSettings({ api }: { api: typeof Api }) {
  const [directory, setDirectory] = useState(''), [busy, setBusy] = useState(false), [choosing, setChoosing] = useState(false), [error, setError] = useState('');
  const [executor, setExecutor] = useState<ExecutorState>(), [preparing, setPreparing] = useState(false), [executorError, setExecutorError] = useState('');
  const [checking,setChecking]=useState(false),[checkedAt,setCheckedAt]=useState(''),[directoryCheckedAt,setDirectoryCheckedAt]=useState('');
  const executorRequest=useRef(false);
  async function checkExecutor(install = false) {
    if(executorRequest.current)return;
    executorRequest.current=true;setChecking(true);setPreparing(install); setExecutorError('');setCheckedAt('');
    try { setExecutor(await api<ExecutorState>('/api/me/executor', { method: install ? 'POST' : 'GET' }));setCheckedAt(new Date().toLocaleTimeString('zh-CN')); }
    catch (e) { setExecutorError(e instanceof Error ? e.message : '工具状态暂时无法确认，请重新检查'); }
    finally { setPreparing(false);setChecking(false);executorRequest.current=false; }
  }
  async function load(change = false) {
    setBusy(true); setChoosing(change); setError('');
    try {
      const result = await api<{ targetName?: string }>('/api/me/local-device', { method: change ? 'POST' : 'GET' });
      setDirectory(result.targetName ?? '');
      setDirectoryCheckedAt(new Date().toLocaleTimeString('zh-CN'));
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
    <button type="button" disabled={busy} onClick={() => void load()}>核对授权目录</button></div>
    {directoryCheckedAt&&!busy?<small role="status">目录已核对 · {directoryCheckedAt}</small>:null}
    <p className="hint">ONE 原生文件工具仅操作此目录。工程执行工具使用独立的本机授权与沙箱；目录选择不等于全盘授权。</p>
    <details><summary>授权范围与更换说明</summary><p>此设置只属于当前电脑，执行中不能更换。工程执行的权限与原生文件工具不同；若操作需要更多权限，请核对本机确认窗口，不要仅凭这里的目录推断全部工具权限。</p></details>
    {error ? <p role="alert">{error}</p> : null}
    <p>工程执行工具</p>
    <p role="status">{checking && !preparing ? '正在检查工具状态…' : preparing || executor?.preparing ? `${preparationMessages[executor?.phase || 'confirming'] || '正在检查并准备工具'}，不会自动执行任务。` : executor?.installedVersion ? `工程执行工具已就绪 · ${executor.installedVersion}` : executor?.message || (executor?.available ? '安装渠道可用，尚未确认本机工具。点击“准备本机执行”检查并准备。' : executorError ? '工具状态未确认，请重新检查。' : '当前尚未取得可用的工程执行工具，请检查启动器连接。')}</p>
    {checkedAt&&!checking&&!executor?.preparing?<small role="status">状态已更新 · {checkedAt}</small>:null}
    <div className="local-directory-actions">
      {executor?.available ? <button type="button" className="primary" disabled={busy || checking || preparing || executor.preparing || executor.installedSource === 'existing' || executor.installedVersion === executor.version} onClick={() => void checkExecutor(true)}>{preparing ? '正在准备…' : executor.installedSource === 'existing' ? '工具已就绪' : executor.installedVersion ? '更新执行工具' : '准备本机执行'}</button> : null}
      <button type="button" disabled={checking || preparing || executor?.preparing} onClick={() => void checkExecutor()}>{checking?'正在检查…':'检查工具状态'}</button>
    </div>
    <details><summary>工具来源与安装说明</summary><p>{executor?.installedVersion?executor.installedSource==='existing'?'使用已找到的兼容 Codex，ONE 使用独立配置，不改写个人配置。':'使用 ONE 准备的 Codex，无需第三方登录。':`先检查本机已有 Codex；没有兼容版本时再确认下载${executor?.size?`（约 ${Math.ceil(executor.size/1024/1024)} MB）`:''}。`} 准备工具不会自动执行任务，也不授予全盘权限。</p></details>
    {executorError ? <p role="alert">{executorError}</p> : null}
    {executor?.error ? <p role="alert">{executor.error}</p> : null}
  </section>;
}
