import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { internalTaskId } from './taskLink';
import { executionReceiptPresentation } from './executionReceiptPresentation';

/** No raw HTML and no trusted TeX commands from user/model content. */
export function MessageMarkdown({ children, allowImages = true }: { children: string; allowImages?: boolean }) {
  const receipt = executionReceiptPresentation(children);
  if (receipt) return <div className="one-local-feedback"><small>{receipt.headline}</small><MessageMarkdown allowImages={allowImages}>{receipt.body}</MessageMarkdown><details className="one-result-evidence"><summary>查看操作记录</summary><small>{receipt.provenance}</small>{receipt.tools ? <pre>{receipt.tools}</pre> : null}</details></div>;
  return <ReactMarkdown components={{
    ...(!allowImages ? { img: () => null } : {}),
    a: ({node: _node, href, children: label, ...props}) => {
      const task = href && typeof window !== 'undefined' ? internalTaskId(href, window.location.href) : undefined;
      return <a {...props} href={href} className={task ? 'one-task-result-link' : 'one-conversation-link'}>{label}{task ? <span aria-hidden="true"> ↗</span> : null}</a>;
    },
  }} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }]]}>{children}</ReactMarkdown>;
}
