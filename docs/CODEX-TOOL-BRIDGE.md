# Codex 与 ONE 工具桥

2026-11-17 实施说明。与 `CODEX-BRIDGE-IMPLEMENTATION-PLAN-20261117.md` 配合阅读。本文记录服务端已接通的协议与恢复边界，不能据此宣称所有行业工作台、模型组合或生产真机验收都已完成。

## 生效入口

- 新启动器通过已签名的 ONE Key 连接声明 `codex_tool_bridge_v1`；服务端就绪检查返回可选 `capabilities.codexToolBridge`。浏览器提交的就绪值不构成执行授权。
- 主对话的 `delegate_task`、`delegate_tasks`、`execute_local_task` 可将一个完整任务交给就绪 Codex。资料、写作、ONE 原稿和 Notion 交付在同一 Codex 会话推进，不再为每个工具另套云端模型阶段。
- 首批迁移本机文件、普通写作及从主对话选择的、未锁定 `modelId` 的单一纯提示词功能。单一提示词功能的要求与边界进入 Codex 交接，沿既有 `FeaturePrice` 记录用量；已指定专用模型、图像、专用工具、多功能计费及独立功能运行页仍走原执行服务，不静默改换功能指定模型。
- 纯问答、状态询问与明确不执行的讨论保持轻量路径；旧启动器保持原路径。没有把本地目录授权扩大到整台电脑。
- `localDeviceCanBridge` 按平台集中维护实测矩阵：当前 macOS / Windows 各只接固定 `0.160.1`，且须实测 ready、来源为 managed/existing。协议 capability 不等于安装完成；内置文件工具、未知平台和矩阵外旧/新版本不自动接管桥梁任务，仍保留原本机或云端路径。升级矩阵前须先通过该平台真实协议、重启恢复与权限边界测试。
- 同一业务任务的后续交接复用原 `ExecutionTask` / Codex thread，推进 ONE round，并保存每次交接 admission。独立 conversation、不同设备/安装身份及尚未结束的旧操作不复用线程。

## 工具与传输

首次 `thread/start` 固定动态工具目录。后续 `thread/resume` 复用目录，因此知识检索和 Notion 工具声明在首次线程就存在，每次使用仍重新检查本轮实际授权。

| 工具 | 服务端实现与约束 |
| --- | --- |
| `one_knowledge_search` | 调用现有 KnowledgeService，只读本次 WorkRun 精确绑定的来源；保留日期约束、正文、来源与覆盖信息，调用前后及缓存重放均检查来源授权。 |
| `one_save_artifact` | 保存完整 ONE 原稿、摘要与私有步骤；正文以普通结果消息进入本任务。返回稳定 artifactId，不把 Notion 的 50,000 字符连接器上限套到所有 ONE 原稿。执行传输仍有 512 KiB 上限，超限明确拒绝，不截断。 |
| `one_get_delivery` | 返回本任务原稿及当前/历史原交付状态，不执行模型或外部写入。连接器撤销不锁住用户自己在 ONE 已保存的成果。 |
| `one_save_notion` | 只收 artifactId 与最终稿意图，服务端决定连接、授权、父页与现有页面，复用 NotionDocuments，模型不能任意指定目标或凭据。 |
| `one_web_search` | 服务器配置公开搜索时提供，沿当前任务联网授权、公开关键词隐私检查及既有搜索用量记录执行。 |

启动消息附带：

```json
{"toolBridge":{"tools":[{"name":"one_get_delivery","description":"…","inputSchema":{"type":"object","properties":{}}}]}}
```

启动器转发动态工具请求：

```json
{"type":"executor_tool_call","taskId":"…","round":0,"attemptId":"…","requestId":"…","threadId":"…","turnId":"…","callId":"…","tool":"one_get_delivery","arguments":{}}
```

服务器返回相同身份字段和：

```json
{"type":"executor_tool_result","requestId":"…","success":true,"contentItems":[{"type":"inputText","text":"…"}]}
```

服务器由已认证 socket 确定 workspace/user/device/installation，匹配任务、round、attempt、thread，并持久绑定该轮首个 turnId。新 callId 也不能更换同轮 turnId。工具参数不接受 workspace、凭据或任意保存目标。

## 幂等与未知结果

调用记录保存在私有 `ExecutionTask.toolBridge`，不经普通任务 API 返回。实际执行前持久化调用身份、规范化输入摘要和 started 状态。

- 同 callId、相同输入返回原结果；不同输入/工具/身份拒绝。在进程内并发重复调用关联同一 promise。
- Notion 写入按原操作串行，锁内重新读取目标与回执；连接器在提交前再次比对持久目标，防止旧 create 快照在另一份保存成功后重复建页。
- 同稿换 callId 仍复用原写入事实。未知写入只查询原操作/原页面/原异步任务，不重新提交。没有可查询身份时保持未知，不能把超时当成未受理。
- 同稿从 `final:false` 变成 `final:true` 只提升 ONE 内最终稿意图与相应检查点，复用实际写入 ACK，不再写一遍正文。
- 新 WorkRun 保留原交付 operation 引用。恢复查询原 operation；旧 ACK 保留原归属，不复制成新 operation 的写入证据。确认旧交付后，同稿复用；正文确实变更时才更新同页。
- 停止、失效 Key、错误身份和未决进程阻止新的操作。可证明只是同一 attempt 的签名/心跳/socket 暂断时，恢复新签名后可继续原调用。旧副作用晚到仅补入原调用、原 operation，不重启或覆盖新轮次。

## 完成、验证、展示

沿用外部交付契约：ONE 保有完整原稿；Notion 精确业务成功回执完成保存；后台内容完整性检查不撤销已确认交付。缺少确切写入证据时不能凭页面存在或模型一句“已保存”判成功。

`ExecutionTask.status` 与 `terminalReceipt` 保存真实执行器终态。公共 `businessOutcome`、`businessSummary`、`businessNotionUrl` 表示业务成果。纯正文任务有完整 ONE 原稿、最终 Notion 精确交付和必需检索证据时，即使最后模型回复失败，也可确认业务已交付；本机文件仍是必需目标时，Notion 成功不能掩盖文件失败。停止及未决进程占用单独保留。

只有本轮合同明确要求 `web_search` 时，业务完成还需要本轮成功持久化的 `one_web_search` 记录；模型口头声称联网、旧轮次检索或 Notion 成功都不能代替。普通“想案例／举例”未要求实际联网时，仍允许模型推理，不强加检索。

`executorModelName` 在实际 Codex 网关授权时冻结为公开模型名。实际执行模型沿既有 `codex_execution` 服务端配置选择，不返回采购地址、模型凭据或内部供应商配置。未调整生产价格、余额或授权。

## 本机读取边界

旧 `workspace-write` 只约束写入，不能作为“只能读取已选文件夹”的证据。Mac 新桥梁单独使用 Codex 0.160.1 的命名 permissions profile；旧任务保留原策略。

- 每次进程使用随机 `one-workspace-<UUID>` 名称，防止已加载的同名项目配置合并额外根。`thread/start` / `thread/resume` 与 `turn/start` 都显式选择该 profile，不混传旧 `sandbox` / `sandboxPolicy`。
- 根目录默认拒绝，`:minimal` 只读，业务工作区可写，`/tmp` 拒绝。本轮 `TMPDIR` 必须等于私有 scratch，因此 `:tmpdir` 仅允许该 scratch；不能指向整个系统临时目录。ONE task home 与用户 home 不授予读取。
- ONE 文档助手仅授予其执行文件读取。系统 Python 沿 `:minimal`；已安装 Homebrew Node/Python 只授予实际运行包及解析到的动态依赖版本目录读取。允许 bin/opt 别名目录遍历不会放行未授权的包目标，真实拒绝测试覆盖该边界。没有为任意用户目录下的自定义运行时扩大权限或自动安装运行时。
- 子命令网络关闭。模型服务和 ONE 服务器工具桥通过各自已认证通道调用，不受子命令网络开关控制。`features.multi_agent=false`、`features.goals=false` 禁止未经 ONE 映射的子会话/目标执行。
- 新桥梁命令环境固定 `inherit=core`、`ignore_default_excludes=false`，并固定最后执行的 `include_only` 精确允许列表（系统基础变量与 ONE 文档助手、scratch 变量）。固定 0.160.1 会在排除后应用用户 `set`，仅依赖 TOKEN 默认排除会被已加载配置重新引入；最后允许列表才剔除该情况。模型 HTTP 仍使用上层独立认证环境。与旧 canonical filters 冲突的配置会被明确拒绝，不回退扩大读取或泄露凭据。
- Mac 已实际验证工作区与 scratch 读写、区外读写和区内外链拒绝、真实 OOXML 生成回读、Node 与真实 ONE 文档助手。固定版本实际 app-server 首轮及新进程恢复也通过。平台不能落实的策略应明确拒绝，不能静默放宽为旧策略。

Windows 的 `unelevated` 不支持拒绝读取的完整边界；MXC/`elevated` 的实际可用性须由固定版本和设备验证，不能以配置项存在宣称真机通过。官方当前 MXC 单命令检测示例标为 0.162.0 以后，不能拿来替代本项目固定 0.160.1 的实测。[官方权限说明](https://learn.chatgpt.com/docs/permissions)、[Windows 说明](https://learn.chatgpt.com/docs/windows/windows-sandbox)。

## 验证命令

```bash
npx tsc --noEmit
npx tsx --test server/codexToolBridge.test.ts server/codexToolBridgeSocket.test.ts
npx tsx --test --test-name-pattern='Codex bridge' server/coordinatorService.test.ts
npx tsx --test server/notionDocuments.test.ts server/dispatchCapabilities.test.ts server/codexGateway.test.ts server/taskResultInbox.test.ts server/oneKeyPresence.test.ts
```

测试覆盖真实签名 socket、断线后原结果重放、两种普通调度入口、单一提示词功能、跨工作区、来源撤销、同轮错 turn、取消、并发同稿、旧 create 快照、未知写入、跨轮原交付恢复、独立任务隔离、晚到副作用，以及业务交付和执行终态分离。上线与真实模型/设备验收证据另记计划的阶段清单。

Mac 命名权限实测：按现有 Mac workflow 编译 `CodexGatewayConfiguration.swift` 与其 Tests，设置 `ONE_CODEX_PERMISSION_TEST_BIN` 为固定 0.160.1 可执行文件；可选 `ONE_DOCUMENT_PERMISSION_TEST_TOOL` 指向刚构建的 ONE 执行文件。真实工具桥 fixture 编译还需加入 `CodexGatewayConfiguration.swift`，再运行 `scripts/qa-codex-tool-bridge.ts <codex> <fixture>`。全部为独立合成目录和本机 Responses，不消耗供应商调用。

`--command-first --environment-proof` 为可选反例：在独立 CODEX_HOME 注入宽松 shell 配置和合成 TOKEN，实际运行命令验证目录外 `READ_DENIED WRITE_DENIED`、`TOKEN_HIDDEN`；同时要求每个模型 HTTP 请求带独立合成认证且正文没有 TOKEN 值。它不读取或输出真实凭据，未开启该标志时原 Mac/Go fixture 行为不变。
