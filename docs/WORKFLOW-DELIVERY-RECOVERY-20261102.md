# 工作流交付与恢复检查（2026-11-02）

## 目标与用户体验

本次从“得到大脑查笔记 → 补案例 → 写专栏 → 保存 Notion”的真实任务入手。原任务先只读诊断，不重写原页；修复后用独立新任务验收完整链路。上一轮 Mac Excel 验收不代替本链路。

| 实际状态 | 系统行为 | 用户应看到的反馈 |
| --- | --- | --- |
| 来源或普通思考已完成 | 复用成果，按顺序进入下一步 | 已完成的步骤与正在处理的步骤 |
| 可选案例检索不可用 | 分开记录未执行、调用失败与无命中，不冒充查证；可继续已授权的模型构思 | 哪项可选资料没取到，正文仍可继续 |
| 缺必要素材，用户已补充 | 保留原目标、来源、保存位置；安全条件满足就接着做 | 已收到什么，正在从哪一步继续，不再要求进任务点开始 |
| 保存已发出、暂未确认 | 对同次保存做有界只读核对，不重新生成或重发写入 | 正文是否写好、已找到页面与否、系统仍会自动核对 |
| 格式等价 | 依据版本化比较规则确认，保留代码/正文/链接语义 | 保存完成、页面入口，自动汇报主对话 |
| 正文或标题核对仍不一致 | 暂停后续处理，保留两边，不自动覆盖；先区分表示差异与真实改动 | 明确差异类别，以及安全的原文查看/再次只读核对入口 |
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
- 横查又发现“云端写作，不操作本机”会把否定句里的本机词当目标，导致有连接时错误确认、无连接时拦住云任务。改为同一正向语句证明动作和本机目标，离线合成回归中ready/offline/unavailable三态均0本机检查、0本机执行、1正常云任务；真实本机和禁止删除局部限制仍保留。
- 知识卡仅解析为server-only精确source引用并绑定必需knowledge_search；公开搜索卡仅绑定必需web_search，不伪装feature/executor。当前scope、显式来源、禁止读取、撤权和worker工具权限均重新核对；固定图片/本机入口暂不支持混读卡时入队前拒绝，不静默丢步骤。显式single本机入口按真实mode送同一resolver，不能借已归一的文字executor绕过。
- 主对话联网检查统一使用口述/开关合成的有效授权。已成功交接的同轮child必须有web必需contract或workflow步骤证明，才移除重复的main查询义务；不把任意child当已查询。未调用与真实调用失败区分，分派参数卡住不再误报搜索失败；原参数修正提示补上本就合法的workflow字段。
- 一轮全量2263/2262通过/0失败/1既有skip，早于最后固定分支与确认回执收口，不作为最终新源码验收。后续检查及新任务完整结果另记。
- 最终冻结后的全量2266项：2265通过、0失败、1既有skip，日志 `/tmp/one-writing-routing-release-full-20261102.log`。最后新增本机raw requiredTools反例：native child不能满足main查询义务，已接到任务时也不引导整条重发。单/批知识+公开卡正例用自然确认收尾，均1任务/每项实际read各1次/worker1次；无额外main查询。最终构建与新源码发布结果待后记。

## 9b0a2e6 发布与 C 验收

- `9b0a2e62f22dced3e8b16f72eb13ed1f01c00983` 三平台 CI verify 全通过（run `41388043578`），自动发布在收源阶段连续数分钟仍为 tar。上传 SHA-256 `0a4d93b14ab6903ae19cf9e4cdbe3546b9c35d88930fe8725266e51d5e0be5ed` 的同SHA gzip包后取消该次自动deploy，确认workflow cancelled、同SHA进程/cwd均空、current仍旧版，才单次执行原部署脚本（PID1159240）。远端实际2266项测试/2265通过/0失败/1skip、构建和只读schema gate均过，exit0、current精确9b0、service active；没有人工修改业务数据或执行schema迁移，不将只读schema gate泛化为运行期所有DB记录均不变。日志 `/home/ubuntu/one-deploy-9b0a2e6-20261102.log`。
- 12:42:32北京时间公开health/首页200，JS `index-bclQcIUN.js` 为1463144字节，SHA-256 `8b8dda19b52a9cbdfab49fd7bd7389930859894d2815c46d85ed90c345ff22b7` 与本地相同。上线证据 `output/WRITING-RELEASE-9b0a2e6-20261102.jpg`。
- 全新 `ONE-QA-WRITING-1102-C` 仅从普通主对话发送一次，输出选“对话中”，口述查得到大脑、查OXO官方、写稿、保存Notion，另明确不要操作本机。main正常回复云任务接收；notes/web/draft/save全4/4完成，初次保存回读即verified v7、无延后核对或手动继续，任务动态自动收起、主对话自动出现已完成和原页链接。任务 `cnv_204f8fa3b5c088557e84` / request `work_885c0b6c4506ed629559` / Notion `40ca5015999181adb0c5e886b4f53a9c`；同次只有一条worker/save检查点。原稿/回读canonical digest均 `6f7a4d77376678e4bb9b80a4dd0527599fb696388df10de4ac9cbccd697818a8`。独立fetch确认正文、表格、强调、代码及来源链接存在。UI证据 `output/WRITING-C-AUTOMATIC-MAIN-ACCEPTED-20261102.jpg`、`output/WRITING-C-FOUR-STEPS-ACCEPTED-20261102.jpg`。
- C 的执行保存回执闭环通过，但成稿多附了写作阶段的“汇报/后续尚未保存”说明；已保存后读起来会矛盾，不能以机械链路通过冒充正文体验完全通过。保留C原样，不静默清洗或重写。补强 model 输出约定：content仅成果正文，summary/outcome说明当前步骤，全流程状态由平台说明。整单完成且最后实际阶段是严格已验证Notion，主汇报使用该阶段已验证摘要；后续HTML失败/未知保存不据此报全完成。
- 这组窄修复冻结后全量2267项：2266通过、0失败、1既有skip（`/tmp/one-writing-content-final-full-20261102.log`）。定向与独立复核明确不会strip既有原稿或放宽Notion证明；新生成能否遵守约定仍待D真实验收。

## c909ecd 上线与 D 验收发现

- `c909ecd0a16dc7cf2dae088601f8ce2881b2650e` 的三平台 CI verify 全部通过（run `41391363860`）。自动发布再次停在源码接收；取消该deploy后精确核对同SHA tar/脚本路径，停止已成为孤儿的源码接收进程，确认同SHA进程与cwd均空，才单次使用原部署脚本执行同源码包。包SHA-256 `53f60cfa3f24cefa9afb0a96fbeec67bdb22f0aac3cd484ffdc893c185c9649a`；部署exit0、current精确c909、service active。日志 `/home/ubuntu/one-deploy-c909ecd-20261102.log`，证据 `output/WRITING-RELEASE-c909ecd-20261102.jpg`。没有跳过原部署检查或并行重发部署。
- 北京时间13:14:59，公开health、首页及JS均200，JS仍为 `index-bclQcIUN.js`，1463144字节，SHA-256 `8b8dda19b52a9cbdfab49fd7bd7389930859894d2815c46d85ed90c345ff22b7`。这些证明版本与服务可用，不证明新的真实任务完成。
- 全新D仅发送一次，13:17的本人上下文 request `coord_cab86cb58d329d1fb209`：两次delegate均rejected，没有child或Notion写入。第一份未解析的参数得到受控格式修正；第二份已解析，包含真实知识/公开卡、note→web→draft→save四步，仍被入队检查拒绝：必需读取工具本轮未开放。最终结果 `tool_invalid/planning/not_started`。D验收失败，不能把先前C的通过算作D通过。证据 `output/WRITING-D-ADMISSION-DIAGNOSTIC-20261102.jpg`。
- 代码与精确措辞离线红测锁因：原用户明确要求上网，模型交接改写为“实际联网检索 OXO Good Grips 官方设计资料”，后续入队及worker在有必需知识读取时又依赖自然语言关键词匹配，漏识“联网检索”，把已授权、计划中真实必需的web工具删掉。“上网查”同流程旧版可通过。这是能力需求判断重复且不一致，不是Notion失败或搜索供应商失败。
- 浏览器中断后出现的“模型未就绪”源于前端目录为空；恢复网络并刷新后目录正常，未修改模型配置或授权。这不能用来解释13:17已实际产生的派发拒绝。
- 后续窄修以已验证的显式workflow web步骤证明需求，两处统一；仍独立检查用户web授权、明确禁止、执行器工具配置、适配器与搜索词隐私。D保留原失败记录，不重新发送。修复发布后的新独立真实验收另记。
- 同链路离线横查发现本轮新召回的私人笔记片段未进入公开搜索的整段私文保护池；合成私段原样作为下一步query时，旧版确实调用搜索适配器1次。现仅将当前已授权fresh/practice及同任务精确完成检查点中的知识正文纳入现有保护池，不增加检索或历史读取，不将原话/交接全文按substring一概禁止。修后私文外发0，正常公开OXO query仍1；本轮不扩展通用schema纠参机制。
- 两人交叉独审、8项端到端离线控制通过；最终冻结源全量2275项：2274通过、0失败、1既有skip。TypeScript、生产构建、diff-check均通过。日志 `/tmp/one-writing-final-admission-full-20261102.log`、`/tmp/one-writing-final-admission-build-20261102.log`。真实线上新验收仍待发布后确认。

## 8f69118 自动发布

- `8f69118e16658095a273de6fdd01cafbb9e11ae1` 的 CI run `41429523018` 四个job全部success；应用CI明确2275项、2274通过、0失败、1skip。自动deploy日志于 `2026-11-02T10:45:38.2693954Z` 明确输出 `ONE deployed: 8f69118e16658095a273de6fdd01cafbb9e11ae1`，job于北京时间18:45:41成功结束。未取消或并行重部署。
- 18:46:58公开health `{ok:true}`、首页与JS均200，JS与本地构建逐字节同，仍1463144字节及SHA-256 `8b8dda19b52a9cbdfab49fd7bd7389930859894d2815c46d85ed90c345ff22b7`。纯服务端修复不以未变的JS摘要单独证明服务端SHA，后者以精确deploy日志为证。
- 新E从普通主对话发送一次，未重发D或旧业务任务；真实执行与正文验收结果另记。自动部署连接耗时期间申请恢复腾讯云终端只为只读核对，实际自动发布已完成，无手动部署。

## E 的精确 URL 序列化差异

- E顺利分派。主对话本轮实际知识与公开资料已取得，再交接新稿和Notion保存；子任务默认三步read/draft/save，前两步完成，保存页 `40ca5015999181c7a897fa79294e4c59` 存在，但v7回读不匹配，3次自动只读核对后exhausted。此轮不是派发或上游失败。
- 精确本人任务 `cnv_d74443e0105f3ca8dc09`，同次op `cop_fe5284de88287acb37a41a0f44f85b0ceac5889493c0a0707e384872f79d45a4` / request `work_5111a479039382be3191`。唯一已完成model检查点原稿457字符，与同次receipt raw/normalized/v7canonical三摘要全部匹配，实际含标题回读571字符。私有证据仅在服务器0600文件 `/home/ubuntu/000-one-qa-e-comparison-20261102.json`，不进git或fixture。
- 首处差异是裸URL末尾字面中文 `）` 与显式同label链接目标中的UTF-8 `%EF%BC%89`；完整标题、正文、表格、粗体和行内代码均经整篇对照。未trim标点、改链接或改写文章。新v8只对原样ASCII authority之后的非ASCII URL字符比较UTF-8编码表示；不decode、不整体URL归一，不改ASCII大小写、保留字符、已有百分号编码或标签、标题、代码。
- root将冻结比较器单文件放到服务器独立0700 probe目录，文件SHA-256 `a90e6b366a67aa39f7392e19fcc6d97ea11175a9b9fb7e89e7f23b68f899c518` 与本地一致；只读比较这份精确原稿/实际回读，v8整篇摘要两边均 `aea2419cc9f5802f34c9849f7ebf7954a630bcec86e41bd7aefd44ce42936357`。这证明同篇比较通过，尚不等于线上旧任务状态已收尾。
- 旧v2–v7含义不变（1296组合旧摘要对照零变化）；新写入用8。旧回执采用v8重证仅限人工触发只读核对，依据同owner/op/checkpoint与唯一原稿raw/normalized/旧canonical三摘要，不覆盖旧version或hash；原有协议内自动只读核对仍保留，不自动重放写入。两人交叉独审及198项相关测试通过，最终全量和发布待后记。
- 最终冻结源全量2280项：2279通过、0失败、1既有skip，TypeScript/生产构建/diff-check通过；日志 `/tmp/one-writing-final-v8-full-20261102.log`、`/tmp/one-writing-final-v8-build-20261102.log`。原业务专栏、QA-A保留的精确私有对照在v8下也完整通过，没有把私文纳入fixture。

## 7a76df9 自动发布

- `7a76df977e9012ed2108c272d6c0576dac326652` 的 CI run `41438853305` 四个job全部success；应用CI完整2280项、2279通过、0失败、1skip。部署日志 `2026-11-02T12:03:26.0480130Z` 明确输出同SHA的 `ONE deployed`，deploy于北京时间20:03:29成功结束；没有取消或手动部署。
- 20:03:56公开health `{ok:true}`、首页和JS均200；同一前端bundle的1463144字节及SHA-256与本地一致。纯服务端SHA以部署日志为证，不以未改变的前端包单独推断。
- 原标准源码接收耗时期间，本地准备了同SHA gzip备份（SHA-256 `e6ca18731fad52425338a479bff69864eeb97e4ec6622bbbee0d843da6d33061`）；文件选择器未提交，自动部署已完成，备份未用于部署。Mac锁屏一度阻止最后UI验收，用户已解锁；下节记录之后的实际结果。

## E 只读收尾与 F 新派发发现

- E点击一次“再核对一次（不重写）”，直接收尾3/3，主对话自动出现已保存并回读核对的完成汇报。服务器只读确认同op completed、receipt verified、保留canonicalVersion7与原始摘要、comparisonVersion8 matched；同次仍1条worker/save、1条workflow model检查点。Notion独立fetch的最后编辑时间前后均为 `2026-11-02T10:59:50.865Z`。界面证据 `output/WRITING-E-READONLY-ACCEPTED-20261102.jpg`。没有重写E。
- 全新F只提交一次，实际trace request `coord_99e162e5fb0b45bfa24a`，未创建child、未写Notion。第一次有效batch计划包含知识/公开检索、写作、Notion保存及额外的 `read_notion_document`（欲读本次新建页面）；最后读取步骤在本轮没有绑定，入队拒绝却只给泛化“必需读取工具未开放”及可选公开检索提示。随后主对话调用knowledge_search/load_tools/discover，再发单任务的格式未通过，受既有纠参边界停止。F验收不通过，不能以E只读修复成功代替新任务首次执行成功。
- 根因：main schema只要本人任一旧任务存在Notion页就列出read工具；enqueue却要求所选同一任务已有绑定且本轮明确只读。新任务因此看到不可实际执行的工具。Notion保存阶段本身已经含完整正文回读核对，不需要以未绑定读取步骤来补证明。后续修目录/实际绑定一致与具体纠参提示，不自动删验证步骤、不授予未绑定新页读取权限，不重发F。
- 冻结实现：main与enqueue共用同页只读意图判定；初始仅当前bound页开放，未绑定旧任务须本轮own `read_task`/原目标全文读取完成后动态刷新single/batch schema。外空间、外用户、无页、原目标尚未读全不获得工具。写入、新页不因此获得read工具。Notion阶段描述明确原子保存+完整回读证明；入队失败给固定步骤序号/真实tool名与保留原目标后重提计划的指引，不再错说可选公开检索。
- 单/批混用、query包装、缺必填字段给受控格式提示，batch仅透出本地格式校验的code-owned 400错误，provider/auth错误不透。原两次纠参预算与硬步数上限不变；精确F失败序列的离线脚本经提示纠正后只创建1child、保存1次且verified，不自动删验证步、不改变原错误计划对象。
- 最终冻结源全量2286项：2285通过、0失败、1既有skip；TypeScript/生产构建/diff-check均绿，日志 `/tmp/one-writing-final-contract-full-20261102.log`、`/tmp/one-writing-final-contract-build-20261102.log`。两人交叉独审、85项相关与另74项独立测试通过。以上为离线与源码证据，待新版本上线后的独立G真实验收。

## efcf065 发布过程

- `efcf065476b5ccb70c4526032ba5e8a69e1e4507` 的 CI run `41460443074` 三项verify全部成功，应用CI完整2286/2285通过/0失败/1skip。deploy在源码接收约20分钟后于北京时间22:39:19取消，末端仅“operation was canceled”，没有部署成功记录。不能将该自动发布写成成功，也不能仅凭取消行断言网络根因。
- root通过已授权腾讯云终端只读确认current仍7a76，唯一残留是该SHA源码tar PID1337563（精确start ticks与完整incoming路径均核对），脚本PID1337560。只向这个孤立接收进程发送SIGTERM；随后同SHA进程及incoming目录均为空，没有停止应用或并行部署。
- 原生App粘贴曾异常发送剪贴板现有文字到终端，出现command-not-found；已中止并向用户说明，不将原文纳入文档。后续停用原生粘贴，浏览器typeText逐次核对实际输入与预期完整命令相同后才执行；只读pwd与版本检查通过。没有以“command-not-found”泛化证明全部文件均未变，也未删除终端历史。
- 用系统文件选择器准确选择本地 `000-one-source-efcf065-20261102.tar.gz`，不使用剪贴板路径，不增加扩展权限；8.0MB上传8秒完成。服务器SHA-256与本地均为 `ca6db8601166b283bbdecf4a5f0fe2bb4317593412bc9dab09c86ca7ebba0cb3`。再次确认没有其他theone-deploy进程、没有同名新日志/exit文件，才单次启动原部署脚本（wrapper PID1349794），保留npm安装、全量测试、构建、只读schema gate与健康检查。日志 `/home/ubuntu/one-deploy-efcf065-20261102.log`，退出文件同名`.exit`。最终退出、上线与G验收另记。
- 原脚本最终退出0，current精确 `efcf065476b5ccb70c4526032ba5e8a69e1e4507`，service active，远端实际2286项/2285通过/0失败/1skip，日志明确同SHA `ONE deployed`。证据 `output/WRITING-RELEASE-efcf065-20261102.jpg`。不能将这次单次备用发布混记为自动deploy成功。
- 独立公开核对北京时间23:06:24：health `{ok:true}`、首页、JS均200；bundle仍1463144字节、SHA-256 `8b8dda19b52a9cbdfab49fd7bd7389930859894d2815c46d85ed90c345ff22b7` 与本地一致。之后才从普通主对话发送一次独立G；未重发任何旧任务，也不再部署代码打断本次新验收。

## G 首次完整执行与最终边界

- 新G仅从普通主对话提交一次，输出“对话中”，口述指定来源、联网、写稿与Notion。未手动点击继续、只读核对或补发要求。任务 `cnv_184aa96fb5a2447a8b3d` / worker request `work_e67583cb11c87bac3254`：得到大脑、OXO官方、成稿、保存并完整回读四步均completed，首次receipt即verified、canonicalVersion8/comparison8 matched，未进入延后verification队列。主对话自动汇报“文章已保存到Notion，正文也已回读核对”并给原页，任务气泡自动收起。
- 同owner/same-op只读记录证明：唯一已完成workflow model、唯一worker/save记录；成稿raw/normalized/同版本canonical摘要全部与该receipt匹配，期望/实际canonical摘要相等。只读工具记录分别为knowledge_search及web_search completed；main trace也保留了真实查询与一次delegate格式纠正后的正常受理，未将纠正当作重复创建。
- 独立Notion fetch确认唯一新页 `40ca5015999181e9a2fbc991c751187a`，标题、完整正文、二列表格、粗体、行内代码 `ONE-QA-G`、标明假设的场景及官方来源链接均在；没有混入“后续尚未保存”之类运行汇报。保存层完整保留模型成稿。源笔记内部双引号在文稿中排为内层单引号，因此本次闭环通过不作为“逐字引文质量校对已全部通过”的证明；未重写G来掩盖该边界。
- 证据：`output/WRITING-G-AUTOMATIC-MAIN-ACCEPTED-20261102.jpg`、`output/WRITING-G-FOUR-STEPS-ACCEPTED-20261102.jpg`。最后停留ONE主对话供用户查看。原业务专栏和已有文章未重跑或改写，余额、价格与权限未人工调整；真实合成测试的正常模型/工具用量并未被伪装成零消耗。
- 本轮结论限定为上述工具目录/准入、参数纠正、保存比较、同次回读证明衔接、步骤与主对话终态路径的修复。实际网络/模型服务失败和未来未覆盖的序列化仍可能发生，应保留具体失败反馈与安全的有界恢复，不承诺所有未来任务永不失败。最后仅提交文档证据并skip CI，线上功能版本保持efcf065，不再触发部署干扰已通过的G。
