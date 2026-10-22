/** Explicit restrictions in the current user message outrank old execution plans.
 * Deliberately narrow: “不执行之前的修改” is not a ban on a new read-only run. */
export function discussionOnly(text: string): boolean {
  // A space can precede an object (e.g. “不执行 Git 命令”). Only a
  // clause-ending restriction forbids the whole run, including read-only runs.
  return /(?:^|[，,、。；;：:\n]|\s)(?:本轮|现在|这次|先|暂时)?\s*(?:(?:只讨论|仅讨论|只回答|仅回答)|(?:不执行|不要执行|先不执行|暂不执行)(?=\s*(?:$|[，,、。；;：:])))/u.test(text)
    || /(?:^|[.;:\n])\s*(?:do not execute|do not run|answer only|discussion only)(?=$|[.;:,\s])/i.test(text);
}

/** Only a fresh read of the already bound document, not a status question or
 * an instruction to rerun a previous write. The caller still checks scope. */
export function freshDocumentReadRequested(text:string):boolean {
  if(discussionOnly(text)||/如果|假设|举例|(?:不要|别|不再|不用|不必|不需要|无需|不)(?:再|重新|再次|实际|继续)?(?:只读核对|回读|读取|核对)/.test(text))return false;
  return /^.{0,40}(?:只读核对|实际回读|重新回读|再次回读|(?:回读|读取)本任务)/u.test(text);
}

/** Narrow compatibility signal for a new task's explicitly named destination.
 * Never substitutes for connector ownership, writing grant or configured parent. */
export function notionWriteRequested(text:string):boolean {
  // Payloads/quotations are not authority to write. This is intentionally a
  // narrow fallback; ambiguous language stays in chat instead of gaining tools.
  const request=text.split(/(?:正文|原文|引用|示例|材料|附件内容)(?:如下|内容)?\s*[:：]/u)[0]
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'')
    .replace(/^\s*>.*$/gm,'')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`]*`/g,'');
  if(discussionOnly(request)||/(?:解释|分析|翻译|改写|讨论|举例).{0,16}(?:命令|指令|句子|这句话)/u.test(request))return false;
  const clauses=request.split(/[，,。；;！!？?\n]/u).filter(c=>/\bnotion\b/i.test(c));
  if(clauses.some(c=>/(?:不要|不必|无需|不需要|不用|不能|别|不|暂不|先不).{0,16}(?:保存|写入|写到|写进|新建|创建)|只读|(?:do not|don't|never)\s+(?:save|write|create)/i.test(c)))return false;
  return clauses.some(c=>!/(?:如果|假设|举例|示例|比如|如何|怎么|是否|要不要)|\b(?:if|example|how to|whether)\b/i.test(c)
    && /(?:保存|存|写入|写到|写进)[^，,。；;\n]{0,24}\bnotion\b|(?:在|往|向|到)(?:当前|已选(?:择)?|已授权|选定|选中|我选的|你选的|已有|已经|所选|的|\s)*\bnotion\b[^，,。；;\n]{0,24}(?:新建|创建|保存|写入|写一|写个)|\b(?:save|write|create)\b.{0,40}\b(?:to|in)\s+notion\b/i.test(c));
}
