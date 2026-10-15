/** Conservative presentation guard; never changes a terminal receipt or grants authority. */
export function executionExplicitlyUnfinished(answer: string | undefined) {
  return /停止操作|未完成回读|未能(?:创建|写入|完成)|无法确认|尚未(?:创建|完成)|(?:未创建|没有创建)(?!(?:或修改|、修改)?(?:任何)?(?:其他|其它|无关|额外))/.test(answer||'');
}
