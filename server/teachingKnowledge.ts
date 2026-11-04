import type { Store } from './db.js';
import type { Database, KnowledgeConnection } from './types.js';
import type { TeachingKnowledgeSource, TeachingScope } from './teachingTypes.js';
import type { KnowledgeService } from './knowledge/knowledgeService.js';
import type { NotionMcpService } from './knowledge/notionMcpService.js';
import { canReadKnowledge } from './enterprisePolicy.js';
import { sourceBinding } from './publicSharing.js';
import { notionBody, notionFetchedTitle } from './notionDocuments.js';
import { parseNotionPageLink } from '../src/notionPageLink.js';
import { TeachingError, teachingMember } from './teaching.js';
import {createHash} from 'node:crypto';

export type TeachingKnowledgeDependencies = {
  notion?: Pick<NotionMcpService, 'readDocument'>;
  knowledgeService?: Pick<KnowledgeService, 'recallWithDiagnostics'>;
  verify?: () => Promise<void>;
};
export type TeachingKnowledgeRead = {
  text: string;
  sources: { label: string; title: string; status: 'read' | 'no_match' }[];
};
const MAX_SOURCES = 5, MAX_TEXT = 100_000;
function invalid(message: string, status = 400, code = 'TEACHING_KNOWLEDGE_INVALID'): never { throw new TeachingError(message, status, code); }
/** ima identifies its client with encryptedClientId and limits library searches
 * to saved selectedIds. Neither may silently change an existing course grant. */
export function teachingKnowledgeBinding(connection: KnowledgeConnection) {
  const account=sourceBinding(connection);
  if(connection.provider!=='ima')return account;
  return createHash('sha256').update(JSON.stringify([account,connection.encryptedClientId,connection.credentialOwnerUserId,[...new Set(connection.retrievalScope?.selectedIds??[])].sort()])).digest('hex');
}
function connection(db: Database, scope: TeachingScope, id: string): KnowledgeConnection {
  teachingMember(db, scope);
  const current = db.knowledgeConnections.find(item => item.id === id && item.workspaceId === scope.workspaceId);
  if (!current || !['connected', 'error'].includes(current.status) || !canReadKnowledge(db, scope, id)) return invalid('知识连接不存在、已撤销或不属于当前授课空间，请老师重新选择。', 403);
  // Existing adapters resolve one connection per workspace/provider. Never let
  // selecting a second record silently read the first account instead.
  if (db.knowledgeConnections.find(item => item.workspaceId === scope.workspaceId && item.provider === current.provider)?.id !== current.id) return invalid('这个知识库存在重复账号绑定，请老师检查连接后重新选择。', 409);
  return current;
}
function pageId(value: unknown): string {
  const parsed = parseNotionPageLink(value);
  if (parsed.error) return invalid('请粘贴需要用于本任务的具体 Notion 页面链接。');
  return parsed.pageId!;
}
const key = (source: Pick<TeachingKnowledgeSource, 'connectionId' | 'scope' | 'pageId'>) => JSON.stringify([source.connectionId, source.scope, source.pageId ?? '']);

/** Client metadata never grants access. Bindings are computed from the current
 * server connection; a whole-connection grant needs an explicit teacher choice. */
export function bindTeachingKnowledgeSources(db: Database, scope: TeachingScope, raw: unknown, previous: readonly TeachingKnowledgeSource[] = []): TeachingKnowledgeSource[] {
  if (raw === undefined) {
    assertTeachingKnowledgeSources(db, scope, previous);
    return structuredClone([...previous]);
  }
  teachingMember(db, scope);
  if (!Array.isArray(raw) || raw.length > MAX_SOURCES) return invalid('每个任务最多选择 5 个知识来源。');
  const sources = raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('请检查知识来源配置。');
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(name => !['connectionId', 'scope', 'pageId', 'label', 'confirmed', 'binding', 'provider'].includes(name))) return invalid('知识来源包含不支持的配置。');
    if (typeof item.connectionId !== 'string' || item.connectionId.length > 100 || !item.connectionId) return invalid('请选择已连接的知识来源。');
    if (item.scope !== 'page' && item.scope !== 'connection') return invalid('请明确选择具体页面或整个连接范围。');
    const current = connection(db, scope, item.connectionId), binding = teachingKnowledgeBinding(current);
    if(item.binding!==undefined&&(typeof item.binding!=='string'||item.binding!==binding))return invalid('该引用的账号或范围无法按原授权核对，请重新选择并明确确认后保存。',409,'TEACHING_KNOWLEDGE_BINDING_CHANGED');
    if (item.label !== undefined && (typeof item.label !== 'string' || item.label.length > 160 || /\0/.test(item.label))) return invalid('知识来源名称最多 160 字。');
    const selectedPage = item.scope === 'page' ? pageId(item.pageId) : undefined;
    if (item.scope === 'page' && current.provider !== 'notion') return invalid('这个知识库暂不支持精确选页；可明确授权该连接范围，或上传选定材料。');
    if (item.scope === 'connection' && item.pageId !== undefined && item.pageId !== '') return invalid('连接范围不能同时指定页面。');
    const result: TeachingKnowledgeSource = { provider: current.provider, connectionId: current.id, binding, scope: item.scope, ...(selectedPage ? { pageId: selectedPage } : {}), label: (typeof item.label === 'string' && item.label.trim() ? item.label.trim() : current.providerSpaceName || current.provider).slice(0, 160) };
    const former = previous.find(source => key(source) === key(result));
    // Updating an unrelated task field cannot silently rebind an old selected page to a new account.
    if (former && former.binding !== binding && item.binding !== binding) return invalid('该知识库的账号已变化，请移除旧引用并重新核对资料。', 409);
    const retained = previous.some(source => key(source) === key(result) && source.provider === current.provider && source.binding === binding);
    if (item.scope === 'connection' && item.confirmed !== true && !retained) return invalid('整个连接可能包含该账号可检索的全部资料，请老师明确确认后再用于本任务。');
    return result;
  });
  if (new Set(sources.map(key)).size !== sources.length) return invalid('同一个知识来源不能重复选择。');
  return sources;
}

/** Use again immediately before reserving model fees and before returning a
 * result. A failed source never falls back to a different workspace or account. */
export function assertTeachingKnowledgeSources(db: Database, scope: TeachingScope, sources: readonly TeachingKnowledgeSource[]): void {
  teachingMember(db, scope);
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES) return invalid('已保存的知识来源配置无效，请老师重新选择。', 409);
  for (const source of sources) {
    const current = connection(db, scope, source.connectionId);
    if (current.provider !== source.provider || teachingKnowledgeBinding(current) !== source.binding) return invalid('知识授权或已选范围需要重新核对，请老师重新选择并确认资料。', 409,'TEACHING_KNOWLEDGE_BINDING_CHANGED');
    if (!['page', 'connection'].includes(source.scope) || (source.scope === 'page' && (source.provider !== 'notion' || pageId(source.pageId) !== source.pageId)) || (source.scope === 'connection' && source.pageId)) return invalid('已保存的知识范围无效，请老师重新选择。', 409);
  }
}

/** Read exact selected pages, or search only a separately confirmed connection.
 * This returns request-local untrusted reference text; it never synchronizes it. */
export async function readTeachingKnowledgeSources(store: Store, scope: TeachingScope, sources: readonly TeachingKnowledgeSource[], query: string, deps: TeachingKnowledgeDependencies): Promise<TeachingKnowledgeRead> {
  if (typeof query !== 'string' || query.length > 6000) return invalid('知识检索问题过长，请缩短后再试。');
  const snapshot = structuredClone([...sources]);
  const verify = async () => { await deps.verify?.(); assertTeachingKnowledgeSources(await store.read(), scope, snapshot); };
  await verify();
  const result: TeachingKnowledgeRead = { text: '', sources: [] };
  for (const source of snapshot) {
    await verify();
    let title = source.label, text = '';
    try {
      if (source.scope === 'page') {
        if (!deps.notion) return invalid('Notion 页面读取暂不可用，请老师检查连接。', 503);
        const fetched = await deps.notion.readDocument(scope.workspaceId, source.pageId!);
        await verify();
        text = notionBody(fetched);
        title = notionFetchedTitle(fetched)?.slice(0, 300) || source.label;
      } else {
        if (!deps.knowledgeService) return invalid('知识检索暂不可用，请老师检查连接。', 503);
        const recall = await deps.knowledgeService.recallWithDiagnostics(scope.workspaceId, query.trim() || '课程资料', 5, [source.connectionId], scope.userId, { retry: false });
        await verify();
        if (recall.failures.length || ['failed', 'not_connected', 'partial'].includes(recall.status)) {
          const failure=recall.failures[0];
          if(failure?.reason==='scope_required')return invalid('ima 连接已保存，但尚未选择可检索的知识库文件范围。请到知识连接中刷新并选择知识库，再回来试搜；这不代表库内没有内容。',409,'TEACHING_KNOWLEDGE_SCOPE_REQUIRED');
          if(failure?.reason==='content_unavailable')return invalid('ima 已命中资料，但本次未取得可读正文。请到知识连接查看文件读取诊断，或换一个具体问题重试；这些标题尚不能作为回答依据。',422,'TEACHING_KNOWLEDGE_CONTENT_UNAVAILABLE');
          if(failure?.code==='AUTHORIZATION_REQUIRED')return invalid('所选知识连接的授权已失效，请重新连接后再试搜。',403,'TEACHING_KNOWLEDGE_AUTH_REQUIRED');
          if(failure?.code==='PERMISSION_REQUIRED')return invalid('所选资料读取权限不足，请在知识连接中核对账号和资料范围。',403,'TEACHING_KNOWLEDGE_PERMISSION_REQUIRED');
          if(failure?.code==='RATE_LIMITED')return invalid('所选知识库的调用频率已达上限，请稍后再试搜。',429,'TEACHING_KNOWLEDGE_RATE_LIMITED');
          return invalid('本次知识检索未完成。可以重试当前问题；若仍失败，请在知识连接中检查读取诊断。',502,'TEACHING_KNOWLEDGE_SEARCH_FAILED');
        }
        const chunks = recall.chunks;
        if (chunks.some(chunk => chunk.provider && chunk.provider !== source.provider)) return invalid('知识返回范围与本次授权不符，未采用这些资料。', 409);
        if (chunks.some(chunk => typeof chunk.content !== 'string' || chunk.content.length > 24_000 || typeof chunk.title !== 'string' || chunk.title.length > 300)) return invalid('知识返回内容超出本次处理范围，请缩小查询。', 422);
        text = chunks.map(chunk => `【检索片段：${chunk.title}】\n${chunk.content}`).join('\n\n');
      }
    } catch (error) {
      if (error instanceof TeachingError) throw error;
      await verify();
      return invalid(`${source.label}暂时无法完整读取，请老师检查页面权限或连接后再试。`, 502);
    }
    await verify();
    const section = text.trim() ? `【${source.scope === 'page' ? '已选页面正文' : '已确认连接的检索片段，不代表全文'}：${title}】\n${text}` : '';
    if (result.text.length + section.length > MAX_TEXT) return invalid('本次知识资料较多，请老师减少所选页面或按章节处理。', 422);
    if (section) result.text += (result.text ? '\n\n' : '') + section;
    result.sources.push({ label: source.label, title, status: text.trim() ? 'read' : 'no_match' });
  }
  await verify();
  return result;
}
