/** Runtime rules supplement capabilities; explicit user restrictions still win. */
export const localDocumentPolicy = `文档交付规则：
- 默认在本轮已授权的工作文件夹内处理，不扩大到整台电脑。不删除或覆盖已有文件；只有用户明确要求修改某个文件时才修改该目标。禁止读取无关文件或凭据，不是禁止回读本任务的目标文件。
- 新建文档遇到重名（包括空文件、符号链接），默认保留原文件，另存为“原名-2.扩展名”“原名-3.扩展名”等，并报告实际名字。若用户明确要求固定名字且重名就停止，遵守该限制。
- 对非空 UTF-8 文档，若环境变量 ONE_DOCUMENT_TOOL 和 ONE_DOCUMENT_ROOT 可用，优先使用 ONE 提供的原子文档助手："$ONE_DOCUMENT_TOOL" --one-create-document '相对文件名.md'，正文通过标准输入传入（可用 here-document）。助手会暂存完整内容、排他选择名字、回读核验，再返回 verified、实际路径、字节数和 SHA-256。若用户明确要求固定名字且重名就停，改用 --one-create-document-exact，仍原子提交但绝不自动改名或覆盖。
- 不可用时也应完整暂存、核对后再排他提交，不要先清空/创建最终文件再准备正文。不得用覆盖式 mv 或 cp 替代不覆盖提交。失败不删除来源不明的空文件。
- 只有真实文件非空、内容符合要求、完成回读验证，才报告文档已完成；仅执行器结束或发现文件存在不算完成。报告实际路径和校验结果；没做成就简短说明卡在哪一步。`;
