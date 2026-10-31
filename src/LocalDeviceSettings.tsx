import { useEffect, useMemo, useRef, useState } from 'react';
import type { api as Api } from './oneApi';
import './local-device.css';
import {SettingsDialog} from './SettingsControls';
import type {LocalExecutorState} from './localDeviceStatus';
import {localReadinessStatus} from './localDeviceReadiness';
import {useLocalDeviceReadiness} from './useLocalDeviceReadiness';
import {refreshLocalDeviceReadiness,ONE_LOCAL_SETTINGS_EVENT} from './localDeviceReadinessStore';
type ExecutorState=LocalExecutorState;

export function LocalDeviceSettings({ api }: { api: typeof Api }) {
  const [busy, setBusy] = useState(false), [choosing, setChoosing] = useState(false), [error, setError] = useState('');
  const readiness=useLocalDeviceReadiness(api),lastDirectory=useMemo(()=>({value:''}),[api]);
  if(readiness.value?.folder.state==='ready')lastDirectory.value=readiness.value.folder.targetName??'';
  const directory=readiness.value?.folder.targetName??lastDirectory.value;
  const [executor, setExecutor] = useState<ExecutorState>(), [preparing, setPreparing] = useState(false), [executorError, setExecutorError] = useState('');
  const [checking,setChecking]=useState(false);
  const [help,setHelp]=useState<'folder'|'executor'|null>(null);
  const executorRequest=useRef(false);
  async function refreshReadiness(){const result=refreshLocalDeviceReadiness(api);window.dispatchEvent(new Event(ONE_LOCAL_SETTINGS_EVENT));await result;}
  async function checkExecutor(install = false,refreshAfter=true) {
    if(executorRequest.current)return;
    executorRequest.current=true;setChecking(true);setPreparing(install); setExecutorError('');
    try { setExecutor(await api<ExecutorState>('/api/me/executor', { method: install ? 'POST' : 'GET' }));if(refreshAfter)await refreshReadiness(); }
    catch (e) { setExecutorError(e instanceof Error ? e.message : '工具状态暂时无法确认，请重新检查');if(refreshAfter)await refreshReadiness(); }
    finally { setPreparing(false);setChecking(false);executorRequest.current=false; }
  }
  async function load(change = false) {
    setBusy(true); setChoosing(change); setError('');
    try {
      if(change)await api<{targetName?:string}>('/api/me/local-device',{method:'POST'});
      await refreshReadiness();
    } catch (e) { setError(e instanceof Error ? e.message : '无法取得本机设置');await refreshReadiness(); }
    finally { setBusy(false); }
  }
  useEffect(() => { void checkExecutor(false,false); }, [api]);
  useEffect(() => {
    if (!preparing && !executor?.preparing) return;
    const timer = window.setInterval(() => {
      void api<ExecutorState>('/api/me/executor').then(value=>{setExecutor(value);if(!value.preparing)void refreshReadiness();}).catch(() => { void refreshReadiness(); });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [api, preparing, executor?.preparing]);
  const status=localReadinessStatus(readiness.value,readiness.status==='idle'||readiness.status==='checking'||checking||preparing,readiness.error);
  const checkedAt=readiness.status==='confirmed'&&readiness.value?new Date(readiness.value.checkedAt).toLocaleString('zh-CN'):'';
  const builtin=executor?.installedSource==='builtin';
  return <div className="local-device-settings local-device-grid" aria-label="本机工作设置"><section className="account-panel">
    <header className="settings-card-heading"><h3>ONE 工作文件夹</h3></header>
    <p style={{ overflowWrap: 'anywhere' }}>{directory || (busy||readiness.status==='idle'||readiness.status==='checking' ? '正在查看工作文件夹…' : readiness.value?.folder.state==='unselected' ? '还没选，第一次需要在电脑上做事时再选也行' : '当前还没确认工作文件夹，先检查连接就好')}</p>
    {directory&&readiness.value?.folder.state!=='ready'?<small role="status">此前选过这个文件夹，当前连接还在核对；不用重复选择。</small>:null}
    <div className="local-directory-actions"><button type="button" className="primary" disabled={busy || preparing || !readiness.value?.connected} onClick={() => void load(true)}>{busy ? choosing ? '请查看电脑上的选择窗口' : '正在检查…' : directory ? '更换工作文件夹' : '选择 ONE 工作文件夹'}</button>
    <button type="button" className="settings-help-button folder-permission-help" aria-label="了解工作文件夹的权限" aria-haspopup="dialog" title="了解工作文件夹的权限" onClick={()=>setHelp('folder')}>ⓘ</button>
    <button type="button" disabled={busy} onClick={() => void load()}>检查文件夹连接</button></div>
    {checkedAt&&readiness.value?.folder.state==='ready'&&!busy&&!error?<small role="status">文件夹已检查 · {checkedAt}</small>:null}
    <p className="hint">需要处理文件时，ONE 默认在这里工作。</p>
    {error ? <p role="alert">{error}</p> : null}
    </section><section className="account-panel"><header className="settings-card-heading"><h3>本机执行</h3><button type="button" className="settings-help-button" aria-label="查看执行工具说明" onClick={()=>setHelp('executor')}>ⓘ</button></header>
    <div className="local-device-readiness" data-readiness={status.state}><strong role="status">{status.title}</strong><p className="hint">{status.description}</p></div>
    {checkedAt&&!checking&&!executor?.preparing?<small role="status">状态已更新 · {checkedAt}</small>:null}
    <div className="local-directory-actions">
      {executor?.available&&!builtin ? <button type="button" className="primary" disabled={busy || checking || preparing || executor.preparing || executor.installedSource === 'existing' || executor.installedVersion === executor.version} onClick={() => void checkExecutor(true)}>{preparing ? '正在准备…' : executor.installedSource === 'existing' ? '工具已就绪' : executor.installedVersion ? '更新执行工具' : '准备本机执行'}</button> : null}
      <button type="button" disabled={checking || preparing || executor?.preparing} onClick={() => void checkExecutor()}>{checking?'正在检查…':'检查工具状态'}</button>
    </div>
    <details className="local-device-details"><summary>工具与版本</summary><dl><div><dt>执行工具</dt><dd>{builtin?'ONE 内置文件工具':'Codex'}</dd></div><div><dt>{builtin?'启动器版本':'当前版本'}</dt><dd>{executor?.installedVersion||'尚未确认'}</dd></div>{executor?.installedVersion?<div><dt>安装方式</dt><dd>{builtin?'随 ONE 启动器提供':executor.installedSource==='existing'?'使用本机已有工具':'由 ONE 准备'}</dd></div>:null}</dl>{executor?.message?<p>{executor.message}</p>:null}</details>
    {executorError||readiness.error ? <p role="alert">{executorError||readiness.error}</p> : null}
    {executor?.error ? <p role="alert">{executor.error}</p> : null}
  </section>{help?<SettingsDialog title={help==='folder'?'这个文件夹会用来做什么？':'执行工具说明'} onClose={()=>setHelp(null)}>{help==='folder'?<><p>选好后，你就允许 ONE 的文件工具在这个文件夹里读取、创建和按要求修改文件。这不是把整台电脑都交给 ONE。</p><p>执行工具还有自己的权限限制；涉及其他位置时，仍需按系统提示确认。聊天和搜索不用先选文件夹。</p><p>这里只记住当前电脑的选择。可以随时回来更换；如果有本机任务正在执行，先等它结束或停止。</p></>:<p>{builtin?'Windows 使用 ONE 内置文件工具，不需要下载 Mac 的 Codex 执行器。工具会随 ONE 启动器更新。':executor?.installedVersion?executor.installedSource==='existing'?'使用已找到的兼容 Codex，ONE 使用独立配置，不改写个人配置。':'使用 ONE 准备的 Codex，无需第三方登录。':`先检查本机已有 Codex；没有兼容版本时再确认下载${executor?.size?`（约 ${Math.ceil(executor.size/1024/1024)} MB）`:''}。`} 检查或准备工具不会自动执行任务，也不授予全盘权限。</p>}</SettingsDialog>:null}</div>;
}
