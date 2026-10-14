/** Human-facing labels are projections. The original event stays available in details. */
export function friendlyExecutionProgress(event?: { kind: string; text: string }) {
  if (!event) return '';
  if (event.kind === 'command') return '我在处理项目文件，展开可以看具体操作';
  if (event.kind === 'file_change') return '文件有了新的变化，展开可以看详情';
  return event.text
    .replace(/正在连接本机 Codex…|正在连接 ONE Local Agent…/, '我在连接这台电脑…')
    .replace(/请选择 Codex 可以工作的文件夹/, '先选一个可以工作的文件夹')
    .replace(/Codex 已开始执行/, '开始在这台电脑上做了')
    .replace(/Codex 会话已建立/, '这台电脑已经连上了')
    .replace(/Codex 本轮已结束，?请查看执行结果/, '这轮反馈回来了，展开看看做了什么');
}

export function readCapturedNotices<T extends {id:string;read?:boolean}>(notices:T[],ids:Set<string>):T[] {
  return notices.map(notice=>ids.has(notice.id)?{...notice,read:true}:notice);
}

export function friendlyResponsePhase(phase?: string) {
  if (!phase) return '我先把你的意思捋清楚';
  return ({'正在理解你的要求':'我先把你的意思捋清楚','正在等待模型回答':'我正在想这件事','正在查找已授权知识库':'我在找你连接的资料','正在查找公开资料':'我去找找公开资料','正在定位相关任务':'我在找你说的那件事','正在核对任务上下文':'我在对一下之前聊过的内容','正在交接任务':'我把要求整理好，交给对应的任务','正在交给本机执行':'准备让这台电脑开始做','正在交接图片任务':'我把画图要求交给图片任务','正在调用已授权工具':'我在用需要的工具帮你处理','已取得工具反馈，正在整理回答':'资料回来了，我再整理一下'} as Record<string,string>)[phase] || phase;
}
