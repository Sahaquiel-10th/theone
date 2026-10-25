/** Explicit restrictions in the current user message outrank old execution plans.
 * Deliberately narrow: “不执行之前的修改” is not a ban on a new read-only run. */
export function discussionOnly(text: string): boolean {
  // A space can precede an object (e.g. “不执行 Git 命令”). Only a
  // clause-ending restriction forbids the whole run, including read-only runs.
  return /(?:^|[，,、。；;：:\n]|\s)(?:本轮|现在|这次|先|暂时)?\s*(?:(?:只讨论|仅讨论|只回答|仅回答)|(?:不执行|不要执行|先不执行|暂不执行)(?=\s*(?:$|[，,、。；;：:])))/u.test(text)
    || /(?:^|[.;:\n])\s*(?:do not execute|do not run|answer only|discussion only)(?=$|[.;:,\s])/i.test(text);
}

function currentRequest(text:string){
  return text.split(/(?:正文|原文|引用|示例|材料|附件内容)(?:如下|内容)?\s*[:：]/u)[0]
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'')
    .replace(/^\s*>.*$/gm,'')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'|`[^`]*`/g,'');
}
/** A restriction on creating another task is not a ban on updating the
 * existing one. This classifies intent only; handlers still verify its ID. */
export function existingTaskActionRequested(text:string,boundTaskId?:string){
  const request=currentRequest(text);
  if(discussionOnly(request)||/先讨论|先不做|先别做|怎么做|如何做|能不能做|是否可以|假设|举例/.test(request))return false;
  const positive=request.replace(/(?:不要|不用|不必|不需要|别)[^，,。；;\n]{0,60}/g,'');
  return Boolean(boundTaskId&&/继续|接着|修改|更新|补充|补一句|补齐|完善|重写|删去|删除/.test(positive))
    ||/(?:继续|接着)(?:处理|完成|修改|写|做)?(?:同一(?:件|个)|这(?:件|个)|原(?:来|先)?(?:的)?(?:任务|事情)|已有(?:的)?(?:任务|事情))|(?:修改|更新|修订|编辑|删去|删除|完善|补充)(?:当前|已有|原来|原|这(?:篇|件|个))[^，,。；;\n]{0,12}(?:任务|事情|正文|原文|页面|草稿|文章)/.test(positive);
}
export function coordinatorTaskIntent(text:string,boundTaskId?:string){
  const request=currentRequest(text),onlyAnswer=discussionOnly(request);
  const creationBan=/(?:不要|不用|无需|不必|不需要|禁止|别|不)(?:再|重新)?(?:创建|新建|另建|新开|分派|建)(?:一个|新的|独立)?(?:任务|事情)|(?:don't|do not)\s+create\s+(?:a\s+)?task/i.test(request);
  const existingTaskOnly=!onlyAnswer&&creationBan&&existingTaskActionRequested(request,boundTaskId);
  return {answerOnly:onlyAnswer||creationBan&&!existingTaskOnly,existingTaskOnly};
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
