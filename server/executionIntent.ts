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
