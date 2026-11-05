import { useEffect, useMemo, useRef, useState } from 'react';
import { apiForUser, currentApiIdentity } from './oneApi';
import { CommerceWorkspace } from './Commerce';
import { ImageEditWorkspace } from './ImageEdit';
import { ReviewRepliesWorkspace } from './ReviewReplies';
import { IndustryFilesContext } from './IndustryFiles';
import { createIndustryClient, readIndustryPending, type IndustryClientSession, type PendingIndustryRequest } from './industryClient';
import type { CommerceWorkspaceKind } from './industryWorkspaceState';
import type { IndustryReceipt } from '../server/industryState';
import './commerce-industry.css';

export function CommerceIndustryTool({ kind, onBack, onOpenSidebar = () => {} }: { kind: CommerceWorkspaceKind; onBack: () => void; onOpenSidebar?: () => void }) {
  const [identity] = useState(currentApiIdentity), request = useMemo(() => apiForUser(identity.userId, identity.workspaceId), [identity]);
  const scope = `${identity.workspaceId}:${identity.userId}:${kind}`, pendingKey = `one-industry-pending:v1:${scope}`;
  const [session, setSession] = useState<IndustryClientSession | undefined>(), sessionRef = useRef(session); sessionRef.current = session;
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pending, setPending] = useState(() => readIndustryPending(sessionStorage, pendingKey)), [retryable, setRetryable] = useState<string[]>([]);
  const live = useRef(true), confirmKey = useRef(crypto.randomUUID()), initializing = useRef<Promise<IndustryClientSession>|undefined>(undefined);
  const activeSession = () => sessionRef.current && sessionRef.current.expiresAt > new Date().toISOString() ? sessionRef.current : undefined;
  const client = useMemo(() => createIndustryClient(request, { tool: kind, storage: sessionStorage, storageKey: pendingKey,
    session: activeSession, ensureSession, onPending: setPending }), [request, kind, pendingKey]);
  const filesContext = useMemo(() => ({ identity, onError: setError }), [identity]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function ensureSession():Promise<IndustryClientSession> {
    const existing=activeSession();if(existing)return existing;
    if(initializing.current)return initializing.current;
    initializing.current=(async()=>{const result=await request<{session:IndustryClientSession}>('/api/industry/usage-sessions',{method:'POST',body:JSON.stringify({tool:kind,requestKey:confirmKey.current})});if(!live.current)throw new Error('已离开工作台，未提交操作。');sessionRef.current=result.session;setSession(result.session);confirmKey.current=crypto.randomUUID();return result.session;})();
    try{return await initializing.current;}finally{initializing.current=undefined;}
  }
  async function checkOriginal(item: PendingIndustryRequest) {
    setError('');
    setRetryable(old => old.filter(key => key !== item.requestKey));
    try {
      const query = new URLSearchParams({ tool: kind, path: item.path });
      const { receipt } = await request<{ receipt: IndustryReceipt }>(`/api/industry/receipts/${encodeURIComponent(item.requestKey)}?${query}`);
      if (receipt.requestKey !== item.requestKey) throw new Error('原操作编号尚未核对');
      setNotice(receipt.message);
      if (receipt.retryAllowed && ['failed', 'interrupted', 'uncertain', 'not_accepted'].includes(receipt.status)) setRetryable(old => [...new Set([...old, item.requestKey])]);
    } catch {
      setNotice('尚未精确核对原操作，请先从下方任务历史查看。再次点原操作会沿用原编号；未开启新的付费尝试。');
    }
  }
  return <IndustryFilesContext.Provider value={filesContext}><div className="industry-tool-shell">
    {error ? <p className="industry-tool-error" role="alert">{error}</p> : null}{notice ? <p className="industry-tool-notice" role="status">{notice}</p> : null}
    {pending.length ? <details className="industry-pending"><summary>有 {pending.length} 步操作的回执待核对</summary><p>再次点原操作会沿用原编号。查询和查看已有记录不调用模型。</p>{pending.map(item => <div key={item.requestKey}><span>{/recognize/.test(item.path) ? '资料或截图识别' : /refine/.test(item.path) ? '继续优化' : /jobs|edits/.test(item.path) ? '图片任务' : 'AI 辅助操作'}</span><button type="button" onClick={() => void checkOriginal(item)}>核对原请求</button>{retryable.includes(item.requestKey) ? <button type="button" onClick={() => { void (async()=>{try { await client.prepareExplicitRetry(item.requestKey); setRetryable([]); setNotice('原记录已保留。再次点击该操作时，将独立重新执行，可能再次产生费用。'); } catch (error) { setError(error instanceof Error ? error.message : '工作台暂时未连接'); }})(); }}>保留记录，另开操作（可能再次计费）</button> : null}</div>)}</details> : null}
    {kind === 'product_creative' ? <CommerceWorkspace key={scope} api={client.request} userId={scope} agentId="industry-commerce-main" onBack={onBack} onOpenSidebar={onOpenSidebar}/> : kind === 'image_edit' ? <ImageEditWorkspace key={scope} api={client.request} userId={scope} agentId="industry-image-edit" onBack={onBack} onOpenSidebar={onOpenSidebar}/> : <ReviewRepliesWorkspace key={scope} api={client.request} userId={scope} agentId="review_reply" onBack={onBack} onOpenSidebar={onOpenSidebar}/>}
  </div></IndustryFilesContext.Provider>;
}
