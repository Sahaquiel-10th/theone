export type TaskRecovery = { kind: 'retry' | 'resume' | 'review_image' | 'review_notion' | 'review_local' | 'none'; message: string; sourceJobId?: string; welcomeStep?:'manual'|'image'|'page' };

/** A recovery action follows the persisted latest job, not a guessed UI state. */
export function taskRecovery(jobs: { id: string; state: string; kind?: string;steps?:{effect:string;state:string}[];dependencyBlocked?:boolean;dependsOnOperationIds?:string[]; notionTarget?: unknown; notionReceipt?: {state: string};welcomeManual?:{document?:unknown};welcomeImageAttachmentId?:string }[]): TaskRecovery {
  const latest = jobs.at(-1);
  if (!latest) return { kind: 'none', message: '原话仍在，请核对已有结果后发送新的要求。' };
  if(latest.state==='cancelled'&&latest.dependsOnOperationIds?.length)return {kind:'none',message:'前面的任务停下后，这一项也停下了。想继续的话，在这里补充新的要求就好，不会自己重新开始。'};
  if(latest.dependencyBlocked)return {kind:'none',message:'先继续前面卡住的任务。它做好后，这一项会接着处理，不用重新交代。'};
  if (jobs.some(job => job.state === 'running')) return { kind: 'none', message: '本轮仍在处理，请查看进展或停止，暂不重复启动。' };
  if(latest.steps?.some(s=>s.state==='started'&&['artifact','external_write'].includes(s.effect)))return {kind:'none',message:'有份文件是否保存好还没确认。先看看已有成果；需要继续时补充要求，ONE 会先核对，不会盲目重复保存。'};
  if (latest.state === 'prepared') return { kind: 'review_local', message: '请先查看本机执行回执；确认已完成的修改后，再从本机执行入口继续。' };
  if (latest.state === 'completed') return { kind: 'none', message: '最新一轮已有结果，请查看结果或提出新的修改要求。' };
  if (jobs.some(job=>job.notionReceipt&&job.notionReceipt.state!=='verified')) return { kind: 'review_notion', message: '请先核对 Notion 保存回执和原页面。确认保存情况后再继续，避免重复写入。' };
  if (latest.state==='queued'&&(latest.notionTarget||latest.kind==='image')) return {kind:'resume',sourceJobId:latest.id,message:'最新要求尚未开始。确认后只启动这一条，较早待办保留历史，不再执行。'};
  if (latest.notionTarget) return { kind: 'review_notion', message: '本轮不会自动重复写入。请核对 Notion 原页面；需要继续时在此任务提出新的修改要求，再确认启动。' };
  if(latest.kind==='image'&&latest.welcomeManual){const welcomeStep=latest.welcomeImageAttachmentId?'page':latest.welcomeManual.document?'image':'manual';return {kind:'review_image',welcomeStep,message:welcomeStep==='manual'?'说明还没有整理好，图片尚未生成。可以从这一步继续，不重跑其他任务。':welcomeStep==='image'?'说明已经整理好了，图片还没有交付。继续时会复用说明，只补后面的步骤。':'说明和图片都在。可以继续整理网页，不会重新画图。'};}
  if (latest.kind === 'image') return { kind: 'review_image', message: '请先查看本轮图片和用量记录。确需重新生成时，在主对话明确提出“重新生成图片”，将产生新用量。' };
  if (!['queued', 'failed', 'cancelled', 'interrupted'].includes(latest.state)) return { kind: 'none', message: '请刷新任务状态后查看下一步。' };
  return { kind: 'retry', sourceJobId: latest.id, message: '原话和附件仍在。重新处理只执行最新要求；较早待办保留在历史中。' };
}
