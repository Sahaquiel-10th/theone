export type NotionVerificationView = {state:'scheduled'|'checking'|'exhausted';version:number;attempt:number;nextCheckAt?:string;deadlineAt?:string;lastReason?:'read_failed'|'mismatch'|'incomplete'|'authorization'|'stale'|'no_page'};
/** Public display fields only: never expose a server verification lease. */
export type NotionReceiptView = {state:string;url?:string;error?:string;delivery?:string;verification?:NotionVerificationView};
export const notionVerificationActive=(receipt?:NotionReceiptView)=>Boolean(receipt&&receipt.state!=='verified'&&!['not_sent','rejected'].includes(receipt.delivery??'')&&['scheduled','checking'].includes(receipt.verification?.state??''));
export function notionVerificationPresentation(receipt:NotionReceiptView,reviewWorkflow=false){
 const verification=receipt.verification,active=notionVerificationActive(receipt);
 if(receipt.state==='verified')return {active:false,canVerify:reviewWorkflow,message:reviewWorkflow?'Notion 内容已核对，任务步骤仍需核对；不会重新写入。':'Notion 保存结果已回读核对。'};
 if(receipt.delivery==='not_sent')return {active:false,canVerify:false,message:'这次保存还没有发出。请先检查 Notion 的连接和权限，再告诉我继续；不会自动重发保存请求。'};
 if(receipt.delivery==='rejected')return {active:false,canVerify:false,message:'Notion 没有接受这次保存。请先检查连接和权限，再告诉我继续；不会自动重发保存请求。'};
 if(active)return {active,canVerify:false,message:verification?.state==='checking'
  ?'正在读取 Notion 原页面，核对刚才是否保存成功；不会重复写入。你可以继续聊天。'
  :'Notion 的保存结果还在核对中。ONE Key 保持连接时会稍后再读原页面，不会重写；你可以继续聊天。'};
 if(verification?.state==='exhausted'){
  if(verification.lastReason==='authorization')return {active:false,canVerify:false,message:'Notion 连接或授权需要确认，自动核对已停下。请到“设置 → 知识连接”检查 Notion；原保存请求不会重发。'};
  if(verification.lastReason==='stale')return {active:false,canVerify:false,message:'保存位置或任务要求已经变化，自动核对已停下。先查看原页面；不会按旧要求重新写入。'};
  if(verification.lastReason==='no_page'||!receipt.url)return {active:false,canVerify:false,message:'暂时还没拿到这次保存的页面入口，自动核对已停下。请在 Notion 检查原保存位置；不会新建替代文档。'};
  return {active:false,canVerify:true,message:verification.lastReason==='mismatch'
   ?'原页面与这次拟保存的内容不同，自动核对已停下。先打开原页面看看；不会覆盖或重复保存。'
   :'这次还没核对到完整的 Notion 保存结果，自动核对已暂时停下。可以查看原页面，或只读核对一次，不会重写。'};
 }
 return {active:false,canVerify:Boolean(receipt.url),message:'Notion 保存结果还没确认。先查看原页面，必要时可以只读核对；不会重写。'};
}
export type TaskRecovery = { kind: 'retry' | 'resume' | 'review_image' | 'review_notion' | 'review_local' | 'reconciling' | 'none'; message: string; sourceJobId?: string; welcomeStep?:'manual'|'image'|'page' };

/** An earlier unresolved write must not disappear behind a verified receipt.
 * Callers pass chronological, owner-scoped jobs; no authorization is granted here. */
export function notionReceiptForReview<T extends {notionReceipt?: NotionReceiptView}>(jobs: T[]) {
  const receipts=jobs.filter(job=>job.notionReceipt);
  return receipts.filter(job=>job.notionReceipt!.state!=='verified'&&!['not_sent','rejected'].includes(job.notionReceipt!.delivery??'')).at(-1)
    ??receipts.filter(job=>job.notionReceipt!.state!=='verified').at(-1)??receipts.at(-1);
}

/** A terminal job can retain an old workflow projection after readback. This
 * exposes only the existing read-only endpoint; the server still proves every
 * checkpoint before repairing progress, and never starts another step. */
export function notionWorkflowNeedsReview(jobs:{state:string;notionReceipt?:NotionReceiptView;workflow?:{phase:string}}[]){
 const job=notionReceiptForReview(jobs);
 return Boolean(job&&['completed','failed'].includes(job.state)&&job.notionReceipt?.state==='verified'&&job.workflow&&job.workflow.phase!=='completed');
}

/** Only offer a first start for the saved latest handoff, never for an
 * existing/uncertain execution. Server authorization remains mandatory. */
export function unstartedLocalInput<T extends {id?:string;role:string}>(
  conversationId:string,
  jobs:{state:string;inputMessageId:string;dependencyBlocked?:boolean;dependenciesReady?:boolean;waitingFor?:unknown[]}[],
  messages:T[],
  executions:{conversationId:string;sourceMessageId:string}[],
) {
  const latest=jobs.at(-1);
  if(!latest||!latest.inputMessageId||latest.state!=='prepared'||latest.dependencyBlocked||latest.dependenciesReady===false||latest.waitingFor?.length&&latest.dependenciesReady!==true)return undefined;
  if(executions.some(task=>task.conversationId===conversationId&&task.sourceMessageId===latest.inputMessageId))return undefined;
  return messages.find(message=>message.id===latest.inputMessageId&&message.role==='user');
}

/** A recovery action follows the persisted latest job, not a guessed UI state. */
export function taskRecovery(jobs: { id: string; state: string; kind?: string;failureCode?:string;verificationPending?:boolean;steps?:{effect:string;state:string;tool?:string}[];dependencyBlocked?:boolean;dependsOnOperationIds?:string[]; notionTarget?: unknown; notionReceipt?: NotionReceiptView;welcomeManual?:{document?:unknown};welcomeImageAttachmentId?:string }[]): TaskRecovery {
  const latest = jobs.at(-1);
  if (!latest) return { kind: 'none', message: '原话仍在，请核对已有结果后发送新的要求。' };
  if(latest.state==='cancelled'&&latest.dependsOnOperationIds?.length)return {kind:'none',message:'前面的任务停下后，这一项也停下了。想继续的话，在这里补充新的要求就好，不会自己重新开始。'};
  if(latest.dependencyBlocked)return {kind:'none',message:'先继续前面卡住的任务。它做好后，这一项会接着处理，不用重新交代。'};
  if (jobs.some(job => job.state === 'running')) return { kind: 'none', message: '本轮仍在处理，请查看进展或停止，暂不重复启动。' };
  if(latest.verificationPending)return {kind:'reconciling',message:latest.notionReceipt?.state==='verified'?'保存已经核对，正在整理结果；不用再次开始。':'正在整理 Notion 的保存核对结果；不用再次开始。'};
  const checking=jobs.filter(job=>notionVerificationActive(job.notionReceipt)).at(-1)?.notionReceipt;
  if(checking)return {kind:'reconciling',message:notionVerificationPresentation(checking).message};
  // A failed external write intentionally leaves its checkpoint unresolved.
  // Prefer the specific Notion readback path over a generic dead-end notice.
  const unresolved=jobs.filter(job=>job.notionReceipt&&job.notionReceipt.state!=='verified'&&!['not_sent','rejected'].includes(job.notionReceipt.delivery||'')).at(-1)?.notionReceipt;
  if(unresolved)return {kind:'review_notion',message:notionVerificationPresentation(unresolved).message};
  // This diagnostic is emitted before processing any tool in a truncated turn.
  // Only an explicitly recorded empty checkpoint list proves that no earlier
  // turn started an effect. Missing legacy records are not proof of no write.
  const truncatedBeforeTools=latest.state==='failed'&&latest.failureCode==='task_tool_instruction_incomplete'&&!latest.notionReceipt&&Array.isArray(latest.steps)&&latest.steps.length===0;
  // The current worker records a checkpoint before every effect and a receipt
  // before sending a Notion write. An explicit Key failure with both records
  // absent is admission-only, not an uncertain save. Legacy missing step lists
  // and any earlier unresolved receipt must still stay protected.
  const keyFailedBeforeTools=latest.state==='failed'&&latest.failureCode==='task_key_required'&&!latest.notionReceipt&&Array.isArray(latest.steps)&&latest.steps.length===0;
  const onlyDocumentReads=!latest.notionReceipt&&Array.isArray(latest.steps)&&latest.steps.length>0&&latest.steps.every(s=>s.tool==='read_notion_document'&&s.effect==='read');
  const knownNotWritten=latest.notionTarget&&(['not_sent','rejected'].includes(latest.notionReceipt?.delivery||'')||truncatedBeforeTools||keyFailedBeforeTools||onlyDocumentReads);
  if(latest.steps?.some(s=>s.state==='started'&&['artifact','external_write'].includes(s.effect)&&!(knownNotWritten&&s.tool==='save_notion_draft')))return {kind:'none',message:'有份文件是否保存好还没确认。先看看已有成果；需要继续时补充要求，ONE 会先核对，不会盲目重复保存。'};
  if (latest.state === 'prepared') return { kind: 'review_local', message: '请先查看本机执行回执；确认已完成的修改后，再从本机执行入口继续。' };
  if (latest.state === 'completed') return { kind: 'none', message: '最新一轮已有结果，请查看结果或提出新的修改要求。' };
  if (latest.state==='queued'&&(latest.notionTarget||latest.kind==='image')) return {kind:'resume',sourceJobId:latest.id,message:'最新要求尚未开始。确认后只启动这一条，较早待办保留历史，不再执行。'};
  if (latest.notionTarget&&!knownNotWritten) return { kind: 'review_notion', message: '本轮不会自动重复写入。请核对 Notion 原页面；需要继续时在此任务提出新的修改要求，再确认启动。' };
  if(latest.kind==='image'&&latest.welcomeManual){const welcomeStep=latest.welcomeImageAttachmentId?'page':latest.welcomeManual.document?'image':'manual';return {kind:'review_image',welcomeStep,message:welcomeStep==='manual'?'说明还没有整理好，图片尚未生成。可以从这一步继续，不重跑其他任务。':welcomeStep==='image'?'说明已经整理好了，图片还没有交付。继续时会复用说明，只补后面的步骤。':'说明和图片都在。可以继续整理网页，不会重新画图。'};}
  if (latest.kind === 'image') return { kind: 'review_image', message: '请先查看本轮图片和用量记录。确需重新生成时，在主对话明确提出“重新生成图片”，将产生新用量。' };
  if (!['queued', 'failed', 'cancelled', 'interrupted'].includes(latest.state)) return { kind: 'none', message: '请刷新任务状态后查看下一步。' };
  return { kind: 'retry', sourceJobId: latest.id, message: '原话和附件仍在。重新处理只执行最新要求；较早待办保留在历史中。' };
}
