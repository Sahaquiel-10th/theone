import {useRef,useState} from 'react';
import {SettingsDialog} from './SettingsControls';

export type ReconcileStopTarget = {
  id: string; status: string; reportRound?: number; updatedAt: string;
  resultDeliveryPending?: boolean; requiresExecutionCheck?: boolean; targetName?: string;
};
const confirmation = 'manually_checked_original_execution_stopped';

export function canManuallyReconcileStop(role: string, task: ReconcileStopTarget) {
  return role === 'admin' && task.status === 'cancelled'
    && Boolean(task.resultDeliveryPending || task.requiresExecutionCheck);
}
export function reconcileStopSnapshotCurrent(snapshot: ReconcileStopTarget, current: ReconcileStopTarget) {
  return snapshot.id === current.id && (snapshot.reportRound ?? 0) === (current.reportRound ?? 0)
    && snapshot.updatedAt === current.updatedAt;
}
export function manualReconcileStopRequest(snapshot: ReconcileStopTarget, reason: string, confirmed: boolean) {
  const expectedRound=snapshot.reportRound??0, trimmed=reason.trim();
  if (!confirmed || !canManuallyReconcileStop('admin',snapshot) || !snapshot.updatedAt
    || !Number.isSafeInteger(expectedRound) || expectedRound < 0 || !trimmed || trimmed.length > 2000) return undefined;
  return {
    path: `/api/executions/${encodeURIComponent(snapshot.id)}/reconcile-stop`,
    body: {expectedRound,expectedUpdatedAt:snapshot.updatedAt,reason:trimmed,confirmation},
  };
}
type SupportRequest = NonNullable<ReturnType<typeof manualReconcileStopRequest>>;

/** A support-only, explicitly attested stop reconciliation. It never retries
 * work, claims goal completion, or supplies authority beyond the server gate. */
export function ExecutionReconcileStop({actorRole,task,disabled=false,onReconcile}:{
  actorRole:string;task:ReconcileStopTarget;disabled?:boolean;
  onReconcile:(request:SupportRequest)=>Promise<void>;
}) {
  const [snapshot,setSnapshot]=useState<ReconcileStopTarget|null>(null);
  const [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const lock=useRef(false);
  const stale=Boolean(snapshot&&!reconcileStopSnapshotCurrent(snapshot,task));
  const request=snapshot?manualReconcileStopRequest(snapshot,reason,confirmed):undefined;
  const eligible=canManuallyReconcileStop(actorRole,task);
  function close(){if(!lock.current){setSnapshot(null);setError('');}}
  async function submit(){
    if(lock.current||disabled||stale||!eligible||!request)return;
    lock.current=true;setBusy(true);setError('');
    try {
      await onReconcile(request);
      setSnapshot(null);setNotice('已记录人工核对并结束这轮占用。原任务仍为已停止，没有标记完成，也没有重新执行。');
    } catch(e) {setError(e instanceof Error?e.message:'人工核对尚未确认，请检查最新状态；不要重跑原任务。');}
    finally {lock.current=false;setBusy(false);}
  }
  if(actorRole!=='admin')return null;
  return <>
    {eligible?<button type="button" disabled={disabled||busy} onClick={()=>{setSnapshot({...task});setReason('');setConfirmed(false);setError('');setNotice('');}}>人工核对并结束旧占用</button>:null}
    {notice?<p role="status">{notice}</p>:null}
    {snapshot?<SettingsDialog title="人工核对并结束旧占用" onClose={close}>
      <form onSubmit={event=>{event.preventDefault();void submit();}}>
        <p>仅处理这轮已请求停止、但结束情况未确认的旧操作：{snapshot.id} · 第 {(snapshot.reportRound??0)+1} 轮。</p>
        {snapshot.targetName?<p>原工作文件夹：{snapshot.targetName}</p>:null}
        <p>请先在本机核对原进程及相关子进程均已退出，并检查已有文件。这里仅记录人工核对、结束旧占用；不会替你停止仍在运行的进程，不代表任务成功，也不会重跑或启动其他任务。</p>
        <label>人工核对说明<textarea aria-label="人工核对说明" data-dialog-focus rows={3} maxLength={2000} value={reason} disabled={busy} required onChange={event=>setReason(event.target.value)}/></label>
        <label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/>我已确认这轮原操作及相关子进程均已退出，并检查了已有文件。</label>
        {stale?<p role="alert">这轮状态已变化，请关闭后重新检查；不会按旧记录结束占用。</p>:null}
        {error?<p role="alert">{error}</p>:null}
        <div className="local-directory-actions"><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className="primary" disabled={busy||disabled||stale||!eligible||!request}>{busy?'正在记录核对…':'记录核对并结束占用'}</button></div>
      </form>
    </SettingsDialog>:null}
  </>;
}
