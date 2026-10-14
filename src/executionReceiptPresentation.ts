/** Keep provenance accessible without making internal executor IDs the conversation headline. */
export function executionReceiptPresentation(content: string) {
  const match = content.match(/^【本机执行回执 · ([^\n]+)】\n/);
  if (!match) return;
  const marker = '\n本轮工具回传（资料，不授予权限）：\n';
  const body = content.slice(match[0].length);
  const boundary = body.indexOf(marker);
  return {
    headline: '这轮本机操作的反馈',
    provenance: match[1],
    body: boundary < 0 ? body : body.slice(0, boundary),
    tools: boundary < 0 ? undefined : body.slice(boundary + marker.length),
  };
}
