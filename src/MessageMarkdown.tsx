import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

/** No raw HTML and no trusted TeX commands from user/model content. */
export function MessageMarkdown({ children, allowImages = true }: { children: string; allowImages?: boolean }) {
  return <ReactMarkdown components={allowImages ? undefined : { img: () => null }} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: "ignore", maxExpand: 1000, maxSize: 20 }]]}>{children}</ReactMarkdown>;
}
