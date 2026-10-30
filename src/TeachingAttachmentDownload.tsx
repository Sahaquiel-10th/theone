import { useState } from 'react';
import { Download } from 'lucide-react';
import { teachingDownload } from './teachingDownload';

export function TeachingAttachmentDownload({ courseId, submissionId, attachmentId, slug, token, name }: { courseId: string; submissionId: string; attachmentId: string; slug?: string; token?: string; name?: string }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function download() {
    setBusy(true); setError('');
    const base = slug ? `/api/teaching/public/${encodeURIComponent(slug)}` : `/api/teaching/courses/${encodeURIComponent(courseId)}`;
    try { await teachingDownload(`${base}/submissions/${encodeURIComponent(submissionId)}/attachments/${encodeURIComponent(attachmentId)}/content`, name ?? '作业附件', token); }
    catch (e) { setError(e instanceof Error ? e.message : '下载未完成'); }
    finally { setBusy(false); }
  }
  return <span className="teaching-download"><button type="button" disabled={busy} onClick={() => void download()}><Download size={15} aria-hidden="true"/>{busy ? '正在下载…' : name ?? '下载附件'}</button>{error ? <small role="alert">{error}</small> : null}</span>;
}
