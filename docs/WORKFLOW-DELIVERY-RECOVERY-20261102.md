# 工作流交付与恢复检查（2026-11-02）

## 目标与用户体验

本次从“得到大脑查笔记 → 补案例 → 写专栏 → 保存 Notion”的真实任务入手。原任务先只读诊断，不重写原页；修复后用独立新任务验收完整链路。上一轮 Mac Excel 验收不代替本链路。

| 实际状态 | 系统行为 | 用户应看到的反馈 |
| --- | --- | --- |
| 来源或普通思考已完成 | 复用成果，按顺序进入下一步 | 已完成的步骤与正在处理的步骤 |
| 可选案例检索不可用 | 记录未检索到，不冒充查证；可继续已授权的模型构思 | 哪项可选资料没取到，正文仍可继续 |
| 缺必要素材，用户已补充 | 保留原目标、来源、保存位置；安全条件满足就接着做 | 已收到什么，正在从哪一步继续，不再要求进任务点开始 |
| 保存已发出、暂未确认 | 对同次保存做有界只读核对，不重新生成或重发写入 | 正文是否写好、已找到页面与否、系统仍会自动核对 |
| 格式等价 | 依据版本化比较规则确认，保留代码/正文/链接语义 | 保存完成、页面入口，自动汇报主对话 |
| 正文或标题确实不同 | 停止写入，保留两边，不自动覆盖 | 明确差异类别，以及安全的原文查看/再次只读核对入口 |
| 授权失效或位置改变 | 停止旧轮，指向确切设置项 | 哪里需要重新连接，原文与保存位置是否保留 |
| 用户停止、未知写入或预算限制 | 不因补充内容而擅自重放或越过限制 | 真实停止原因及对应下一步 |

默认汇报不得把文章第一段当失败原因，也不得追加“先核对已有内容后继续未完成部分”这类没有对象、责任人和系统行为的句子。

## 已复现与待核对

- 已复现：direct 补充在特定未创建 Notion 页面条件下只留下补充句，丢失原任务目标/Notion 目标，且 webSearch 固定为 false。
- 已复现：前轮 failed 的暂停状态可阻止新补充自动处理，虽然没有进入写入阶段。
- 已复现：可选工具/功能的不可用被 preflight 当作整单失败；模型构思本来无需垂类功能。
- 已复现：Notion 旧比较规则在无关代码/缩进与加粗/引用混合时退化为整篇字节比较；标题证据缺失也统一记作正文不匹配。
- 当前 Notion 原页已通过已授权 fetch 只读打开，确有完整文章、真实标题、表格、引用、加粗与字面转义符。具体失败必须结合该次保存的原文摘要/参数和工作流记录确认，不能仅据页面存在或合成复现定根因。

## 实施与验收

1. 保留全文正文/来源/保存尝试身份，版本化修比较，诊断仅存类别、摘要与长度。
2. 修同任务补充的目标继承、已证实未写时的自动续做和可选依赖；取消、未知写入、授权和预算限制保持。
3. 结果汇报按真实步骤/保存诊断生成，界面与主对话复用同一说明。
4. 必要单元/集成、跨用户/空间、重放/部分写入反例；完整新任务真实验收，证明原任务没有重写、保存一次、正文不重新生成、回读和主对话终态一致。
5. 类型检查、全量测试、生产构建、diff-check，精确版本上线与健康核对。前端完整源码已在修改前备份到 `/tmp/one-source-before-workflow-20261102.tar.gz`；工作在原隔离 checkout，原脏 Notion 文档不纳入本轮。

本文件记录计划和阶段事实，不能在真实验证前写“已完成”。

## 本次原任务证据与根因

- 精确任务 `cnv_d80b62214aea3feb7748`，仅核对用户授权的 workspace/user；没有重跑或改原文。首轮 `2026-11-02T00:05:58.745Z`：notes 已完成，required 的 cases/web_search 不可用，article/save 等待，Notion receipt 为空。规划 schema 暴露了本轮不能执行的搜索，入队检查与实际执行过滤条件不一致，导致已分派任务在已知缺能力处失败。
- 第二轮 `2026-11-02T00:08:39.142Z`（用户手动继续后）：notes/cases/article 均完成，只 save 失败。对应 request `work_c099fb32f9aa1adde531`，Notion 原页 `40ca5015999181a6a2c5daad73b0e64f`。保存后自动只读重查3次，最终 lastReason=mismatch；不是没有重试，而是错误的比较不会因等待而变对。
- 从该次原模型成果恢复唯一原稿，raw/normalized/v5canonical 三项摘要均与原 receipt 一致，实际页面标题也完全一致。原稿8236字符，含标题的实际回读9292字符；旧v5比较失败。首处是字面 Markdown 星号被 Notion 反斜杠转义，另有11个GFM裸URL回读成同label、同原始URL的显式Markdown link；不是正文丢失。
- 发布前把精确私有case交给新比较器，第一次仍失败，停止发布并继续定位；不能用单格式合成测试通过代替整篇。修正链接语法边界后，v6两边摘要均 `4f64e195fd2e2878f81bb193d608ee3b0b437e51ef880af9cfb04d78ac79e699`。真正强调与字面星号、代码、URL原字节、标题与段落/表格结构仍须保持；未剥正文或格式来凑相等。
- 另查明 MySQL JSON 对象键重排可能阻止同源笔记复用；新路径按id/binding字段与数组顺序精确比较，拒绝变更绑定，不把内存对象序列化顺序当授权事实。
- 原稿全文没有写入版本库或测试fixture；只留最小脱敏结构用例及摘要证据。诊断截图 `output/WRITING-READBACK-DIAGNOSTIC-20261102.jpg`。此前整篇“先转换HTML再parse”的临时诊断不是最终严格证明，最终以保留真实HTML强调边界的v6精确case为准。

## 阶段验证

- 一轮全量2215项，2214通过、0失败、1既有skip；TypeScript及生产构建通过（日志 `/tmp/one-workflow-final-full-20261102.log`、`/tmp/one-workflow-final-build-20261102.log`）。该轮早于真实case最后链接表示修复，不能算最终提交验收；后续检查与上线、原页只读重证、新任务真机闭环须另记。
- UX独审关闭“verified保存却把真实后续HTML失败说成只是进度没同步”的错误推断。保存已核对与整单完成分开，真实后续失败仍报告对应步骤。
- 最终源码冻结后：全量2219项，2218通过、0失败、1既有skip；TypeScript/生产构建/diff-check通过。日志 `/tmp/one-workflow-release-full-20261102.log`、`/tmp/one-workflow-release-build-20261102.log`。前端 `index-Cys_kSC3.js` SHA-256 `fc6d7d77e19fef0995ca97bf862bd87ea142ecc8fad637d5118b7745d7347ca2`。
- 直接口述“上网搜一下/联网查”与开关授权一致，配置不允许时仍0调用；跨天普通澄清保留原任务日期，新明确日期则重新检索，实际query/dateRange以新日期为准，变更来源/对象不复用旧结果。这些是同任务续做的服务回归，不代替线上验收。
- 比较器使用已有依赖树中的精确版本 mdast-util-from-markdown 2.0.3、mdast-util-gfm 3.1.0、micromark-extension-gfm 3.0.0，并显式列为直接依赖；旧比较协议不变。独审与精确私有case均通过。此处仍待精确版本上线、原页只读重证及新完整任务真实验收，不声称已经上线或所有任务永不失败。

## 首次发布与真实验收发现

- 源码 `620ee9022a08436265140068e078f7a3c9ccb3c6` 的三平台 CI verify 全部通过。自动部署连接/传输耗时后取消；取消日志显示曾进入远端测试，故不能把整段都归因于传输。确认旧进程与该 SHA 工作目录进程均已退出后，使用 SHA-256 `9932a06f658af34d0bc54d064f58e74310a94cae21d937f2e2b5d81fb6063ee2` 的同源码包，单次执行原 `theone-deploy`，未省略原检查。退出0，服务 active、current 精确指向该 SHA，公开健康200及 JS 字节/摘要一致。服务器日志 `/home/ubuntu/one-deploy-620ee90-20261102.log`。
- 原专栏点击一次只读核对，receipt 已 verified、comparison 使用 v6 matched；原页面最后编辑时间前后仍是 `2026-11-02T00:13:05.319Z`。但旧 workflow 仍未完成：原 save 在异常出口丢失 `notionCheckpointKey`，且旧 completion 只识别平铺工具名，不识别 workflow 内已完成的实际检索。因此 receipt 成功不能直接推断整单成功，继续修严格证明衔接。
- 新独立 `ONE-QA-WRITING-1102-A` 经主对话一次提交，输出选项为“对话中”，仅口述联网与保存 Notion。实际 notes、official/web、draft 全完成，保存到唯一新页 `40ca5015999181ca8c84fe6f00c399f1`，但3次自动只读核对后仍 mismatch；真实验收不通过，不能以测试绿或页面存在宣称已解决。
- 精确 QA-A 原稿825字符、回读含标题930字符，raw/legacy-normalized/v6canonical 三项与同次 receipt 全绑定。唯一未识别表示是原稿行内代码反引号与 Notion `<code>ONE-QA</code>`；v6 的全代码字节保护安全但过严。新增 v7，仅比较完全相同的单行纯文本 inline-code typed 节点，保留旧 v6 摘要含义。两篇精确对照 v7 均须通过，QA-A 摘要 `290595ea797332acf6ade4aa211b43c5a31e7f7c99d7975d671884b7029cfc09`。原稿不纳入 git。
- 后续收尾仅允许同次唯一写入、精确 raw/normalized/原 canonical 摘要、完整 owner/revision/marker 及必需步骤和时序证明；不靠正文相似或页面标题推断成功。独审补查重复 checkpoint 与无关旧读取证明，不能让这些记录把真实失败洗成完成。
- 后续源码最终冻结后全量2251项，2250通过、0失败、1既有skip，日志 `/tmp/one-writing-v7-final-full-20261102.log`。独审确认重复stage/worker及借旧读取时序的两处证明漏洞已拒绝；v7精确case通过，代码变化/属性/多行/实体等反例仍拒绝。发布及新完整任务最终结果待后记。

## v7 上线、原任务收尾与第二次真实验收

- `ca0dd0d5c7bb3414ac46bd22aa4e9e23c603fe21` 的 CI run `41383042836` 四个 job 全部 success，自动部署于北京时间11:37:35完成；未取消或并行发布。另备份上传的同SHA源码包未执行部署。root确认 current 精确指向该 SHA、service active；11:38:05公开 health/首页200，JS与前次同摘要/字节。
- 原专栏与 QA-A 分别从页面执行一次只读核对，均自动收尾为4/4、job completed/outcome completed、receipt verified、comparison v7 matched，主对话自动出现已完成回执。各仅1条原worker/save检查点；未追加生成/写入。原稿 Notion 最后编辑时间仍 `00:13:05.319Z`，QA-A仍 `03:01:13.060Z`。root独立精确原稿/回读v7比较也通过，原专栏摘要 `046c700dda0f9ea68420ab3ff9a823b70131068f1aa6f77b9180a286b408c94f`。界面证据 `output/WRITING-ORIGINAL-READONLY-ACCEPTED-20261102.jpg`。
- 新 `ONE-QA-WRITING-1102-B` 一次提交后未创建任务、未保存文章。精确main trace `ctx_d2763171453d3fc7ad40` / request `coord_4b208f98019b10d70b9e`：三次delegate被拒，其中一份合规参数引用了目录真实知识卡和公开搜索卡，却被resolver当作不可分派功能拒绝；另两次参数形状未修正。仅主对话知识读取发生，公开搜索未调用；提示“公开搜索没查成”归因错误，不能说是供应商失败。
- 横查又发现“云端写作，不操作本机”会把否定句里的本机词当目标，导致有连接时错误确认、无连接时拦住云任务。改为同一正向语句证明动作和本机目标，ready/offline/unavailable三态均0本机检查、0本机执行、1正常云任务；真实本机和禁止删除局部限制仍保留。
- 知识卡仅解析为server-only精确source引用并绑定必需knowledge_search；公开搜索卡仅绑定必需web_search，不伪装feature/executor。当前scope、显式来源、禁止读取、撤权和worker工具权限均重新核对；固定图片/本机入口暂不支持混读卡时入队前拒绝，不静默丢步骤。显式single本机入口按真实mode送同一resolver，不能借已归一的文字executor绕过。
- 主对话联网检查统一使用口述/开关合成的有效授权。已成功交接的同轮child必须有web必需contract或workflow步骤证明，才移除重复的main查询义务；不把任意child当已查询。未调用与真实调用失败区分，分派参数卡住不再误报搜索失败；原参数修正提示补上本就合法的workflow字段。
- 一轮全量2263/2262通过/0失败/1既有skip，早于最后固定分支与确认回执收口，不作为最终新源码验收。后续检查及新任务完整结果另记。
- 最终冻结后的全量2266项：2265通过、0失败、1既有skip，日志 `/tmp/one-writing-routing-release-full-20261102.log`。最后新增本机raw requiredTools反例：native child不能满足main查询义务，已接到任务时也不引导整条重发。单/批知识+公开卡正例用自然确认收尾，均1任务/每项实际read各1次/worker1次；无额外main查询。最终构建与新源码发布结果待后记。

## 9b0a2e6 发布与 C 验收

- `9b0a2e62f22dced3e8b16f72eb13ed1f01c00983` 三平台 CI verify 全通过（run `41388043578`），自动发布在收源阶段连续数分钟仍为 tar。上传 SHA-256 `0a4d93b14ab6903ae19cf9e4cdbe3546b9c35d88930fe8725266e51d5e0be5ed` 的同SHA gzip包后取消该次自动deploy，确认workflow cancelled、同SHA进程/cwd均空、current仍旧版，才单次执行原部署脚本（PID1159240）。远端实际2266项测试/2265通过/0失败/1skip、构建和只读schema gate均过，exit0、current精确9b0、service active；原脚本没有修改DB或schema。日志 `/home/ubuntu/one-deploy-9b0a2e6-20261102.log`。
- 12:42:32北京时间公开health/首页200，JS `index-bclQcIUN.js` 为1463144字节，SHA-256 `8b8dda19b52a9cbdfab49fd7bd7389930859894d2815c46d85ed90c345ff22b7` 与本地相同。上线证据 `output/WRITING-RELEASE-9b0a2e6-20261102.jpg`。
- 全新 `ONE-QA-WRITING-1102-C` 仅从普通主对话发送一次，输出选“对话中”，口述查得到大脑、查OXO官方、写稿、保存Notion，另明确不要操作本机。main正常回复云任务接收；notes/web/draft/save全4/4完成，初次保存回读即verified v7、无延后核对或手动继续，任务动态自动收起、主对话自动出现已完成和原页链接。任务 `cnv_204f8fa3b5c088557e84` / request `work_885c0b6c4506ed629559` / Notion `40ca5015999181adb0c5e886b4f53a9c`；同次只有一条worker/save检查点。原稿/回读canonical digest均 `6f7a4d77376678e4bb9b80a4dd0527599fb696388df10de4ac9cbccd697818a8`。独立fetch确认正文、表格、强调、代码及来源链接存在。UI证据 `output/WRITING-C-AUTOMATIC-MAIN-ACCEPTED-20261102.jpg`、`output/WRITING-C-FOUR-STEPS-ACCEPTED-20261102.jpg`。
- C 的执行保存回执闭环通过，但成稿多附了写作阶段的“汇报/后续尚未保存”说明；已保存后读起来会矛盾，不能以机械链路通过冒充正文体验完全通过。保留C原样，不静默清洗或重写。补强 model 输出约定：content仅成果正文，summary/outcome说明当前步骤，全流程状态由平台说明。整单完成且最后实际阶段是严格已验证Notion，主汇报使用该阶段已验证摘要；后续HTML失败/未知保存不据此报全完成。
- 这组窄修复冻结后全量2267项：2266通过、0失败、1既有skip（`/tmp/one-writing-content-final-full-20261102.log`）。定向与独立复核明确不会strip既有原稿或放宽Notion证明；新生成能否遵守约定仍待D真实验收。
