import type { Attachment, AttachmentSummary, Conversation, Database, ExecutionTask, Message } from './types.js';
import type { ChatOperation } from './chatOperations.js';
import { createHash } from 'node:crypto';
import { localExecutionResultId } from './executionService.js';
import { executionExplicitlyUnfinished } from './executionResultState.js';
import {artifactResultLinks} from './artifactLinks.js';
import {selectedNotionVerification} from './notionVerificationSelection.js';

export type TaskResultScope = { workspaceId: string; userId: string };
export type TaskResultOutcome = 'completed' | 'returned' | 'failed' | 'partial' | 'needs_input' | 'cancelled' | 'interrupted';
export type TaskResultReceipt = {
  /** Stable per-result identity; local executions include their round. */
  id: string; sourceId: string; source: 'cloud' | 'local'; taskId: string; title: string;
  outcome: TaskResultOutcome; state: TaskResultOutcome; summary: string; createdAt: string;
  /** Bounded plain-language briefing derived from the full owned result before clipping. */
  brief?: string;
  /** Attempt order is independent of when an old attempt later receives a terminal update. */
  attemptAt?: string;
  /** Presentation only: an already-captured previous round is not the active attempt. */
  previousAttempt?: boolean;
  resultMessageId?: string; imageUrl?: string; attachments: AttachmentSummary[];
  location?: string; notionUrl?: string; round?: number; reported: boolean; reviewed: boolean;
};
export type TaskResultLimits = { count?: number; summaryChars?: number; totalChars?: number };
/** One user-facing update per task; attempt/round history remains in storage. */
export function latestTaskResults(results: TaskResultReceipt[]) {
  const latest = new Map<string, TaskResultReceipt>();
  for (const result of results) {
    const previous = latest.get(result.taskId);
    if (!previous || (result.attemptAt??result.createdAt) > (previous.attemptAt??previous.createdAt)
      || (result.attemptAt??result.createdAt) === (previous.attemptAt??previous.createdAt) && result.createdAt >= previous.createdAt) latest.set(result.taskId, result);
  }
  return [...latest.values()];
}
/** Reading a detail page is not a main-chat briefing. Every terminal outcome must return once. */
export function automaticTaskResults(results: TaskResultReceipt[]) {
  return latestTaskResults(results).filter(result => !result.reported);
}
/** Server-internal snapshot, never accepted from a browser. Old local rounds require durable message evidence. */
export type TaskResultCapture = TaskResultScope & { result: TaskResultReceipt;
  localEvidence?: { messageId: string; createdAt: string; contentHash: string } };

export class TaskResultInboxError extends Error {
  constructor(message: string, readonly status = 403) { super(message); this.name = 'TaskResultInboxError'; }
}

const own = (record: TaskResultScope, scope: TaskResultScope) => record.workspaceId === scope.workspaceId && record.userId === scope.userId;
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const clip = (text: string | undefined, max: number) => (text ?? '').trim().slice(0, max);
// Never copy transport diagnostics, credentials, JSON/tool instructions or stack
// traces into an automatic reply. The full owned task retains its detailed text.
const technical = /(?:\b(?:MCP|HTTP|API|JSON|ECONN\w*|ETIMEDOUT|EPIPE|Bearer|api[_ -]?key|authorization|password|secret|token|stack|traceback|execution_unconfirmed)\b|feature_\d|stream disconnected|response\.completed|执行器|回执|验收证据|^工作位置[：:]|https?:\/\/[^\s]+[?&](?:key|token|secret)=|^\s*[{}]|^\s*at\s+\S+\s*\()/i;
function reportLine(line: string) {
  if (technical.test(line)) return '';
  return line.replace(/^\s*(?:#{1,6}\s*|[-*•]\s*|\d+[.、]\s*)/, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '').replace(/[*_`]/g, '').trim();
}
const briefHeading=/^(?:情况说明|需要你给我的一步|需要你补充|下一步|已保存到 Notion|【本机执行回执)(?:[：:\s]*|[（(].*)$/;
const taskButtonNavigation=/(?:任务(?:里|中|页|区)|按钮|点击|点[“"「『]?继续|开始处理最新要求|重新处理最新要求)/;
const nextAction=/(?:请(?:先|你|提供|补充|确认|发|核对|检查|选择)|(?:需要你|麻烦你)(?:补充|提供|确认|核对|检查|选择)|你可以|(?:把|将).{0,40}(?:发给我|告诉我|贴给我)|^(?:补充|提供|告诉我|确认|核对|检查|选择).{1,70})/;
function briefSentences(text:string){
  return text.split('\n').filter(line=>!/^\s*#{1,6}\s/.test(line)).map(reportLine).filter(line=>line&&!briefHeading.test(line)&&!/^(?:需要你给我的一步|需要你补充)/.test(line))
    .flatMap(line=>line.split(/(?<=[。！？!?；;])|(?<=[，,：:])(?=(?:请|你可以|需要你|麻烦你))/).map(value=>value.trim()).filter(Boolean));
}
function briefMaterialRequests(text:string){
  const result:string[]=[];
  let collecting=false;
  for(const raw of text.split('\n')){
    const line=reportLine(raw),heading=line.match(/^(?:需要你给我的一步|需要你补充)[：:\s]*(.*)$/);
    if(heading){collecting=true;if(heading[1])result.push(heading[1]);continue;}
    if(!collecting)continue;
    if(/^\s*#{1,6}\s/.test(raw)||!line&&result.length)break;
    if(line&&!taskButtonNavigation.test(line)&&!nextAction.test(line)&&!/^(?:已|还|本轮|这次|目前|由于|因为|尚|结果|草稿|任务|我)/.test(line))result.push(line);
    if(result.length>=2)break;
  }
  return result;
}
function repeatedBriefPart(value:string,existing:string[]){
  const normalize=(text:string)=>text.replace(/[\s\p{P}\p{S}]/gu,'');
  const candidate=normalize(value);
  return existing.some(item=>{
    const known=normalize(item);
    return candidate===known||Math.min(candidate.length,known.length)>=4&&(candidate.includes(known)||known.includes(candidate));
  });
}
function uniqueBriefParts(values:string[],previous:string[]=[]){
  const result:string[]=[];
  for(const value of values)if(!repeatedBriefPart(value,[...previous,...result]))result.push(value);
  return result;
}
function resultBrief(outcome: TaskResultOutcome, primary: string | undefined, content: string, error = '') {
  // A progress fallback is not evidence of what the user actually needs to
  // supply. Only this outcome prefers its concrete final request; partial
  // article bodies retain the existing progress-first summarization order.
  const concreteInput=outcome==='needs_input'&&briefSentences(content).some(line=>
    !taskButtonNavigation.test(line)&&(nextAction.test(line)||/(?:还缺|缺少|缺了|没有提供|尚未提供|需要补充).{1,80}/.test(line)));
  const raw = [concreteInput?undefined:primary, content, error].filter(Boolean).join('\n');
  const lines = uniqueBriefParts(briefSentences(raw));
  const materials=uniqueBriefParts(briefMaterialRequests(raw));
  const useful = lines.find(line => !/^(?:这次没能做完，原来的要求还在|这次还没做成，原来的要求还在|未取得可确认的结果|任务已结束，但没有可确认的结果)/.test(line)
    && !/已经做好，结果会保留.*还没做好/.test(line)&&!taskButtonNavigation.test(line));
  if (outcome === 'completed' || outcome === 'returned') {
    const summary=uniqueBriefParts(briefSentences(primary??'')).filter(line=>!taskButtonNavigation.test(line));
    return summary.length?clip(summary.slice(0,2).join(''),180)
      :useful?clip(lines.slice(lines.indexOf(useful),lines.indexOf(useful)+2).join(''),180):'结果已经返回，可以打开看看。';
  }
  if (outcome === 'cancelled') return '已经停下了；之前保存的内容还在，不会自动撤销或重新执行。';
  if (/here-document|(?:拒绝|无法|未能|不能)[^。\n]{0,20}(?:创建|写入)[^。\n]{0,20}临时文件|(?:命令执行|执行命令)[^。\n]{0,20}(?:失败|报错)/i.test(raw))
    return '本机保存这一步没成功；先核对目标文件，再继续未完成部分，原文件不会自动覆盖。';
  if (/没有找到能确认属于这一天|日期都?对不上|(?:缺少|没有|没找到|还没找到)[^。\n]{0,30}(?:那天|昨天|当日|所需日期)[^。\n]{0,30}(?:素材|记录|内容)|(?:昨天|那天)[^。\n]{0,50}(?:没有|没找到)/.test(raw))
    return '还没找到能确认属于所需日期的素材，正文还没写成。把那天的几句原话或相关记录发给我，就能接着写。';
  let reason=clip(lines.filter(line=>!taskButtonNavigation.test(line)&&!nextAction.test(line)&&!materials.includes(line)).slice(0,2).join(''),180);
  if (/stream disconnected|response\.completed|ECONN|timeout|连接中断|模型[^。\n]*(?:中断|未完整)/i.test(raw)) reason = '处理中连接中断了，还没拿到完整结果。';
  else if (/功能未开放|已下架|版本已变更|工具[^。\n]*(?:未授权|不可用|没就位)/.test(raw)) reason = '需要用到的功能暂时没接好，这次还没做成。';
  else if (/预算|电力不足|额度不足/.test(raw)) reason = '这次卡在可用电力或本次使用上限上，已有内容会保留。';
  else if (/输出[^。\n]*(?:限额|截断)|达到[^。\n]*(?:输出|限额)/.test(raw)) reason = '返回的内容被截短了，还不能当作完整成果。';
  if (!reason) reason = outcome === 'partial' ? '已有部分内容，但这件事还没有全部做好。' : outcome === 'needs_input' ? '还缺一些必要信息，这件事先停在这里。' : '这次还没做成，原要求和已有内容都保留了。';
  // Only actual actions/material requests belong in the next step. A whole
  // status paragraph or a legacy "click Continue" instruction is not user input.
  const materialRequest=materials.length?`请补充：${materials.map(value=>value.replace(/[。；;]$/,'')).join('、')}。`:'';
  const actions=uniqueBriefParts([...lines.filter(line=>nextAction.test(line)&&!taskButtonNavigation.test(line)),...(materialRequest?[materialRequest]:[])],briefSentences(reason));
  let continuation=clip(actions.slice(0,2).join(''),160);
  if(!continuation&&!/[？?]|(?:请|需要|你可以|把.{0,20}发给)/.test(reason))continuation='先核对已有内容后继续未完成部分就行，不用重发整个任务。';
  return clip([reason, continuation].filter(Boolean).join(''), 340);
}
function authorize(db: Database, scope: TaskResultScope) {
  if (!db.users.some(user => user.id === scope.userId && user.enabled)
    || !db.workspaces.some(workspace => workspace.id === scope.workspaceId && workspace.status === 'active')
    || !db.workspaceMembers.some(member => own(member, scope) && member.status !== 'disabled'))
    throw new TaskResultInboxError('账号或个人空间不可用');
}
function ownedTask(db: Database, scope: TaskResultScope, id: string | undefined) {
  return db.conversations.find(c => own(c, scope) && c.id === id && !c.coordinatorMain && !c.archived);
}
function marker(db: Database, scope: TaskResultScope, id: string) {
  return db.chatOperations?.find(o => own(o, scope) && o.id === `notice_${id}` && o.status === 'completed');
}
function publicFile(file: Attachment): AttachmentSummary {
  const { id, originalName, mimeType, kind, size, status } = file;
  return { id, originalName, mimeType, kind, size, status, ...(file.welcomeGuide ? { welcomeGuide: true } : {}),...(file.visualDocument?{visualDocument:true}:{}) };
}
function ownedFiles(db: Database, scope: TaskResultScope, task: Conversation, message: Message | undefined) {
  return (message?.attachments ?? []).flatMap(summary => {
    const file = db.attachments.find(a => own(a, scope) && a.id === summary.id
      && (a.conversationId === task.id || a.sharedConversationIds?.includes(task.id)));
    return file ? [publicFile(file)] : [];
  });
}
function localAttemptAt(db: Database, scope: TaskResultScope, task: ExecutionTask) {
  if(!(task.reportRound??0))return task.createdAt;
  const event=(db.executionEvents??[]).filter(e=>own(e,scope)&&e.taskId===task.id&&e.kind==='user_message'&&e.round===task.reportRound).at(-1);
  return event?.createdAt??task.deliveryAttempt?.issuedAt??task.startedAt??task.updatedAt;
}
/** Pick attempts before looking at terminal outcomes or report flags. A newer
 * queued/running/prepared attempt suppresses stale failure announcements. */
function latestAttemptSources(db:Database,scope:TaskResultScope){
  type Attempt={source:'cloud'|'local';sourceId:string;taskId:string;attemptAt:string;round?:number};
  const latest=new Map<string,Attempt>();
  const local=(db.executionTasks??[]).filter(t=>own(t,scope)&&ownedTask(db,scope,t.conversationId));
  const attempts:Attempt[]=(db.chatOperations??[]).filter(o=>own(o,scope)&&o.workRun&&ownedTask(db,scope,o.conversationId))
    // A prepared cloud handoff is the same attempt as its actual local run,
    // not an eternally active second job that can hide the local result.
    .filter(o=>o.workRun!.state!=='prepared'||!local.some(t=>t.conversationId===o.conversationId&&t.sourceMessageId===o.workRun!.inputMessageId))
    .map(o=>({source:'cloud',sourceId:o.id,taskId:o.conversationId!,attemptAt:o.createdAt}));
  attempts.push(...local.map(t=>({source:'local' as const,sourceId:t.id,taskId:t.conversationId,attemptAt:localAttemptAt(db,scope,t),round:t.reportRound??0})));
  for(const attempt of attempts){const previous=latest.get(attempt.taskId);if(!previous||attempt.attemptAt>=previous.attemptAt)latest.set(attempt.taskId,attempt);}
  return latest;
}
export function taskResultIsLatestAttempt(db:Database,scope:TaskResultScope,result:TaskResultReceipt){
  const latest=latestAttemptSources(db,scope).get(result.taskId);
  return latest?.source===result.source&&latest.sourceId===result.sourceId&&latest.round===result.round;
}
function cloudResult(db: Database, scope: TaskResultScope, operation: ChatOperation, max: number): TaskResultReceipt | undefined {
  const run = operation.workRun, task = ownedTask(db, scope, operation.conversationId);
  if (!run || !task || !terminal.has(run.state)||selectedNotionVerification(operation)||operation.status==='pending'&&run.failureCode==='notion_verification_pending'||run.notionReceipt?.state!=='verified'&&['scheduled','checking'].includes(run.notionReceipt?.verification?.state??'')) return;
  const result = task.messages.find(message => message.id === run.resultMessageId && message.role === 'assistant');
  const attachments = ownedFiles(db, scope, task, result);
  const imageFile = db.attachments.find(file => own(file, scope) && file.kind === 'image'
    && result?.imageUrl === `/api/attachments/${file.id}/content`
    && (file.conversationId === task.id || file.sharedConversationIds?.includes(task.id)));
  const imageUrl = imageFile ? `/api/attachments/${imageFile.id}/content` : undefined;
  const guideFile = run.welcomeGuide && attachments.find(summary => db.attachments.some(file => own(file, scope)
    && file.id === summary.id && file.kind === 'image' && file.status === 'ready' && file.welcomeGuide));
  if (imageFile && !attachments.some(a => a.id === imageFile.id)) attachments.push(publicFile(imageFile));
  let outcome: TaskResultOutcome = run.state === 'completed' ? (run.resultOutcome ?? 'returned')
    : run.state === 'failed' && (run.resultOutcome === 'partial' || run.resultOutcome === 'needs_input') ? run.resultOutcome
    : run.state as TaskResultOutcome;
  let summary = clip([run.userReport||run.error, result?.content].filter(Boolean).join('\n'), max);
  if (run.kind === 'image' && run.state === 'completed') {
    outcome = imageUrl || guideFile ? 'completed' : 'failed';
    if (!imageUrl && !guideFile) summary = '绘图任务没有返回可确认的图片，尚未完成。请查看本轮反馈，不会自动重做。';
  } else if (run.state === 'completed' && !result?.content.trim() && !attachments.length) {
    outcome = 'needs_input';
    summary = '任务已结束，但没有可确认的结果。请查看过程，不会自动重做。';
  }
  if (!summary) summary = outcome === 'cancelled' ? '本轮已停止，已产生的修改不会自动撤销。' : '未取得可确认的结果，请查看本轮反馈。';
  const receiptId=run.reportRevision?`${operation.id}_r${run.reportRevision}`:operation.id;
  return { id: receiptId, sourceId: operation.id, source: 'cloud', taskId: task.id, title: clip(task.title, 120),
    outcome, state: outcome, summary, brief: resultBrief(run.reportRevision?'returned':outcome, run.userReport, result?.content ?? summary, run.error), attemptAt:operation.createdAt, createdAt: run.reportRevisionAt??operation.updatedAt, resultMessageId: run.resultMessageId,
    imageUrl, attachments, notionUrl: run.notionReceipt?.state === 'verified' ? run.notionReceipt.url : run.notionReceipt?.verification?.state==='exhausted'&&/^[a-f0-9]{32}$/i.test(run.notionReceipt.pageId?.replaceAll('-','')??'')?`https://www.notion.so/${run.notionReceipt.pageId!.replaceAll('-','')}`:undefined,
    reported: Boolean(run.reportedToCoordinatorAt || marker(db, scope, receiptId)), reviewed: run.unread !== true };
}
function localResult(db: Database, scope: TaskResultScope, execution: ExecutionTask, max: number): TaskResultReceipt | undefined {
  const task = ownedTask(db, scope, execution.conversationId);
  if (!task || !terminal.has(execution.status)) return;
  const round = execution.reportRound ?? 0;
  const receiptId = execution.terminalReceipt?.round === round
    ? execution.terminalReceipt.receiptMessageId ?? `execution_receipt_${execution.id}_${round}`
    : `execution_receipt_${execution.id}_${round}`;
  const id = localExecutionResultId(execution.id, round, receiptId);
  const persisted = db.messages.find(m => own(m, scope) && m.conversationId === task.id && m.id === receiptId);
  const answer = execution.finalResponse?.trim() ?? '', error = execution.lastError?.trim() ?? '';
  const result = answer && error.startsWith(answer) ? error : error && answer.startsWith(error) ? answer : [error, answer].filter(Boolean).join('\n');
  let outcome: TaskResultOutcome = execution.status === 'completed' ? (answer ? 'returned' : 'needs_input')
    : execution.status as TaskResultOutcome;
  // A normal process exit is not proof of goal completion. Preserve the full
  // receipt, but don't promote an executor's explicit non-completion to success.
  if (outcome === 'returned' && executionExplicitlyUnfinished(answer)) outcome = 'needs_input';
  const reported = Boolean(marker(db, scope, id) || (execution.reportedToCoordinatorAt
    && (execution.reportedRound === round || execution.reportedRound === undefined && round === 0)));
  const summary = persisted?.content || result || '没有可确认的执行结果，请查看本轮过程。';
  return { id, sourceId: execution.id, source: 'local', taskId: task.id, title: clip(task.title, 120), outcome, state: outcome,
    summary: clip(outcome === 'cancelled' ? `本轮已停止，已产生的修改不会自动撤销。\n${summary}` : summary, max),
    brief: resultBrief(outcome, undefined, summary),
    attemptAt:localAttemptAt(db,scope,execution),
    createdAt: execution.terminalReceipt?.round === round ? execution.terminalReceipt.receivedAt : execution.completedAt ?? execution.updatedAt,
    resultMessageId: persisted?.id, attachments: [],
    location: clip(execution.targetName, 500) || undefined, round, reported, reviewed: execution.noticeReadRound === round };
}
function allResults(db: Database, scope: TaskResultScope, max: number) {
  authorize(db, scope);
  return [...(db.chatOperations ?? []).filter(o => own(o, scope)).flatMap(o => cloudResult(db, scope, o, max) ?? []),
    ...(db.executionTasks ?? []).filter(t => own(t, scope)).flatMap(t => localResult(db, scope, t, max) ?? [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function bounded(results: TaskResultReceipt[], limits: TaskResultLimits) {
  const count = Math.max(1, Math.min(limits.count ?? 6, 50));
  let chars = Math.max(100, Math.min(limits.totalChars ?? 6000, 30_000));
  const chosen: TaskResultReceipt[] = [];
  for (const result of results.slice(0, count)) {
    if (chars < 1) break;
    const summary = result.summary.slice(0, chars);
    chosen.push({ ...result, summary }); chars -= summary.length;
  }
  return chosen;
}
/** Read on the server before a dispatcher call. Returned content is evidence, never instructions or new authority. */
export function pendingTaskResults(db: Database, scope: TaskResultScope, limits: TaskResultLimits = {}) {
  return bounded(allResults(db, scope, Math.max(100, Math.min(limits.summaryChars ?? 1200, 6000))).filter(r => !r.reported), limits);
}
function reportMain(db:Database,scope:TaskResultScope){return db.conversations.find(c=>own(c,scope)&&c.coordinatorMain&&!c.archived);}
function initialReportSince(main:Conversation,now:string){
  return main.taskResultReportSince??main.messages.filter(m=>m.role==='user').at(-1)?.createdAt??now;
}
/** Call only inside Store.mutate. Existing task history is neither removed nor
 * marked reported; the one-time origin only prevents legacy backlog flooding. */
export function initializeTaskResultReporting(db:Database,scope:TaskResultScope,now=new Date().toISOString()){
  authorize(db,scope);const main=reportMain(db,scope);if(!main)return;
  main.taskResultReportSince??=initialReportSince(main,now);return main.taskResultReportSince;
}
function currentTaskResultReceipts(db: Database, scope: TaskResultScope, limits: TaskResultLimits) {
  const latest=latestAttemptSources(db,scope);
  return allResults(db,scope,Math.max(100,Math.min(limits.summaryChars??1200,6000)))
    .filter(result=>{const attempt=latest.get(result.taskId);return attempt?.source===result.source&&attempt.sourceId===result.sourceId&&attempt.round===result.round;});
}
export function pendingConversationTaskResults(db: Database, scope: TaskResultScope, limits: TaskResultLimits = {}) {
  authorize(db,scope);
  const main=reportMain(db,scope);if(!main)return [];
  const since=Date.parse(initialReportSince(main,new Date().toISOString()));
  return bounded(currentTaskResultReceipts(db,scope,limits).filter(result=>!result.reported&&Date.parse(result.createdAt)>=since).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id)),limits);
}
/** Notification bubbles describe the current attempt, not every historical failure. */
export function visibleTaskResultReceipts(db:Database,scope:TaskResultScope,limits:TaskResultLimits={}){
  authorize(db,scope);
  const main=reportMain(db,scope);if(!main)return [];
  const since=Date.parse(initialReportSince(main,new Date().toISOString()));
  return bounded(currentTaskResultReceipts(db,scope,limits).filter(result=>(!result.reported||!result.reviewed)&&Date.parse(result.createdAt)>=since),limits);
}
/** The review badge persists after a result was reported in the main conversation. */
export function unreviewedTaskResults(db: Database, scope: TaskResultScope, limits: TaskResultLimits = {}) {
  return bounded(allResults(db, scope, Math.max(100, Math.min(limits.summaryChars ?? 1200, 6000))).filter(r => !r.reviewed), limits);
}

export function captureTaskResults(db: Database, scope: TaskResultScope, ids: string[]): TaskResultCapture[] {
  const wanted = new Set(ids);
  return allResults(db, scope, 1200).filter(result => wanted.has(result.id) && !result.reported).map(result => {
    const persisted = result.source === 'local' && result.resultMessageId
      ? db.messages.find(message => own(message, scope) && message.conversationId === result.taskId && message.role === 'assistant' && message.id === result.resultMessageId) : undefined;
    return { ...scope, result: structuredClone(result), ...(persisted ? { localEvidence: { messageId: persisted.id,
      createdAt: persisted.createdAt, contentHash: createHash('sha256').update(persisted.content).digest('hex') } } : {}) };
  });
}

/** Validate captured evidence against owned storage. A restarted execution cannot erase an already-read old receipt. */
export function capturedTaskResultsForReport(db: Database, scope: TaskResultScope, captures: TaskResultCapture[]) {
  const current = new Map(allResults(db, scope, 1200).map(result => [result.id, result]));
  return captures.flatMap(capture => {
    if (!own(capture, scope)) return [];
    const result = capture.result, latest = current.get(result.id);
    if (latest && latest.source === result.source && latest.sourceId === result.sourceId && latest.taskId === result.taskId
      && latest.round === result.round) return latest.reported ? [] : [latest];
    if (result.source !== 'local' || !Number.isInteger(result.round) || result.round! < 0 || result.imageUrl || result.attachments.length) return [];
    const task = db.executionTasks.find(task => own(task, scope) && task.id === result.sourceId && task.conversationId === result.taskId);
    const expectedMessage = result.resultMessageId;
    const prefix = `execution_receipt_${result.sourceId}_${result.round}`;
    const validMessage = expectedMessage === prefix || Boolean(expectedMessage?.startsWith(`${prefix}_recovery_`)
      && /^[a-f0-9]{24}$/.test(expectedMessage.slice(`${prefix}_recovery_`.length)));
    const evidence = capture.localEvidence;
    if (!task || (task.reportRound ?? 0) < result.round! || !validMessage
      || result.id !== localExecutionResultId(result.sourceId, result.round!, expectedMessage)
      || !evidence || evidence.messageId !== expectedMessage || !ownedTask(db, scope, result.taskId) || marker(db, scope, result.id)) return [];
    const persisted = db.messages.find(message => own(message, scope) && message.conversationId === result.taskId
      && message.id === expectedMessage && message.role === 'assistant');
    if (!persisted || persisted.createdAt !== evidence.createdAt
      || createHash('sha256').update(persisted.content).digest('hex') !== evidence.contentHash
      || result.summary !== persisted.content.trim().slice(0, result.summary.length)) return [];
    return [{ ...result, reported: false, reviewed: task.noticeReadRound === result.round }];
  });
}

/** Exact receipt IDs tied to an owned saved reply, including already-reviewed results. */
export function taskResultIdsReportedInMessage(db: Database, scope: TaskResultScope, messageId: string | undefined) {
  authorize(db, scope);
  if (!messageId || !db.conversations.some(c => own(c, scope) && c.coordinatorMain && !c.archived
    && c.messages.some(m => m.id === messageId && m.role === 'assistant'))) return [];
  const current = allResults(db, scope, 100).filter(result => {
    if (marker(db, scope, result.id)?.assistantMessageId === messageId) return true;
    if (result.source === 'cloud') return db.chatOperations?.find(o => own(o, scope) && o.id === result.sourceId)?.workRun?.reportMessageId === messageId;
    const task = db.executionTasks.find(t => own(t, scope) && t.id === result.sourceId);
    return task?.reportMessageId === messageId && (task.reportedRound === result.round || task.reportedRound === undefined && result.round === 0);
  }).map(result => result.id);
  const historical = (db.chatOperations ?? []).filter(operation => own(operation, scope) && operation.status === 'completed'
    && operation.requestId === 'result_notice' && operation.id.startsWith('notice_') && operation.assistantMessageId === messageId
    && db.conversations.some(main => own(main, scope) && main.coordinatorMain && !main.archived && main.id === operation.conversationId)
    && ownedTask(db, scope, operation.dispatchedTaskId)).map(operation => operation.id.slice('notice_'.length));
  return [...new Set([...current, ...historical])].slice(-10);
}

/** Model-facing feedback omits storage/operation IDs; its immutable IDs stay server-side for reporting. */
export function taskResultConversationContext(results: TaskResultReceipt[]) {
  return results.map(result => ({ title: result.title, outcome: result.outcome,
    summary: result.summary.replace(/^【本机执行回执[^\n]*】\s*\n?/, ''),
    taskUrl: `/?task=${encodeURIComponent(result.taskId)}`, imageUrl: result.imageUrl,
    location: result.location, notionUrl: result.notionUrl,
    attachments: result.attachments.map(file => ({ name: file.originalName, kind: file.kind,
      ...artifactResultLinks(file.id,Boolean(file.visualDocument||file.welcomeGuide)) })) }));
}

/** Call in the same transaction as saving the dispatcher answer. Only the captured result IDs are marked. */
export function markTaskResultsReported(db: Database, scope: TaskResultScope, input: { ids: string[]; assistantMessageId: string; mainConversationId?: string; timestamp?: string; captures?: TaskResultCapture[] }) {
  authorize(db, scope);
  const main = db.conversations.find(c => own(c, scope) && c.coordinatorMain && !c.archived && (!input.mainConversationId || c.id === input.mainConversationId));
  if (!main?.messages.some(m => m.id === input.assistantMessageId && m.role === 'assistant')) throw new TaskResultInboxError('调度回复尚未保存，结果没有被标为已汇报', 409);
  const selected = new Set(input.ids), timestamp = input.timestamp ?? new Date().toISOString();
  const results = [...new Map([...allResults(db, scope, 1200), ...capturedTaskResultsForReport(db, scope, input.captures ?? [])]
    .map(result => [result.id, result])).values()].filter(result => selected.has(result.id) && !result.reported);
  for (const result of results) {
    if (result.source === 'cloud') {
      const run = db.chatOperations!.find(o => own(o, scope) && o.id === result.sourceId)!.workRun!;
      run.reportedToCoordinatorAt = timestamp; run.reportMessageId = input.assistantMessageId;
    } else {
      const task = db.executionTasks.find(t => own(t, scope) && t.id === result.sourceId)!;
      if ((task.reportRound ?? 0) === result.round && localResult(db, scope, task, 1200)?.id === result.id) {
        task.reportedToCoordinatorAt = timestamp; task.reportMessageId = input.assistantMessageId; task.reportedRound = result.round;
      }
    }
    db.chatOperations ??= [];
    db.chatOperations.push({ id: `notice_${result.id}`, ...scope, operationId: `notice_${result.id}`, payloadHash: 'result-reference',
      requestId: 'result_notice', status: 'completed', conversationId: main.id, dispatchedTaskId: result.taskId,
      assistantMessageId: input.assistantMessageId, createdAt: timestamp, updatedAt: timestamp });
    for (const summary of result.attachments) {
      const file = db.attachments.find(a => own(a, scope) && a.id === summary.id);
      if (file) file.sharedConversationIds = [...new Set([...(file.sharedConversationIds ?? []), main.id])];
    }
  }
  return results;
}

const labels: Record<TaskResultOutcome, string> = {
  completed: '已完成', returned: '已返回结果，待你查看', failed: '未完成', partial: '部分结果已返回，需要核对',
  needs_input: '需要你确认', cancelled: '已停止', interrupted: '结果尚未确认',
};
/** Short facts, not another paid model turn. Reuses the worker's own progress summary where available. */
export function taskResultReportContent(results: TaskResultReceipt[]) {
  return latestTaskResults(results).map(result => `${result.previousAttempt?'上一轮的「'+result.title+'」':result.title}：${labels[result.outcome]}。${result.brief ?? resultBrief(result.outcome, undefined, result.summary)}\n[查看这件事](/?task=${encodeURIComponent(result.taskId)})${result.notionUrl ? ` · [打开 Notion](${result.notionUrl})` : ''}`).join('\n\n');
}
export function taskReportReplyPending(db: Database, scope: TaskResultScope) {
  const mainIds = new Set(db.conversations.filter(c => own(c, scope) && c.coordinatorMain && !c.archived).map(c => c.id));
  return db.chatOperations?.some(o => own(o, scope) && o.status === 'pending'
    && (o.requestId.startsWith('coord_') || !o.workRun && Boolean(o.conversationId && mainIds.has(o.conversationId)))) === true;
}
/** Same-transaction, idempotent delivery. An active dispatcher owns the next reply instead. */
export function appendTaskResultReport(db: Database, scope: TaskResultScope, input: { ids?: string[]; assistantMessageId?: string; content?: string; mainConversationId?: string; timestamp?: string } = {}) {
  authorize(db, scope);
  if(!input.ids)initializeTaskResultReporting(db,scope,input.timestamp);
  if (taskReportReplyPending(db, scope))
    return { deferred: true, results: [] as TaskResultReceipt[], messageId: undefined };
  const main = db.conversations.find(c => own(c, scope) && c.coordinatorMain && !c.archived && (!input.mainConversationId || c.id === input.mainConversationId));
  if (!main) return { deferred: false, results: [] as TaskResultReceipt[], messageId: undefined };
  const wanted = input.ids ? new Set(input.ids) : undefined;
  const pending = wanted?pendingTaskResults(db, scope, { count: 50, totalChars: 30_000 }).filter(r => wanted.has(r.id))
    :pendingConversationTaskResults(db,scope,{count:50,totalChars:30_000});
  const results = latestTaskResults(pending).slice(0, 10), selectedTasks = new Set(results.map(result => result.taskId));
  if (!results.length) return { deferred: false, results, messageId: undefined };
  const messageId = input.assistantMessageId ?? `report_${results[0].id}`, timestamp = input.timestamp ?? new Date().toISOString();
  if (!main.messages.some(m => m.id === messageId)) {
    const singleImage = results.length === 1 && results[0].imageUrl;
    const message: Message = { id: messageId, role: 'assistant', createdAt: timestamp,
      content: input.content ?? taskResultReportContent(results),
      ...(singleImage ? { imageUrl: results[0].imageUrl, attachments: results[0].attachments }
        : { attachments: results.flatMap(result => result.attachments.filter(file => file.welcomeGuide||file.visualDocument)) }) };
    main.messages.push(message); main.updatedAt = timestamp;
    db.messages.push({ ...message, id: messageId, ...scope, conversationId: main.id, attachmentIds: message.attachments?.map(a => a.id) });
  }
  markTaskResultsReported(db, scope, { ids: pending.filter(result => selectedTasks.has(result.taskId)).map(r => r.id), assistantMessageId: messageId, mainConversationId: main.id, timestamp });
  return { deferred: false, results, messageId };
}

/** Viewing the result clears review badges, without pretending ONE already reported it. Validate all IDs before mutation. */
export function acknowledgeTaskResults(db: Database, scope: TaskResultScope, ids: string[], timestamp = new Date().toISOString()) {
  authorize(db, scope);
  const all = allResults(db, scope, 100), selected = new Set(ids);
  if (ids.some(id => !all.some(result => result.id === id))) throw new TaskResultInboxError('结果不存在', 404);
  for (const result of all.filter(r => selected.has(r.id))) {
    if (result.source === 'cloud') {
      const run = db.chatOperations!.find(o => own(o, scope) && o.id === result.sourceId)!.workRun!;
      run.unread = false; run.reviewedAt = timestamp;
    } else {
      const task = db.executionTasks.find(t => own(t, scope) && t.id === result.sourceId)!;
      task.noticeReadRound = result.round;
    }
  }
}

/** Capture all currently visible terminal results in this transaction, never future rounds or running work. */
export function acknowledgeAllTaskResults(db: Database, scope: TaskResultScope, timestamp = new Date().toISOString()) {
  const ids = allResults(db, scope, 100).filter(result => !result.reviewed).map(result => result.id);
  acknowledgeTaskResults(db, scope, ids, timestamp);
  return { ids, count: ids.length };
}
