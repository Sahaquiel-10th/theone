import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { internalTaskId } from './taskLink';
import { executionReceiptPresentation } from './executionReceiptPresentation';

export function ImagePreview({src,alt='图片'}:{src:string;alt?:string}) {
  return <button type="button" className="one-image-preview" aria-label={`查看大图：${alt}`} onClick={()=>window.open(src,'_blank','noopener,noreferrer')}>
    <img src={src} alt={alt} loading="lazy"/><span>查看大图 ↗</span>
  </button>;
}
export const hasInlineImage=(markdown:string,url:string)=>[...markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g)].some(match=>match[1]===url);

/** Local artifacts are not website routes and cannot be opened by an ordinary web link. */
function localArtifactPath(href: string | undefined): string | undefined {
  if (!href) return;
  let path = href;
  if (/^file:\/\//i.test(path)) {
    try { path = decodeURIComponent(new URL(path).pathname); } catch { return; }
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return path;
  }
  return /^(?:\/(?:Users|Volumes|home|tmp|private|mnt|var|opt|Applications)\/|[A-Za-z]:[\\/]|\\\\)/.test(path) ? path : undefined;
}

/** No raw HTML and no trusted TeX commands from user/model content. */
export function MessageMarkdown({ children, allowImages = true }: { children: string; allowImages?: boolean }) {
  const receipt = executionReceiptPresentation(children);
  if (receipt) return <div className="one-local-feedback"><small>{receipt.headline}</small><MessageMarkdown allowImages={allowImages}>{receipt.body}</MessageMarkdown><details className="one-result-evidence"><summary>查看操作记录</summary><small>{receipt.provenance}</small>{receipt.tools ? <pre>{receipt.tools}</pre> : null}</details></div>;
  return <ReactMarkdown urlTransform={(url, _key, node) => node.tagName === 'a' && localArtifactPath(url) ? url : defaultUrlTransform(url)} components={{
    img: ({src,alt}) => allowImages && typeof src==='string' && src ? <ImagePreview src={src} alt={alt}/> : null,
    a: ({node: _node, href, children: label, ...props}) => {
      const local = localArtifactPath(href || String(_node?.properties?.href || ''));
      if (local) return <code className="one-local-artifact-path">{local}</code>;
      const task = href && typeof window !== 'undefined' ? internalTaskId(href, window.location.href) : undefined;
      return <a {...props} href={href} className={task ? 'one-task-result-link' : 'one-conversation-link'}>{label}{task ? <span aria-hidden="true"> ↗</span> : null}</a>;
    },
  }} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }]]}>{children}</ReactMarkdown>;
}
