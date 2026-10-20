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

const readOnlyRequest=(text:string)=>freshDocumentReadRequested(text)&&/只读|(?:不|不要)(?:修改|保存|写入)/.test(text);

export class NotionDocumentError extends CoordinatorError {}
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
  const wrapped = raw.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
  const body = wrapped ? wrapped[1] : raw;
  if (!body || body.length > 60000) throw new NotionDocumentError('页面正文无法完整读取，请检查页面权限或缩小范围');
  return body;
}
const hash = (body: string) => crypto.createHash('sha256').update(body).digest('hex');
const normalized = (body: string) => body.split('\n').map(line => line.trimEnd()).filter(line => line.trim()).join('\n').trim();
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
  constructor(private store: Store, private mcp: NotionMcpService) {}
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
    await verify(); const db = await this.store.read(); featureMember(db, s);
    const task = db.conversations.find(c => c.id === cid && c.workspaceId === s.workspaceId && c.userId === s.userId && !c.coordinatorMain);
    if (!task) throw new NotionDocumentError('任务不存在', 404);
    const jobs = (db.chatOperations || []).filter(o => o.conversationId === cid && o.workspaceId === s.workspaceId && o.userId === s.userId && o.workRun?.notionReceipt)
      .sort((a,b)=>a.createdAt?.localeCompare(b.createdAt)||0);
    const op = jobs.filter(o=>o.workRun!.notionReceipt!.state!=='verified').at(-1) ?? jobs.at(-1);
    const receipt = op?.workRun?.notionReceipt, target = op?.workRun?.notionTarget;
    if (!receipt || !target || !receipt.pageId || !receipt.expectedDigest) throw new NotionDocumentError('尚未取得可核对的页面编号，请在 Notion 检查原文；不会自动创建替代文档');
    if (op!.workRun!.state === 'running') throw new NotionDocumentError('保存仍在进行，请等待这轮结束后核对');
    this.assertTarget(db, s, target);
    let body: string;
    try { body = notionBody(await this.mcp.readDocument(s.workspaceId, receipt.pageId)); }
    catch { throw new NotionDocumentError('原页面暂未完整读到，请检查连接；没有重发保存请求'); }
    if (hash(normalized(body)) !== receipt.expectedDigest) throw new NotionDocumentError('原页面与本轮拟保存内容不同，请在 Notion 核对；没有覆盖或重发');
    await verify();
    await this.store.mutate(d => {
      this.assertTarget(d, s, target);
      const own = d.chatOperations?.find(o => o.id === op!.id && o.workspaceId === s.workspaceId && o.userId === s.userId && o.conversationId === cid);
      if (!own?.workRun?.notionReceipt || own.workRun.notionReceipt.expectedDigest !== receipt.expectedDigest || own.workRun.state === 'running') throw new NotionDocumentError('保存记录已改变，请重新检查');
      own.workRun.notionReceipt.state = 'verified'; own.workRun.notionReceipt.digest = hash(body); own.workRun.notionReceipt.error = undefined; own.workRun.notionReceipt.failureCode = undefined;
      // This reconciles the save only. Never change cancelled/failed task state
      // or lift the pause: the connected client resumes any unpaused queue.
    });
    return { state: 'verified', url: receipt.url };
  }
  async context(s: WorkScope, job: WorkRun, originalRequest=job.instruction||'') {
    const target = job.notionTarget!;
    this.assertTarget(await this.store.read(), s, target);
    const readOnly=readOnlyRequest(originalRequest);
    const refs = [];
    for (const id of readOnly?[]:target.referenceIds) refs.push({ id, content: notionBody(await this.mcp.readDocument(s.workspaceId, id)).slice(0, 12000) });
    const current = target.pageId ? notionBody(await this.mcp.readDocument(s.workspaceId, target.pageId)) : undefined;
    return { references: refs, currentDocument: current, pageId: target.pageId, readOnly,
      location: `https://www.notion.so/${target.pageId || target.parentId}`,
      parentLocation: `https://www.notion.so/${target.parentId}` };
  }
  tool(s: WorkScope, opId: string, cid: string, job: WorkRun, verify: () => Promise<void>, current?: string, originalRequest = ''): OrchestrationTool {
    const target = job.notionTarget!;
    return { name: 'save_notion_draft',label:'保存到 Notion',effect:'external_write', description: '由 ONE 写入已授权的 Notion 草稿。首次提供 title/content；继续修改只能提供 old_str/new_str，精确替换本轮读到的一段原文，不修改其他页面。只有 verified 回执才表示已保存。每轮只保存一次。', run: async () => { throw new NotionDocumentError('参数无效'); },
      structured: { schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string', maxLength: 200 }, content: { type: 'string', maxLength: 50000 }, old_str: { type: 'string', maxLength: 50000 }, new_str: { type: 'string', maxLength: 50000 } } },
        validate: value => {
          if(readOnlyRequest(originalRequest))throw new NotionDocumentError('这轮只读，不会修改或保存文章。');
          const v = value as any;
          if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['title','content','old_str','new_str'].includes(k))) throw new NotionDocumentError('保存参数无效');
          if (target.pageId) {
            if (v.content !== undefined || v.title !== undefined || !current || typeof v.old_str !== 'string' || !v.old_str || current.split(v.old_str).length !== 2 || !v.new_str?.trim()) throw new NotionDocumentError('请精确选择一处原文再修改，不支持删除整篇内容');
            safeArticle(v.old_str); safeArticle(v.new_str);
            const exact=quotedReplacement(originalRequest);
            if(exact&&(current.split(exact.old).length!==2||current.replace(v.old_str,v.new_str)!==current.replace(exact.old,exact.replacement)))
              throw new OrchestrationInputError('用户明确引用了要替换的原文和新文字。请逐字执行这一处替换，其余文字、标点和换行保持原样；原文不唯一时先核对，不要猜测或扩大修改。');
          } else { if (v.old_str !== undefined || v.new_str !== undefined || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 200) throw new NotionDocumentError('草稿标题无效'); safeArticle(v.content); }
          return v;
        }, run: async value => {
          if(readOnlyRequest(originalRequest))throw new NotionDocumentError('这轮只读，不会修改或保存文章。');
          const v = value as any;
          await verify(); this.assertTarget(await this.store.read(), s, target);
          if (target.pageId && notionBody(await this.mcp.readDocument(s.workspaceId, target.pageId)) !== current) throw new NotionDocumentError('Notion 文档已被修改，请重新读取后再继续；本轮没有覆盖原文');
          const expected = target.pageId ? current!.replace(v.old_str, v.new_str) : v.content;
          // Persist before sending. Duplicate calls, disconnects and restarts
          // cannot turn a possibly-applied write into an automatic retry.
          await this.store.mutate(d => {
            this.assertTarget(d, s, target);
            const o = d.chatOperations?.find(o => o.id === opId && o.workspaceId === s.workspaceId && o.userId === s.userId && o.conversationId === cid);
            if (o?.workRun?.state !== 'running' || o.workRun.notionReceipt) throw new NotionDocumentError('本轮保存已经提交或任务已停止，请查看原回执，不会重复写入');
            o.workRun.notionReceipt = { state: 'pending', delivery: 'not_sent', pageId: target.pageId, url: target.url, expectedDigest: hash(normalized(expected)) };
          });
          const record = async (receipt: NonNullable<WorkRun['notionReceipt']>) => this.store.mutate(d => {
            const o = d.chatOperations?.find(o => o.id === opId && o.workspaceId === s.workspaceId && o.userId === s.userId && o.conversationId === cid);
            if (!o?.workRun) throw new NotionDocumentError('保存回执不存在');
            o.workRun.notionReceipt = { ...o.workRun.notionReceipt, ...receipt };
            const c = d.conversations.find(c => c.id === cid && c.workspaceId === s.workspaceId && c.userId === s.userId);
            if (c?.notionDocument && receipt.pageId) { c.notionDocument.pageId = receipt.pageId; c.notionDocument.url = receipt.url; }
            job.notionReceipt = { ...o.workRun.notionReceipt };
          });
          let pageId = target.pageId;
          let failureCode: NonNullable<WorkRun['notionReceipt']>['failureCode'] = 'write_unconfirmed';
          try {
            await verify();
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
            if (normalized(actual) !== normalized(expected)) throw new Error('readback mismatch');
            await record({ state: 'verified', pageId, url, digest: hash(actual), failureCode: undefined, delivery: undefined, diagnostic: undefined });
            await verify();
            return { state: 'verified', url, pageId, message: '已保存并回读核对；可打开 Notion。后续修改继续这一篇。' };
          } catch (error) {
            const failure = error instanceof NotionWriteError && failureCode === 'write_unconfirmed' ? error : undefined;
            const message = failure && failure.delivery !== 'unknown' ? failure.message : 'Notion 保存未确认，可能已写入；请核对原页面，不会自动重跑。';
            await record({ state: 'uncertain', pageId, url: pageId ? `https://www.notion.so/${pageId}` : undefined, failureCode, delivery: failure?.delivery ?? 'unknown', diagnostic: failure ? {phase: failure.phase, reason: failure.reason, upstreamCode: failure.upstreamCode} : undefined, error: message });
            throw new NotionDocumentError(message);
          }
        } }
    };
  }
}
