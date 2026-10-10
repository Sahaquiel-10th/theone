/** Explicit restrictions in the current user message outrank old execution plans.
 * Deliberately narrow: “不执行之前的修改” is not a ban on a new read-only run. */
export function discussionOnly(text: string): boolean {
  return /(?:^|[，,、。；;：:\n]|\s)(?:本轮|现在|这次|先|暂时)?\s*(?:(?:只讨论|仅讨论|只回答|仅回答)|(?:不执行|不要执行|先不执行|暂不执行)(?=$|[，,、。；;：:\s]))/u.test(text)
    || /(?:^|[.;:\n])\s*(?:do not execute|do not run|answer only|discussion only)(?=$|[.;:,\s])/i.test(text);
}
