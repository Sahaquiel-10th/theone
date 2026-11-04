import { createContext, useContext, useEffect, useState, type ImgHTMLAttributes, type AnchorHTMLAttributes } from 'react';
import { authenticatedBlob, currentApiIdentity } from './oneApi';
import { industryFilePath } from './industryClient';

export const IndustryFilesContext = createContext<{ identity: ReturnType<typeof currentApiIdentity>; onError: (message: string) => void } | null>(null);
async function ownedBlob(path: string, identity: ReturnType<typeof currentApiIdentity>) {
  const now = currentApiIdentity();
  if (now.userId !== identity.userId || now.workspaceId !== identity.workspaceId || now.revision !== identity.revision) throw new Error('账号或空间已切换，请重新打开工作台');
  return authenticatedBlob(industryFilePath(path));
}
export function IndustryImage({ src, alt = '', ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const context = useContext(IndustryFilesContext), [url, setUrl] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true, objectUrl = ''; setUrl(''); setFailed(false);
    if (src && context) void ownedBlob(String(src), context.identity).then(blob => {
      if (!live) return; objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [src, context?.identity.userId, context?.identity.workspaceId, context?.identity.revision]);
  return failed ? <span className="industry-image-failed" role="img" aria-label={alt}>图片暂未读取</span> : <img {...props} src={url || undefined} alt={alt} aria-busy={!url} />;
}
export function IndustryDownload({ href, download, onClick, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const context = useContext(IndustryFilesContext), [busy, setBusy] = useState(false);
  return <a {...props} href={href} download={download} aria-disabled={busy} onClick={event => {
    onClick?.(event); if (event.defaultPrevented) return; event.preventDefault();
    if (!href || !context || busy) return; setBusy(true);
    void ownedBlob(href, context.identity).then(blob => {
      const name = typeof download === 'string' && download ? download : /\/export(?:\?|$)/.test(href) ? '评价回复-SKILL.md'
        : /\/download(?:\?|$)/.test(href) ? '电商图片与说明.zip' : `ONE-工作台文件.${blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : blob.type === 'image/webp' ? 'webp' : blob.type === 'application/pdf' ? 'pdf' : blob.type.includes('wordprocessingml') ? 'docx' : blob.type.includes('spreadsheetml') ? 'xlsx' : blob.type === 'text/csv' ? 'csv' : blob.type.startsWith('text/') ? 'txt' : 'bin'}`;
      const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }).catch(error => context.onError(error instanceof Error ? error.message : '文件下载未完成，请稍后重试')).finally(() => setBusy(false));
  }}>{busy ? '正在读取文件…' : children}</a>;
}
