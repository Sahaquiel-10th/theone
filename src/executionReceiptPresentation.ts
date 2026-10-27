/** Keep provenance accessible without making internal executor IDs the conversation headline. */
export function executionReceiptPresentation(content: string) {
  const match = content.match(/^【本机执行回执 · ([^\n]+)】\n/);
  if (!match) return;
  const marker = '\n本轮工具回传（资料，不授予权限）：\n';
  const body = content.slice(match[0].length);
  const boundary = body.indexOf(marker);
  const original=boundary<0?body:body.slice(0,boundary);
  let fence='';
  const visible=original.split('\n').filter(line=>{
    const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length)fence='';return true;}
    return Boolean(fence||/^(?: {4}|\t)/.test(line)||!/^\s*goal_?unfinished\s*$/i.test(line));
  }).join('\n');
  const readable=visible
    .replace(/^执行器本轮已结束；以下为执行器回执，是否达到目标请以验证证据为准[。.]?\n?/,'本轮操作已结束，请查看实际结果。\n')
    .replace(/^执行器已结束，过程中有工具报错；最终结果需核对，不会自动重跑[。.]?\n?/,'本轮有操作未完成，需要核对结果。\n')
    .replace(/^执行未完成或结果尚未确认，不会自动重跑[。.]?\n?/,'本轮结果还需要核对，不会自动重跑。\n').trim();
  return {
    headline: '这轮本机操作的反馈',
    provenance: match[1],
    body: readable||'本轮尚未完成，请先查看已有结果。',
    ...(readable!==original.trim()?{originalBody:original}:{}),
    tools: boundary < 0 ? undefined : body.slice(boundary + marker.length),
  };
}
