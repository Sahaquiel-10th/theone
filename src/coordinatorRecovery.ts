/** User-facing recovery copy. Technical causes stay in owner-scoped diagnostics. */
export function coordinatorRecoveryCopy(reason:string,interrupted=false){
  if(interrupted)return '嗯，回复停下来了。原话还在；如果已经交出了任务，可以到任务区单独停止它。';
  if(/本轮设置的调度上限/.test(reason))return '这次碰到了为本轮设置的使用上限，不是账户没电。已有结果和原要求都保留了；调整这次的预算后，可以只接着做未完成部分。';
  if(/功能未开放|已下架|版本已变更|图片生成尚未配置|能力.*不可用|执行器未授权|执行器已停用|工具未授权|任务功能选择|工具.*就位|功能还没能正确接上/.test(reason))return '好像工具还没就位，这次没能开始。你的要求还在；可以说“继续刚才那件事”，我会先核对已有进展，再安排没做的部分。';
  if(/电力|额度|预算|倍率/.test(reason))return '这次卡在可用电力或使用预算上了，还没能继续安排。可以到“设置 → 会员与额度”查看电力，或告诉我调整这次的预算。';
  if(/ONE[ _-]*Key|^Key(?:连接|已拔出|未插入)/i.test(reason))return 'ONE Key 这会儿没连上，要求还没交出去。确认 Key 插着，再双击盘里的 ONE 恢复连接；然后把原话放回输入框再发就行，我会先核对，不重复安排。';
  // A model/capability catalog is also a “目录”. It is not evidence that the
  // user's computer is disconnected. Name the actual failing domain first.
  if(/executorId|执行模型目录|当前授权目录|漏掉.{0,30}(?:文件|功能)能力|TOOL_INPUT_REPAIR/.test(reason))return '这次还没能选好处理它的能力，尚未开始新的操作。原要求和已有结果都保留着；可以说“继续刚才那件事”，我会先核对可用功能。';
  if(/Notion/i.test(reason))return /授权|权限|连接.*(?:失效|过期)|重新连接/.test(reason)
    ?'Notion 的连接或授权需要确认。到“设置 → 知识连接”检查 Notion；已有内容会保留，不会重复写入。'
    :'Notion 的保存结果还没确认。先核对原页面和这件事的保存进展，不会重新写入。';
  if(/知识来源|知识库|得到大脑|得到笔记|知识读取|资料来源/.test(reason))return '这次还没读到所需的资料。先到“设置 → 知识连接”检查对应来源；已有内容会保留，不会换用别的来源冒充。';
  if(/本机(?:执行)?(?:未连接|尚未连接|连接(?:已)?(?:断开|中断|失效|不可用))|本机执行尚未开始|启动器(?:尚不支持|未连接|连接.*(?:断|失效))|(?:本机|电脑).{0,16}(?:工作区|文件夹|目录).{0,20}(?:未选择|未设置|未授权|不可用)|请先选择.{0,16}(?:本机工作区|ONE.{0,4}工作.{0,4}文件夹)/.test(reason))return '这一步还没接上你的电脑。到“设置 → 本机执行”检查工作区；准备好后告诉我继续，我会先核对已有结果。';
  if(/暂未找到接收记录/.test(reason))return '这句话还没拿到接收确认，原话留着。点“放回输入框”后再发送就行，我会沿用这次的提交编号核对，避免重复安排。';
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
