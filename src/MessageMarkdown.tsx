import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { internalTaskId } from './taskLink';
import { executionReceiptPresentation } from './executionReceiptPresentation';
import { Children, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

function codeText(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{children?: ReactNode}>(child) ? codeText(child.props.children) : '').join('');
}

/** Tools are opt-in for the main conversation; the code remains literal text. */
function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'idle'|'copied'|'failed'>('idle');
  const reset = useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(() => () => { if (reset.current) clearTimeout(reset.current); }, []);
  const code = Children.toArray(children).find(child => isValidElement<{className?: string}>(child));
  const language = isValidElement<{className?: string}>(code) ? /(?:^|\s)language-([^\s]+)/.exec(code.props.className || '')?.[1] : undefined;
  const copy = async () => {
    if (reset.current) clearTimeout(reset.current);
    try {
      await navigator.clipboard.writeText(codeText(children));
      setStatus('copied');
    } catch { setStatus('failed'); }
    reset.current = setTimeout(() => setStatus('idle'), 2000);
  };
  return <div className="one-markdown-code-block">
    <div className="one-markdown-code-toolbar"><span>{language || '代码'}</span><button type="button" onClick={copy} aria-label={status==='failed'?'复制失败，再次复制代码':'复制代码'}><span aria-live="polite">{status==='copied'?'已复制':status==='failed'?'重试复制':'复制代码'}</span></button></div>
    <pre>{children}</pre>
  </div>;
}

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

const messageUrlTransform: UrlTransform = (url, _key, node) => node.tagName === 'a' && localArtifactPath(url) ? url : defaultUrlTransform(url);

/** No raw HTML and no trusted TeX commands from user/model content. */
export function MessageMarkdown({ children, allowImages = true, privateImagesOnly = false, codeTools = false, taskLinkIds, suppressTaskLinks=false, taskLinkBase }: { children: string; allowImages?: boolean; privateImagesOnly?: boolean; codeTools?: boolean; taskLinkIds?:readonly string[]; suppressTaskLinks?:boolean; taskLinkBase?:string }) {
  const taskLinkKey=taskLinkIds?.join('\0')??'';
  const canonicalTasks=useMemo(()=>new Set(taskLinkKey?taskLinkKey.split('\0'):[]),[taskLinkKey]);
  // Scene/attention updates are not new content. Stable renderer identities
  // preserve the code tools, image previews and links instead of re-mounting
  // them and making the conversation's mutation observer announce a new reply.
  const components = useMemo<Components>(() => ({
    ...(codeTools ? { pre: ({children: code}: {children?: ReactNode}) => <MarkdownCodeBlock>{code}</MarkdownCodeBlock> } : {}),
    img: ({src,alt}) => allowImages && typeof src==='string' && src && (!privateImagesOnly || /^\/api\/attachments\/[A-Za-z0-9_-]+\/content$/.test(src)) ? <ImagePreview src={src} alt={alt}/> : null,
    a: ({node: _node, href, children: label, ...props}) => {
      const local = localArtifactPath(href || String(_node?.properties?.href || ''));
      if (local) return <code className="one-local-artifact-path">{local}</code>;
      // A stripped/placeholder model URL must not turn into a link to the homepage.
      if (!href || href === '#') return <span>{label}</span>;
      const task = href ? internalTaskId(href,taskLinkBase||(typeof window!=='undefined'?window.location.href:'https://one.invalid/')) : undefined;
      // A saved message's metadata supplies its single canonical task action.
      // Only real Markdown links are projected: code examples remain literal.
      if(task&&canonicalTasks.has(task))return suppressTaskLinks?null:<span>{label}</span>;
      return <a {...props} href={href} className={task ? 'one-task-result-link' : 'one-conversation-link'}>{label}{task ? <span aria-hidden="true"> ↗</span> : null}</a>;
    },
  }), [allowImages, privateImagesOnly, codeTools,canonicalTasks,suppressTaskLinks,taskLinkBase]);
  const receipt = executionReceiptPresentation(children);
  if (receipt) return <div className="one-local-feedback"><small>{receipt.headline}</small><MessageMarkdown allowImages={allowImages} privateImagesOnly={privateImagesOnly} codeTools={codeTools} taskLinkIds={taskLinkIds} suppressTaskLinks={suppressTaskLinks} taskLinkBase={taskLinkBase}>{receipt.body}</MessageMarkdown><details className="one-result-evidence"><summary>查看操作记录</summary><small>{receipt.provenance}</small>{receipt.originalBody?<pre>{receipt.originalBody}</pre>:null}{receipt.tools ? <pre>{receipt.tools}</pre> : null}</details></div>;
  return <ReactMarkdown urlTransform={messageUrlTransform} components={components} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }]]}>{children}</ReactMarkdown>;
}
