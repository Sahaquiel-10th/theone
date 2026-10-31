export type LocalFolderState='ready'|'unselected'|'unavailable'|'denied'|'unknown';
export type LocalExecutorReadinessState='ready'|'unprepared'|'busy'|'unavailable'|'unknown';
export type LocalDeviceReadinessReason='ready'|'offline'|'folder_unselected'|'folder_unavailable'|'folder_denied'|'executor_unprepared'|'busy'|'unknown';
export type LocalDeviceReadiness={
  checkedAt:string;
  ready:boolean;
  connected:boolean;
  folder:{state:LocalFolderState;targetName?:string};
  executor:{state:LocalExecutorReadinessState;installedVersion?:string;installedSource?:'existing'|'managed'|'builtin'};
  reason:LocalDeviceReadinessReason;
};
const folderStates:readonly string[]=['ready','unselected','unavailable','denied','unknown'];
const executorStates:readonly string[]=['ready','unprepared','busy','unavailable','unknown'];
const sources:readonly string[]=['existing','managed','builtin'];
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function localDeviceReadinessReason(value:Pick<LocalDeviceReadiness,'connected'|'folder'|'executor'>):LocalDeviceReadinessReason {
  if(!value.connected)return'offline';
  if(value.executor.state==='busy')return'busy';
  if(value.folder.state==='unselected')return'folder_unselected';
  if(value.folder.state==='denied')return'folder_denied';
  if(value.folder.state==='unavailable')return'folder_unavailable';
  if(value.folder.state!=='ready')return'unknown';
  if(value.executor.state==='unprepared')return'executor_unprepared';
  if(value.executor.state!=='ready')return'unknown';
  return'ready';
}
/** Whitelist only reviewed metadata. A browser snapshot is never execution authority. */
export function parseLocalDeviceReadiness(value:unknown):LocalDeviceReadiness|undefined {
  if(!record(value)||typeof value.checkedAt!=='string'||!Number.isFinite(Date.parse(value.checkedAt))||new Date(value.checkedAt).toISOString()!==value.checkedAt
    ||typeof value.ready!=='boolean'||typeof value.connected!=='boolean'||!record(value.folder)||!record(value.executor)
    ||typeof value.folder.state!=='string'||typeof value.executor.state!=='string'||!folderStates.includes(value.folder.state)||!executorStates.includes(value.executor.state))return;
  const folder:LocalDeviceReadiness['folder']={state:value.folder.state as LocalFolderState};
  if(value.folder.targetName!==undefined){
    if(typeof value.folder.targetName!=='string'||!value.folder.targetName.trim()||value.folder.targetName.length>4096||/[\x00-\x1f\x7f]/.test(value.folder.targetName)||folder.state!=='ready')return;
    folder.targetName=value.folder.targetName;
  }
  if(folder.state==='ready'&&!folder.targetName)return;
  const executor:LocalDeviceReadiness['executor']={state:value.executor.state as LocalExecutorReadinessState};
  if(value.executor.installedVersion!==undefined){
    if(typeof value.executor.installedVersion!=='string'||!/^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(value.executor.installedVersion)||value.executor.installedVersion.length>80)return;
    executor.installedVersion=value.executor.installedVersion;
  }
  if(value.executor.installedSource!==undefined){if(typeof value.executor.installedSource!=='string'||!sources.includes(value.executor.installedSource))return;executor.installedSource=value.executor.installedSource as NonNullable<typeof executor.installedSource>;}
  if(executor.state==='ready'&&!executor.installedVersion)return;
  const result:LocalDeviceReadiness={checkedAt:value.checkedAt,ready:value.ready,connected:value.connected,folder,executor,reason:value.reason as LocalDeviceReadinessReason};
  if(result.reason!==localDeviceReadinessReason(result)||result.ready!==(result.reason==='ready')||!result.connected&&(folder.state!=='unknown'||executor.state!=='unknown'))return;
  return result;
}
/** First-folder selection belongs only to a later explicit execution request, never this probe. */
export function localDeviceCanRequestExecution(value:LocalDeviceReadiness|undefined):boolean {
  return !!value?.connected&&value.executor.state==='ready'&&(value.folder.state==='ready'||value.folder.state==='unselected');
}
export function localReadinessStatus(value:LocalDeviceReadiness|undefined,checking:boolean,error=''):{state:string;title:string;description:string} {
  if(checking)return{state:'checking',title:'正在检查本机状态',description:'正在核对当前连接、工作文件夹和执行工具。'};
  const reason=error?'unknown':value?.reason??'unknown';
  const copy:Record<LocalDeviceReadinessReason,[string,string]>={
    ready:['本机执行已就绪','当前电脑连接、工作文件夹和执行工具均已检查。'],
    offline:['当前电脑连接已断开','工作文件夹选择不会因此清空；请保持 ONE Key 连接，再检查状态。'],
    folder_unselected:['还没选择工作文件夹','选择一个具体工作文件夹后，再开始本机操作。'],
    folder_unavailable:['工作文件夹暂时不可用','请恢复原文件夹，或明确更换工作文件夹；不用重新安装工具。'],
    folder_denied:['工作文件夹访问未获允许','请检查 macOS 的文件访问权限，再检查原工作文件夹。'],
    executor_unprepared:['需要准备本机执行','工作文件夹已确认，执行工具尚未准备好。'],
    busy:['本机正在处理其他操作','请等待当前任务、目录更换或工具准备结束，再检查状态。'],
    unknown:['本机状态尚未确认','本次检查未取得完整结果；旧的就绪状态不会继续生效，请重新检查。'],
  };
  return{state:reason,title:copy[reason][0],description:copy[reason][1]};
}
