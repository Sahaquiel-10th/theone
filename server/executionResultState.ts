/** Conservative presentation guard; never changes a terminal receipt or grants authority. */
export function executionExplicitlyUnfinished(answer: string | undefined) {
  const text=answer||'';
  // Only a complete hygiene clause after a positive artifact result is
  // incidental. A backup alone may be the requested target; qualifiers,
  // larger object lists and every other explicit failure remain untouched.
  const completedResult=/(?:^|[。；;\n])\s*(?:[-*]\s*)?已(?:原地|实际)?(?:创建|生成|修改|保存|写入)/u.test(text);
  // An explicit required-deliverable description in the same sentence or
  // semicolon group is not a hygiene note, even after another file changed.
  const requiredAncillary=/(?:备份|临时文件)[^。\n]{0,80}(?:要求|指定|必需|必须|最终交付|目标产物)/u.test(text);
  const result=completedResult&&!requiredAncillary?text.replace(/(^|[，,。；;\n])\s*(?:[-*]\s*)?(?:未创建|没有创建)(?:任何)?(?:备份(?:文件)?(?:或|和|及|、)临时文件|临时文件(?:或|和|及|、)备份(?:文件)?)(?=\s*(?:[，,。；;\n]|$))/gu,'$1'):text;
  return /停止操作|未完成回读|未能(?:创建|写入|完成)|无法确认|尚未(?:创建|完成)|(?:未创建|没有创建)(?!(?:或修改|、修改)?(?:任何)?(?:其他|其它|无关|额外))/.test(result);
}
