export type LocalExecutorState = {
  available: boolean;
  preparing?: boolean;
  phase?: string;
  installedVersion?: string;
  installedSource?: 'existing' | 'managed' | 'builtin';
  version?: string;
  size?: number;
  message?: string;
  error?: string;
};

/** Readiness is based on confirmed state, never on an installation channel. */
export function localDeviceStatus(executor:LocalExecutorState|undefined,checking:boolean,preparing:boolean,requestError='') {
  if(preparing||executor?.preparing){
    const stages:Record<string,string>={confirming:'等待电脑确认',downloading:'正在下载执行工具',verifying:'正在安装并检查',checking:'正在检查本机工具'};
    return {state:'preparing',title:stages[executor?.phase||'confirming']||'正在准备本机执行',description:'准备完成后再执行任务。'};
  }
  if(checking)return {state:'checking',title:'正在检查本机状态',description:'请稍候。'};
  if(requestError||executor?.error)return {state:'unconfirmed',title:'本机状态未确认',description:'保持 ONE Key 连接后，重新检查。'};
  if(executor?.available&&executor.installedSource==='builtin'&&executor.installedVersion)return {state:'ready',title:'内置文件工具已连接',description:'可在已授权的工作文件夹内读取、创建和修改文件；无需另装执行工具。'};
  if(executor?.installedVersion)return {state:'ready',title:'本机执行已就绪',description:'可以按你的要求创建和整理文件。'};
  if(executor?.available)return {state:'setup',title:'需要准备本机执行',description:'点击下方按钮，检查并准备执行工具。'};
  return {state:'unconfirmed',title:'本机连接未确认',description:'连接 ONE Key 后，重新检查。'};
}
