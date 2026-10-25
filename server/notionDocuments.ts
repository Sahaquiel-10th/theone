import crypto from 'node:crypto';
import type { Store } from './db.js';
import type { Database } from './types.js';
import type { WorkScope } from './coordinatorService.js';
import type { WorkRun } from './coordinatorTypes.js';
import { OrchestrationInputError, type OrchestrationTool } from './taskOrchestrator.js';
import { CoordinatorError } from './executorProfiles.js';
import { featureMember } from './featureRuns.js';
import { NotionWriteError, type NotionMcpService } from './knowledge/notionMcpService.js';
import {parseNotionPageLink} from '../src/notionPageLink.js';
import {freshDocumentReadRequested} from './executionIntent.js';
import {taskStepKey} from './taskSteps.js';
import {notionHash as hash,legacyNotionNormalized as normalized,canonicalNotionDigest} from './notionCanonical.js';

const readOnlyRequest=(text:string)=>freshDocumentReadRequested(text)&&/只读|(?:不|不要)(?:修改|保存|写入)/.test(text);

export class NotionDocumentError extends CoordinatorError {}
class NotionPreflightError extends NotionDocumentError {}
class NotionVerificationChanged extends Error {}
const sameTitleCheckRequested=(request:string)=>/同名|不重复(?:新建|创建)|(?:已有|已存在)[^\n。；]{0,30}(?:核对|检查)/.test(request);
/** Child-page entries in a complete fetch of the exact selected parent only.
 * Workspace search is deliberately not evidence of absence in this folder. */
function childPages(value:unknown):{id:string;title:string}[]{
  const v=resultData(value),raw=typeof v?.text==='string'?v.text:'';
  const sections=[...raw.matchAll(/<content>([\s\S]*?)<\/content>/g)];
  if(v?.truncated||v?.unknown_block_count||v?.unknown_block_ids?.length||sections.length!==1||raw.length>60000||/<unknown\b/i.test(raw))
    throw new NotionPreflightError('保存位置还没完整读到，先不新建，免得出现重复文档。');
  const body=sections[0][1],entries=[...body.matchAll(/<page\s+url="([^"]+)"[^>]*>([\s\S]*?)<\/page>/g)];
  if((body.match(/<page\b/g)||[]).length!==entries.length)
    throw new NotionPreflightError('保存位置的页面列表还没核对清楚，先不重复新建。');
  return entries.map(m=>{
    const title=m[2].trim();
    // Do not infer absence from a title whose rendering we cannot compare.
    if(/[<&\\`\n]/.test(title))throw new NotionPreflightError('保存位置里有标题暂时无法准确核对，先不重复新建。');
    return {id:notionPageId(m[1]),title};
  });
}
export function notionPageId(value: unknown): string {
  const parsed=parseNotionPageLink(value);
  if(parsed.error)throw new NotionDocumentError(parsed.error,400);
  return parsed.pageId!;
}
function resultData(value: unknown): any {
  if (!value || typeof value !== 'object') return value;
  const v = value as any;
  if (v.structuredContent) return v.structuredContent;
  if (Array.isArray(v.content)) {
    const text = v.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    try { return JSON.parse(text); } catch { return { text }; }
  }
  return v;
}
export function notionBody(value: unknown): string {
  const v = resultData(value);
  if (v?.truncated || v?.unknown_block_count || v?.unknown_block_ids?.length) throw new NotionDocumentError('页面内容未完整读到，请缩小文档范围；没有修改原文');
  const raw = typeof v?.text === 'string' ? v.text : typeof v?.content === 'string' ? v.content : '';
  // Official fetch wraps enhanced Markdown inside <content>; never confuse
  // properties/path/children metadata with the article body.
  const wrapped = raw.match(/<content>([\s\S]*?)<\/content>/);
  // Drop at most the wrapper's framing newline, never code indentation.
  const body = wrapped ? wrapped[1].replace(/^\r?\n/,'').replace(/\r?\n$/,'') : raw;
  if (!body.trim() || body.length > 60000) throw new NotionDocumentError('页面正文无法完整读取，请检查页面权限或缩小范围');
  return body;
}
type Receipt=NonNullable<WorkRun['notionReceipt']>;
type VerificationResult={operationId:string;conversationId:string;state:'verified'|'scheduled'|'exhausted'|'blocked'};
type VerificationOptions={now?:()=>number;delays?:number[];deadlineMs?:number;leaseMs?:number};
const sameReceipt=(a:Receipt,b:Receipt)=>['pageId','asyncTaskId','expectedDigest','expectedCanonicalDigest','canonicalVersion','checkpointKey','final'].every(key=>a[key as keyof Receipt]===b[key as keyof Receipt]);
const mayHaveWritten=(receipt?:Receipt)=>Boolean(receipt&&(receipt.state==='verified'||receipt.delivery==='unknown'||receipt.state==='uncertain'&&!['not_sent','rejected'].includes(receipt.delivery??'')));
function quotedReplacement(request: string) {
  // Only an unambiguous, explicitly quoted replacement in the real user turn.
  // General rewrites and multi-edit requests remain model-led, not regex plans.
  const matches=[...request.matchAll(/(?:把|将)[^“「"\n]{0,24}(?:“([^”\n]{1,4000})”|「([^」\n]{1,4000})」|"([^"\n]{1,4000})")\s*(?:精确|逐字)?(?:改为|改成|替换为|替换成)\s*(?:“([^”\n]{1,4000})”|「([^」\n]{1,4000})」|"([^"\n]{1,4000})")/g)];
  if(matches.length!==1)return undefined;
  const m=matches[0];return {old:m[1]??m[2]??m[3],replacement:m[4]??m[5]??m[6]};
}
function safeArticle(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 50000) throw new NotionDocumentError('文章正文应为 1–50000 字符', 400);
  if (/<\/?(?:page|database|folder|synced_block|synced_block_reference|custom-block|meeting-notes|unknown)\b/i.test(value)) throw new NotionDocumentError('文章不能包含移动页面或修改关联内容的结构标签', 400);
  return value;
}
export function writingTarget(db: Database, s: WorkScope) {
  featureMember(db, s);
  const connection = db.knowledgeConnections.find(c => c.workspaceId === s.workspaceId && c.provider === 'notion' && c.status === 'connected');
  const grant = connection?.notionWriting;
  if (!connection || !grant || grant.userId !== s.userId) throw new NotionDocumentError('请先在知识连接中重新授权 Notion：新增创建草稿和修改 ONE 草稿权限', 428);
  if (!grant.parentId) throw new NotionDocumentError('请先在 Notion 连接中选择草稿保存页面', 428);
  return { connectionId: connection.id, grantId: grant.grantId, parentId: grant.parentId, referenceIds: [...(grant.referenceIds || [])] };
}
export class NotionDocuments {
  private creationChecks=new Set<string>();
  constructor(private store: Store, private mcp: NotionMcpService,private verificationOptions:VerificationOptions={}) {}
  private now(){return this.verificationOptions.now?.()??Date.now();}
  private delays(){return this.verificationOptions.delays??[2_000,8_000,20_000];}
  private schedule(receipt:Receipt,immediate=false){
    const now=this.now();return {state:'scheduled' as const,version:Math.max(now,(receipt.verification?.version??0)+1),attempt:0,nextCheckAt:new Date(now+(immediate?0:this.delays()[0])).toISOString(),deadlineAt:new Date(now+(this.verificationOptions.deadlineMs??300_000)).toISOString()};
  }
  async settings(s: WorkScope) {
    const db = await this.store.read(); featureMember(db, s);
    const c = db.knowledgeConnections.find(c => c.workspaceId === s.workspaceId && c.provider === 'notion' && c.status === 'connected');
    const grant = c?.notionWriting?.userId === s.userId ? c.notionWriting : undefined;
    return { connected: Boolean(c), writeAuthorized: Boolean(grant), ready: Boolean(grant?.parentId), parentId: grant?.parentId || '', referenceIds: grant?.referenceIds || [] };
  }
  async configure(s: WorkScope, input: { parent?: unknown; references?: unknown }) {
    const db = await this.store.read(); featureMember(db, s);
    const c = db.knowledgeConnections.find(c => c.workspaceId === s.workspaceId && c.provider === 'notion' && c.status === 'connected');
    if (!c?.notionWriting || c.notionWriting.userId !== s.userId) throw new NotionDocumentError('请先重新授权 Notion 写入', 428);
    const parentId = notionPageId(input.parent);
    if (!Array.isArray(input.references) || input.references.length > 5) throw new NotionDocumentError('最多选择五篇参考文章', 400);
    const referenceIds = [...new Set(input.references.map((value,index)=>{
      try{return notionPageId(value);}catch(error){throw new NotionDocumentError(`第 ${index+1} 篇参考文章：${error instanceof NotionDocumentError?error.message:'链接没识别出来，请重新复制。'}`,400);}
    }))];
    // Verify access now. These are user-selected pages, not a background sync.
    try {
      const parent = resultData(await this.mcp.readDocument(s.workspaceId, parentId));
      if (parent?.type === 'database' || (/<database\b/.test(parent?.text || '') && !/<page\b/.test(parent?.text || ''))) throw new NotionDocumentError('链接识别到了，不过这是数据库。先在 Notion 新建一个普通页面（比如“ONE 草稿”），再复制它的链接。', 400);
      for (const id of referenceIds) notionBody(await this.mcp.readDocument(s.workspaceId, id));
    } catch (error) { throw error instanceof NotionDocumentError ? error : new NotionDocumentError('链接识别到了，但当前 Notion 连接还没能读到这个页面。请确认页面属于已连接的账号和工作区，并检查连接状态后再试；不用把页面设为公开。原保存位置没变。'); }
    await this.store.mutate(d => {
      featureMember(d, s);
      const current = d.knowledgeConnections.find(item => item.id === c.id && item.workspaceId === s.workspaceId && item.status === 'connected');
      if (!current?.notionWriting || current.notionWriting.grantId !== c.notionWriting!.grantId) throw new NotionDocumentError('授权已改变，请重新打开设置');
      current.notionWriting.parentId = parentId; current.notionWriting.referenceIds = referenceIds;
    });
    return this.settings(s);
  }
  assertTarget(db: Database, s: WorkScope, target: NonNullable<WorkRun['notionTarget']>) {
    featureMember(db, s);
    const c = db.knowledgeConnections.find(c => c.workspaceId === s.workspaceId && c.id === target.connectionId && c.status === 'connected' && c.provider === 'notion');
    if (c?.notionWriting?.grantId !== target.grantId || c.notionWriting.userId !== s.userId || c.notionWriting.parentId !== target.parentId) throw new NotionDocumentError('Notion 授权或保存位置已改变，本轮没有继续写入');
  }
  async reconcile(s: WorkScope, cid: string, verify: () => Promise<void>) {
    await verify();const db=await this.store.read();featureMember(db,s);
    if(!db.conversations.some(c=>c.id===cid&&c.workspaceId===s.workspaceId&&c.userId===s.userId&&!c.coordinatorMain))throw new NotionDocumentError('任务不存在',404);
    const jobs=(db.chatOperations??[]).filter(o=>o.conversationId===cid&&o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.workRun?.notionReceipt).sort((a,b)=>a.createdAt?.localeCompare(b.createdAt)||0);
    const op=jobs.filter(o=>o.workRun!.notionReceipt!.state!=='verified'&&mayHaveWritten(o.workRun!.notionReceipt)).at(-1)??jobs.filter(o=>o.workRun!.notionReceipt!.state!=='verified').at(-1)??jobs.at(-1);
    if(!op?.workRun?.notionReceipt?.expectedDigest||!op.workRun.notionTarget||!op.workRun.notionReceipt.pageId&&!op.workRun.notionReceipt.asyncTaskId)throw new NotionDocumentError('尚未取得可核对的页面编号，请在 Notion 检查原文；不会自动创建替代文档');
    const result=await this.verifyReceipt(s,op.id,verify,true);
    if(result?.state!=='verified')throw new NotionDocumentError(result?.state==='scheduled'
      ?'原页面与本轮拟保存内容不同或暂未完整读到；稍后会继续只读核对，没有覆盖或重发。'
      :result?.state==='exhausted'
        ?'原页面与本轮拟保存内容不同或尚未完整核对，自动核对已停下。请先查看原页面；没有覆盖或重发。'
        :'保存记录已改变或本轮尚未核对，请先查看原页面；没有覆盖或重发。');
    const fresh=(await this.store.read()).chatOperations?.find(o=>o.id===op.id&&o.workspaceId===s.workspaceId&&o.userId===s.userId);
    const receipt=fresh?.workRun?.notionReceipt;
    return {state:'verified',url:receipt?.url,operationId:op.id,expectedDigest:receipt?.expectedDigest,digest:receipt?.digest,checkpointKey:receipt?.checkpointKey};
  }
  /** Only enrolled, exact known writes are revisited; this never scans old
   * private pages or calls a model/create/update. A live authorized poll owns it. */
  async reconcileDue(s:WorkScope,verify:()=>Promise<void>):Promise<VerificationResult[]>{
    await verify();const db=await this.store.read();featureMember(db,s);const now=this.now();
    const due=(db.chatOperations??[]).filter(o=>o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.workRun?.notionReceipt?.state!=='verified'&&o.workRun?.notionReceipt?.verification&&o.workRun.state!=='running'&&!['cancelled','interrupted'].includes(o.workRun.state)&&db.conversations.some(c=>c.id===o.conversationId&&c.workspaceId===s.workspaceId&&c.userId===s.userId&&!c.archived)&&(
      o.workRun.notionReceipt.verification.state==='scheduled'&&Date.parse(o.workRun.notionReceipt.verification.nextCheckAt)<=now||o.workRun.notionReceipt.verification.state==='checking'&&Date.parse(o.workRun.notionReceipt.verification.leaseUntil??'')<=now
    )).slice(0,2);
    const results:VerificationResult[]=[];
    for(const op of due){const result=await this.verifyReceipt(s,op.id,verify);if(result)results.push(result);}
    return results;
  }
  private async verifyReceipt(s:WorkScope,opId:string,verify:()=>Promise<void>,manual=false):Promise<VerificationResult|undefined>{
    await verify();const leaseId=crypto.randomUUID(),now=this.now();
    const claimed=await this.store.mutate(db=>{
      featureMember(db,s);const op=db.chatOperations?.find(o=>o.id===opId&&o.workspaceId===s.workspaceId&&o.userId===s.userId),run=op?.workRun,r=run?.notionReceipt,target=run?.notionTarget;
      if(!op||!run||!r||!target)return;
      if(run.state==='running')throw new NotionDocumentError('保存仍在进行，请等待这轮结束后核对');
      if(!manual&&['cancelled','interrupted'].includes(run.state))return;
      if(!r.expectedDigest||!r.pageId&&!r.asyncTaskId||['not_sent','rejected'].includes(r.delivery??''))return;
      const existing=r.verification;
      if(existing?.state==='checking'&&Date.parse(existing.leaseUntil??'')>now)return;
      if(!manual&&(!existing||existing.state==='exhausted'||Date.parse(existing.nextCheckAt)>now))return;
      if(manual&&(!existing||existing.state==='exhausted'||Date.parse(existing.deadlineAt)<=now))r.verification=this.schedule(r,true);
      const v=r.verification!;
      try{this.assertTarget(db,s,target);}catch{v.state='exhausted';v.lastReason='authorization';v.leaseId=undefined;v.leaseUntil=undefined;return {blocked:true,conversationId:op.conversationId!};}
      if(v.attempt>=this.delays().length||Date.parse(v.deadlineAt)<=now){v.state='exhausted';v.leaseId=undefined;v.leaseUntil=undefined;return {blocked:true,conversationId:op.conversationId!};}
      // A legacy receipt is upgraded only from its exact scoped create args,
      // whose old digest must match. No guessed update body or global search.
      if(!r.expectedCanonicalDigest||manual&&(r.canonicalVersion===2||r.canonicalVersion===3)){
        const candidates=(db.contextTraces??[]).filter(t=>t.workspaceId===s.workspaceId&&t.userId===s.userId&&t.conversationId===op.conversationId&&t.requestId===op.requestId).flatMap(t=>t.executionSteps??[]).filter(step=>step.tool==='save_notion_draft'&&typeof step.query==='string'&&step.query.length<=52000).flatMap(step=>{
          try{const args=JSON.parse(step.query!) as {title?:unknown;content?:unknown;final?:unknown};const key=taskStepKey('worker','save_notion_draft',step.query!);if(!args||Object.keys(args).some(k=>!['title','content','final'].includes(k))||typeof args.title!=='string'||!args.title.trim()||args.title.length>200||args.final!==undefined&&typeof args.final!=='boolean'||typeof args.content!=='string'||!args.content||args.content.length>50000||hash(normalized(args.content))!==r.expectedDigest||!run.steps?.some(saved=>saved.key===key&&saved.namespace==='worker'&&saved.tool==='save_notion_draft'&&saved.effect==='external_write'&&saved.scopeId===op.id))return [];return [{key,body:args.content}];}catch{return [];}
        });
        const unique=[...new Map(candidates.map(c=>[c.key,c])).values()];
        if(unique.length===1){r.checkpointKey=unique[0].key;r.expectedRawDigest=hash(unique[0].body);r.expectedCanonicalDigest=canonicalNotionDigest(unique[0].body,4);r.canonicalVersion=4;}
      }
      v.state='checking';v.attempt++;v.leaseId=leaseId;v.leaseUntil=new Date(now+(this.verificationOptions.leaseMs??90_000)).toISOString();
      const task=db.conversations.find(c=>c.id===op.conversationId&&c.workspaceId===s.workspaceId&&c.userId===s.userId);
      if(manual&&['failed','completed'].includes(op.status)&&run.state==='failed'&&task&&!task.archived&&task.workPauseReason!=='user_stopped')run.notionVerificationSelection={operationId:op.id,expectedDigest:r.expectedDigest,pageId:r.pageId,asyncTaskId:r.asyncTaskId,checkpointKey:r.checkpointKey,version:v.version,connectionId:target.connectionId,grantId:target.grantId,parentId:target.parentId,requestedAt:new Date(now).toISOString()};
      return {receipt:structuredClone(r),target:structuredClone(target),conversationId:op.conversationId!,version:v.version};
    });
    if(!claimed)return;
    if('blocked' in claimed)return {operationId:opId,conversationId:claimed.conversationId,state:'exhausted'};
    const snapshot=claimed.receipt;let pageId=snapshot.pageId,body:string|undefined,reason:'read_failed'|'mismatch'|'incomplete'|'authorization'|'stale'|'no_page'='read_failed';
    const assertSnapshot=(db:Database)=>{
      const op=db.chatOperations?.find(o=>o.id===opId&&o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.conversationId===claimed.conversationId),run=op?.workRun,r=run?.notionReceipt;
      if(!op||!run||!r||r.verification?.version!==claimed.version||r.verification.leaseId!==leaseId||!sameReceipt(r,snapshot)||run.state==='running'||!manual&&['cancelled','interrupted'].includes(run.state)||(db.chatOperations??[]).some(other=>other.id!==op.id&&other.workspaceId===s.workspaceId&&other.userId===s.userId&&other.conversationId===op.conversationId&&mayHaveWritten(other.workRun?.notionReceipt)&&(other.createdAt??'')>(op.createdAt??'')))throw new NotionVerificationChanged();
      this.assertTarget(db,s,claimed.target);
    };
    try{
      await verify();assertSnapshot(await this.store.read());
      if(!pageId&&snapshot.asyncTaskId){const result=resultData(await this.mcp.callDocumentTool(s.workspaceId,claimed.target.connectionId,claimed.target.grantId,s.userId,'notion-get-async-task',{task_id:snapshot.asyncTaskId}));if(result?.status==='succeeded'){const value=result.result??result;pageId=notionPageId(value?.pages?.[0]?.id||value?.page?.id||value?.id||value?.url);}else if(result?.status==='failed')reason='no_page';}
      if(pageId){await verify();assertSnapshot(await this.store.read());body=notionBody(await this.mcp.readDocument(s.workspaceId,pageId));reason='mismatch';}
      await verify();assertSnapshot(await this.store.read());
    }catch(error){
      if(error instanceof NotionVerificationChanged)reason='stale';
      else if(error instanceof NotionDocumentError&&/完整|正文/.test(error.message))reason='incomplete';
      else if(error&&typeof error==='object'&&[401,403,428].includes(Number((error as {status?:unknown}).status))||error instanceof NotionDocumentError&&/授权|保存位置/.test(error.message))reason='authorization';
      // Recheck Key and exact authorization even after a transport failure.
      await verify();try{this.assertTarget(await this.store.read(),s,claimed.target);}catch{reason='authorization';}
    }
    const matched=body!==undefined&&(snapshot.canonicalVersion===2||snapshot.canonicalVersion===3||snapshot.canonicalVersion===4?Boolean(snapshot.expectedCanonicalDigest)&&canonicalNotionDigest(body,snapshot.canonicalVersion)===snapshot.expectedCanonicalDigest:hash(normalized(body))===snapshot.expectedDigest);
    return this.store.mutate(db=>{
      featureMember(db,s);const op=db.chatOperations?.find(o=>o.id===opId&&o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.conversationId===claimed.conversationId),run=op?.workRun,r=run?.notionReceipt,v=r?.verification;
      if(!op||!run||!r||!v||v.version!==claimed.version||v.leaseId!==leaseId||!sameReceipt(r,snapshot)||run.state==='running'||!manual&&['cancelled','interrupted'].includes(run.state))return {operationId:opId,conversationId:claimed.conversationId,state:'blocked' as const};
      try{this.assertTarget(db,s,claimed.target);}catch{reason='authorization';}
      const newer=(db.chatOperations??[]).some(other=>other.id!==op.id&&other.workspaceId===s.workspaceId&&other.userId===s.userId&&other.conversationId===op.conversationId&&mayHaveWritten(other.workRun?.notionReceipt)&&(other.createdAt??'')>(op.createdAt??''));
      if(newer)reason='stale';
      if(matched&&reason!=='authorization'&&reason!=='stale'){
        const newlyVerified=r.state!=='verified';r.state='verified';r.pageId=pageId;r.url=`https://www.notion.so/${pageId}`;r.digest=hash(body!);r.error=undefined;r.failureCode=undefined;r.verification=undefined;
        if(run.notionTarget?.connectionId===claimed.target.connectionId&&run.notionTarget.grantId===claimed.target.grantId&&run.notionTarget.parentId===claimed.target.parentId){run.notionTarget.pageId=pageId;run.notionTarget.url=r.url;}
        const task=db.conversations.find(c=>c.id===op.conversationId&&c.workspaceId===s.workspaceId&&c.userId===s.userId);
        if(task?.notionDocument?.connectionId===claimed.target.connectionId&&task.notionDocument.grantId===claimed.target.grantId&&task.notionDocument.parentId===claimed.target.parentId&&(!task.notionDocument.pageId||task.notionDocument.pageId===pageId)){task.notionDocument.pageId=pageId;task.notionDocument.url=r.url;}
        const step=r.checkpointKey?run.steps?.find(step=>step.key===r.checkpointKey&&step.scopeId===op.id&&step.namespace==='worker'&&step.tool==='save_notion_draft'&&step.effect==='external_write'):undefined;
        if(step&&step.state==='started'){step.state='completed';step.output={state:'verified',pageId,url:r.url,digest:r.digest,expectedDigest:r.expectedDigest,final:r.final===true};/* Keep the actual write-start time: a later source read cannot retroactively precede this save. */}
        if(newlyVerified){run.reportRevision=(run.reportRevision??0)+1;run.reportRevisionAt=new Date(this.now()).toISOString();run.reportedToCoordinatorAt=undefined;run.reportMessageId=undefined;run.unread=true;run.userReport='刚核对过，之前拟保存的内容已经在 Notion 里，文章入口可以打开了。这次只确认了保存状态；其余没做完的部分仍保留在这件事里，没有重新执行。';}
        return {operationId:opId,conversationId:claimed.conversationId,state:'verified' as const};
      }
      if(pageId){r.pageId=pageId;r.url=`https://www.notion.so/${pageId}`;}
      const exhausted=snapshot.state==='verified'||['authorization','stale','no_page'].includes(reason)||v.attempt>=this.delays().length||this.now()>=Date.parse(v.deadlineAt);
      v.state=exhausted?'exhausted':'scheduled';v.lastReason=reason;v.leaseId=undefined;v.leaseUntil=undefined;v.nextCheckAt=new Date(this.now()+(this.delays()[v.attempt]??0)).toISOString();
      return {operationId:opId,conversationId:claimed.conversationId,state:exhausted?'exhausted' as const:'scheduled' as const};
    });
  }
  async context(s: WorkScope, job: WorkRun, originalRequest=job.instruction||'') {
    const target = job.notionTarget!;
    this.assertTarget(await this.store.read(), s, target);
    const readOnly=readOnlyRequest(originalRequest);
    const refs = [];
    for (const id of readOnly?[]:target.referenceIds) refs.push({ id, content: notionBody(await this.mcp.readDocument(s.workspaceId, id)).slice(0, 12000) });
    const current = target.pageId && !readOnly ? notionBody(await this.mcp.readDocument(s.workspaceId, target.pageId)) : undefined;
    return { references: refs, currentDocument: current, pageId: target.pageId, readOnly,
      ...(!readOnly?{writingPolicy:'完整文章先组织好整稿再保存，不把一段中间稿当交付。修订整篇时 old_str 可使用本轮完整原文、new_str 写完整修订稿；局部修改仅用于用户明确指定的局部要求。每次保存已回读核对后可继续修改同页；只有已完成本轮全部写作要求的最后一次保存才传 final:true，中间稿不传。'}:{}),
      ...(sameTitleCheckRequested(originalRequest)?{creationPolicy:'save_notion_draft 会先读取已选父页面的完整子页面列表核对同名；内容一致则回读并复用，不新建。目录不完整或同名内容不同会停止，不覆盖。以工具返回的 duplicateCheck 为准。'}:{}),
      location: `https://www.notion.so/${target.pageId || target.parentId}`,
      parentLocation: `https://www.notion.so/${target.parentId}` };
  }
  readTool(s: WorkScope, job: WorkRun, verify: () => Promise<void>): OrchestrationTool {
    const target=job.notionTarget!;
    const read=async()=>{
      await verify();this.assertTarget(await this.store.read(),s,target);
      if(!target.pageId)throw new NotionDocumentError('这件事还没有绑定可读取的文章');
      const content=notionBody(await this.mcp.readDocument(s.workspaceId,target.pageId));
      await verify();this.assertTarget(await this.store.read(),s,target);
      return {status:'read',pageId:target.pageId,url:`https://www.notion.so/${target.pageId}`,content,complete:true};
    };
    return {name:'read_notion_document',label:'读取这篇 Notion 原文',effect:'read',description:'实际回读当前任务唯一绑定的 Notion 文章，返回完整正文与文章自身入口。无须提供页面编号，不读取其他页面，也不修改或保存。以本次工具真实返回的正文核对标题和结尾，不使用历史聊天冒充本次读取。',run:async()=>{throw new NotionDocumentError('读取参数无效');},structured:{schema:{type:'object',additionalProperties:false,properties:{}},validate:value=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length)throw new NotionDocumentError('读取范围已绑定，不接受其他页面或参数');return {};},run:read}};
  }
  tool(s: WorkScope, opId: string, cid: string, job: WorkRun, verify: () => Promise<void>, current?: string, originalRequest = ''): OrchestrationTool {
    const target = job.notionTarget!;
    let currentBody=current;
    let validateSave:(value:unknown)=>unknown;
    return { name: 'save_notion_draft',label:'保存到 Notion',effect:'external_write',checkpointReuse:'arguments',checkpointScope:opId,
      description: '由 ONE 写入已授权的 Notion 草稿。首次提供 title/content；后续保存只提供 old_str/new_str，精确替换最新已回读的一处原文，可用整篇原文替换完整修订稿。只有 verified 回执才表示这次保存成功；成功后可继续修改同一页，不重复创建。请先完成必需资料查找、组织完整正文，最后一次完成本轮全部要求的保存传 final:true；中间稿不传 final。不要用局部段落冒充完整文章。', run: async () => { throw new NotionDocumentError('参数无效'); },
      structured: { schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', maxLength: 200 }, content: { type: 'string', maxLength: 50000 }, old_str: { type: 'string', maxLength: 50000 }, new_str: { type: 'string', maxLength: 50000 }, final:{type:'boolean',description:'仅当写入的是完成本轮全部写作要求的最终稿时为true，不能为中间稿或未完成整篇的局部修改标记true。'} } },
        validate: validateSave = value => {
          if(readOnlyRequest(originalRequest))throw new NotionDocumentError('这轮只读，不会修改或保存文章。');
          const v = value as any;
          if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['title','content','old_str','new_str','final'].includes(k))||v.final!==undefined&&typeof v.final!=='boolean') throw new NotionDocumentError('保存参数无效');
          if (target.pageId) {
            if (v.content !== undefined || v.title !== undefined || !currentBody || typeof v.old_str !== 'string' || !v.old_str || currentBody.split(v.old_str).length !== 2 || !v.new_str?.trim()) throw new OrchestrationInputError('请用最新已回读正文中的一处唯一原文提供 old_str/new_str；首次保存后继续修改同一页，不再提供 title/content。整稿修订可使用完整原文替换。');
            safeArticle(v.old_str); safeArticle(v.new_str);
            const exact=quotedReplacement(originalRequest);
            if(exact&&(currentBody.split(exact.old).length!==2||currentBody.replace(v.old_str,v.new_str)!==currentBody.replace(exact.old,exact.replacement)))
              throw new OrchestrationInputError('用户明确引用了要替换的原文和新文字。请逐字执行这一处替换，其余文字、标点和换行保持原样；原文不唯一时先核对，不要猜测或扩大修改。');
          } else { if (v.old_str !== undefined || v.new_str !== undefined || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 200) throw new NotionDocumentError('草稿标题无效'); safeArticle(v.content); }
          return v;
        }, run: async value => {
          if(readOnlyRequest(originalRequest))throw new NotionDocumentError('这轮只读，不会修改或保存文章。');
          await verify();const beforeWrite=await this.store.read();this.assertTarget(beforeWrite,s,target);
          const active=beforeWrite.chatOperations?.find(o=>o.id===opId&&o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.conversationId===cid)?.workRun;
          if(active?.state!=='running'||active.notionReceipt&&active.notionReceipt.state!=='verified')throw new NotionDocumentError('本轮保存已经提交或任务已停止，请查看原回执，不会重复写入');
          const v = validateSave(value) as any;
          if(beforeWrite.chatOperations?.some(o=>o.id!==opId&&o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.conversationId===cid&&o.workRun&&(
            o.workRun.notionReceipt&&o.workRun.notionReceipt.state!=='verified'&&!['not_sent','rejected'].includes(o.workRun.notionReceipt.delivery||'')||
            o.workRun.steps?.some(step=>step.tool==='save_notion_draft'&&step.effect==='external_write'&&step.state==='started')&&o.workRun.notionReceipt?.state!=='verified'&&!['not_sent','rejected'].includes(o.workRun.notionReceipt?.delivery||'')
          )))throw new NotionDocumentError('上次 Notion 保存还没确认，请先核对原页面；没有重复写入。');
          if (target.pageId && notionBody(await this.mcp.readDocument(s.workspaceId, target.pageId)) !== currentBody) throw new NotionDocumentError('Notion 文档已被修改，请重新读取后再继续；本轮没有覆盖原文');
          const expected = target.pageId ? currentBody!.replace(v.old_str, v.new_str) : v.content;
          // Persist before sending. Duplicate calls, disconnects and restarts
          // cannot turn a possibly-applied write into an automatic retry.
          await this.store.mutate(d => {
            this.assertTarget(d, s, target);
            const o = d.chatOperations?.find(o => o.id === opId && o.workspaceId === s.workspaceId && o.userId === s.userId && o.conversationId === cid);
            if (o?.workRun?.state !== 'running' || o.workRun.notionReceipt&&o.workRun.notionReceipt.state!=='verified') throw new NotionDocumentError('本轮保存已经提交或任务已停止，请查看原回执，不会重复写入');
            o.workRun.notionReceipt = { state: 'pending', delivery: 'not_sent', pageId: target.pageId, url: target.url, expectedDigest: hash(normalized(expected)),expectedRawDigest:hash(expected),expectedCanonicalDigest:canonicalNotionDigest(expected,4),canonicalVersion:4,checkpointKey:taskStepKey('worker','save_notion_draft',JSON.stringify(v)),final:v.final===true };
          });
          const record = async (receipt: NonNullable<WorkRun['notionReceipt']>) => this.store.mutate(d => {
            const o = d.chatOperations?.find(o => o.id === opId && o.workspaceId === s.workspaceId && o.userId === s.userId && o.conversationId === cid);
            if (!o?.workRun) throw new NotionDocumentError('保存回执不存在');
            o.workRun.notionReceipt = { ...o.workRun.notionReceipt, ...receipt };
            if(receipt.pageId){target.pageId=receipt.pageId;target.url=receipt.url;if(o.workRun.notionTarget){o.workRun.notionTarget.pageId=receipt.pageId;o.workRun.notionTarget.url=receipt.url;}}
            const c = d.conversations.find(c => c.id === cid && c.workspaceId === s.workspaceId && c.userId === s.userId);
            if (c?.notionDocument && receipt.pageId) { c.notionDocument.pageId = receipt.pageId; c.notionDocument.url = receipt.url; }
            job.notionReceipt = { ...o.workRun.notionReceipt };
          });
          let pageId = target.pageId;
          const checkKey=!pageId&&sameTitleCheckRequested(originalRequest)?JSON.stringify([s.workspaceId,s.userId,target.parentId,v.title.trim()]):undefined;
          let ownsCheck=false,duplicateCheck:string|undefined;
          let failureCode: NonNullable<WorkRun['notionReceipt']>['failureCode'] = 'write_unconfirmed';
          try {
            await verify();
            if(checkKey){
              if(this.creationChecks.has(checkKey))throw new NotionPreflightError('同名便笺正在核对或保存，先等这一份处理完，不重复新建。');
              this.creationChecks.add(checkKey);ownsCheck=true;
              let children:{id:string;title:string}[];
              try{children=childPages(await this.mcp.readDocument(s.workspaceId,target.parentId));}
              catch(error){throw error instanceof NotionPreflightError?error:new NotionPreflightError('保存位置暂时没读到，先不新建；稍后可以继续核对。');}
              await verify();this.assertTarget(await this.store.read(),s,target);
              const matches=children.filter(child=>child.title===v.title.trim());
              if(matches.length>1)throw new NotionPreflightError('这里已有多篇同名便笺，先不新建或覆盖。请选定要继续的那一篇。');
              if(matches.length){
                let actual:string;
                try{actual=notionBody(await this.mcp.readDocument(s.workspaceId,matches[0].id));}
                catch{throw new NotionPreflightError('找到了同名便笺，但正文还没完整读到；先不新建或覆盖。');}
                await verify();this.assertTarget(await this.store.read(),s,target);
                if(canonicalNotionDigest(actual)!==canonicalNotionDigest(expected))throw new NotionPreflightError('这里已有同名便笺，但内容不同。原文没动，也没有重复新建；可以换个标题另存。');
                pageId=matches[0].id;const url=`https://www.notion.so/${pageId}`;
                const fresh=await this.store.read();this.assertTarget(fresh,s,target);
                if(fresh.chatOperations?.find(o=>o.id===opId&&o.workspaceId===s.workspaceId&&o.userId===s.userId)?.workRun?.state!=='running')throw new NotionPreflightError('这轮已经停下，没有新建或修改文档。');
                await record({state:'verified',pageId,url,digest:hash(actual),delivery:undefined});currentBody=actual;
                return {state:'verified',url,pageId,digest:hash(actual),expectedDigest:hash(normalized(expected)),final:v.final===true,...(actual!==expected?{currentDocument:actual}:{}),reused:true,duplicateCheck:'matched_existing',message:'已核对保存位置并回读同名便笺，内容一致，复用原页面，没有重复新建。后续替换以 currentDocument（如有）为最新原文。'};
              }
              duplicateCheck='no_same_title_in_parent';
            }
            let response = resultData(await this.mcp.callDocumentTool(s.workspaceId, target.connectionId, target.grantId, s.userId,
              pageId ? 'notion-update-page' : 'notion-create-pages', pageId ? { page_id: pageId, command: 'update_content', content_updates: [{ old_str: v.old_str, new_str: v.new_str }], allow_async: false } : { parent: { page_id: target.parentId }, pages: [{ properties: { title: v.title }, content: v.content }], allow_async: false }, async () => {
                await verify(); this.assertTarget(await this.store.read(), s, target);
                await this.store.mutate(d => {
                  this.assertTarget(d, s, target);
                  const o = d.chatOperations?.find(o => o.id === opId && o.workspaceId === s.workspaceId && o.userId === s.userId && o.conversationId === cid);
                  if (o?.workRun?.state !== 'running' || o.workRun.notionReceipt?.state !== 'pending' || o.workRun.notionReceipt.delivery !== 'not_sent') throw new NotionDocumentError('本轮保存已改变或停止，没有重复发送');
                  o.workRun.notionReceipt.delivery = 'unknown';
                });
              }));
            failureCode = 'response_unrecognized';
            if (response?.async_task || response?.type === 'async_task' || response?.object === 'async_task') {
              const taskId = response.async_task?.task_id || response.async_task?.id || response.task_id || response.id;
              if (typeof taskId !== 'string') throw new Error('async response unavailable');
              await record({ state: 'pending', asyncTaskId: taskId });
              failureCode = 'async_unconfirmed';
              for (let i = 0; i < 10; i++) {
                await verify(); await new Promise(resolve => setTimeout(resolve, 1500));
                response = resultData(await this.mcp.callDocumentTool(s.workspaceId, target.connectionId, target.grantId, s.userId, 'notion-get-async-task', { task_id: taskId }));
                if (response?.status === 'succeeded') { response = response.result; break; }
                if (response?.status === 'failed') throw new Error('async failed');
              }
              if (response?.status && response.status !== 'succeeded') throw new Error('async not completed');
            }
            if (!pageId) pageId = notionPageId(response?.pages?.[0]?.id || response?.pages?.[0]?.url || response?.page?.id || response?.id || response?.url);
            const url = `https://www.notion.so/${pageId}`;
            // Retain the created page even if readback/cancellation fails.
            await record({ state: 'pending', pageId, url });
            failureCode = 'readback_failed';
            const actual = notionBody(await this.mcp.readDocument(s.workspaceId, pageId));
            failureCode = 'readback_mismatch';
            if (canonicalNotionDigest(actual)!==canonicalNotionDigest(expected)) throw new Error('readback mismatch');
            await record({ state: 'verified', pageId, url, digest: hash(actual), failureCode: undefined, delivery: undefined, diagnostic: undefined });
            currentBody=actual;
            await verify();
            return { state: 'verified', url, pageId, digest:hash(actual),expectedDigest:hash(normalized(expected)),final:v.final===true,...(actual!==expected?{currentDocument:actual}:{}), ...(duplicateCheck?{duplicateCheck}:{}), message: `${duplicateCheck?'已核对保存位置，没有同名便笺；':''}已保存并回读核对；可打开 Notion。后续修改继续这一篇，以 currentDocument（如有）为最新原文，否则沿用刚写入的正文；只有完成整份要求的最终稿才标记 final:true。` };
          } catch (error) {
            if(checkKey&&failureCode==='write_unconfirmed'&&(await this.store.read()).chatOperations?.find(o=>o.id===opId&&o.workspaceId===s.workspaceId&&o.userId===s.userId)?.workRun?.notionReceipt?.delivery==='not_sent'){
              const message=error instanceof NotionPreflightError?error.message:'本轮保存前的检查没能完成，还没有发送写入请求。';
              await record({state:'uncertain',failureCode:'preflight_failed',delivery:'not_sent',error:message});
              throw new NotionDocumentError(message);
            }
            const failure = error instanceof NotionWriteError && failureCode === 'write_unconfirmed' ? error : undefined;
            const message = failure && failure.delivery !== 'unknown' ? failure.message : 'Notion 保存未确认，可能已写入；请核对原页面，不会自动重跑。';
            await record({ state: 'uncertain', pageId, url: pageId ? `https://www.notion.so/${pageId}` : undefined, failureCode, delivery: failure?.delivery ?? 'unknown', diagnostic: failure ? {phase: failure.phase, reason: failure.reason, upstreamCode: failure.upstreamCode} : undefined, error: message });
            if((pageId||job.notionReceipt?.asyncTaskId)&&!['not_sent','rejected'].includes(failure?.delivery??'unknown'))await this.store.mutate(db=>{
              const op=db.chatOperations?.find(o=>o.id===opId&&o.workspaceId===s.workspaceId&&o.userId===s.userId&&o.conversationId===cid),r=op?.workRun?.notionReceipt,task=db.conversations.find(c=>c.id===cid&&c.workspaceId===s.workspaceId&&c.userId===s.userId);
              if(op?.status==='pending'&&op.workRun?.state==='running'&&task&&!task.archived&&task.workPauseReason!=='user_stopped'&&r?.state==='uncertain'&&r.expectedDigest===hash(normalized(expected))){r.verification=this.schedule(r);job.notionReceipt=structuredClone(r);}
            });
            throw new NotionDocumentError(message);
          } finally {
            if(ownsCheck)this.creationChecks.delete(checkKey!);
          }
        } }
    };
  }
}
