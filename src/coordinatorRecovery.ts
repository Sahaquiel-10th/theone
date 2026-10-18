/** User-facing recovery copy. Technical causes stay in owner-scoped diagnostics. */
export function coordinatorRecoveryCopy(reason:string,interrupted=false){
  if(interrupted)return '嗯，回复停下来了。原话还在；如果已经交出了任务，可以到任务区单独停止它。';
  if(/功能未开放|已下架|版本已变更|图片生成尚未配置|能力.*不可用|执行器未授权|工具未授权|任务功能选择|工具.*就位/.test(reason))return '好像工具还没就位，这次没能开始。你的要求还在；可以说“继续刚才那件事”，我会先核对已有进展，再安排没做的部分。';
  if(/电力|额度|预算|倍率/.test(reason))return '这次卡在可用电力或使用预算上了，还没能继续安排。可以到“设置 → 会员与额度”查看电力，或告诉我调整这次的预算。';
  if(/目录|文件夹|本机|启动器|Key/.test(reason))return '这一步还没接上你的电脑。先确认 ONE Key 已连接，再到“设置 → 本机执行”检查工作区；准备好后告诉我继续，我会先核对已有结果。';
  if(/暂未找到接收记录/.test(reason))return '这句话还没拿到接收确认。原话留着，先别重复发送；连接恢复后我会再核对是否已收到。';
  return '这次回复中断了，我还不能确认事情做到哪一步。原话已经留着；可以说“看看刚才那件事”，我会先核对进展，不会直接重做。';
}

/** A promise of action is not a dispatch receipt. Questions and ordinary advice remain ordinary chat. */
export function dispatchCommitment(content:string){
  if(/[？?]\s*$/.test(content)||/(?:如果|等你|等到|下次|以后|需要时)/.test(content))return false;
  // A direct answer that already contains the requested text is not an empty
  // promise. Nor should an honest unavailable-tool reply force more execution.
  if(/(?:尚未|还没|没能)开始|工具[^。\n]{0,40}(?:不可用|没就位)|无法(?:执行|开始|生成)/.test(content))return false;
  if(!/(?:已经|已)(?:分派|安排|启动|排队|开工)/.test(content)&&/(?:如下|下面是|整理好了)[：:]|\n(?:#{1,6}\s|[-*]\s|\d+[.、]\s?)/.test(content))return false;
  return /(?:我(?:会|来|将|这就|现在就)[\s\S]{0,90}(?:制作|生成|绘制|画|做成|整理|安排|保存|交付|处理)|(?:已经|已)(?:分派|安排|启动|排队|开工)|开始(?:制作|生成|执行))/.test(content);
}
