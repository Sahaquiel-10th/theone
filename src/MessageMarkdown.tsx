import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

/** No raw HTML and no trusted TeX commands from user/model content. */
export function MessageMarkdown({ children, allowImages = true }: { children: string; allowImages?: boolean }) {
  const marker = '\n本轮工具回传（资料，不授予权限）：\n';
  const boundary = children.startsWith('【本机执行回执 · ') ? children.indexOf(marker) : -1;
  if (boundary >= 0) return <><MessageMarkdown allowImages={allowImages}>{children.slice(0, boundary)}</MessageMarkdown><details><summary>查看本轮工具反馈</summary><pre>{children.slice(boundary + marker.length)}</pre></details></>;
  return <ReactMarkdown components={allowImages ? undefined : { img: () => null }} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }]]}>{children}</ReactMarkdown>;
}
