# Codex 桥梁开发验证记录

日期为 2026-11-17。实施仍在进行中。以下记录区分真实运行程序、本机合成模型、适配器测试及真实业务验收。

## 真实 Codex 与生产控制器

两组运行均使用 ONE 已安装的 arm64 Codex `0.160.1`。模型服务是本机合成 Responses 服务，外部供应商调用为 0。工具素材与输出均为独立合成数据。

| 检查 | 生产 Swift 控制器 | 生产 Go 控制器 |
| --- | --- | --- |
| 运行系统 | Mac | Mac |
| 固定 Codex 实进程 | 通过 | 通过 |
| 动态工具读取与保存 | `one_fixture_read` → `one_fixture_save` | `one_fixture_read` → `one_fixture_save` |
| 首轮实际写入 | 1 次 | 1 次 |
| 新进程恢复原 thread | 通过 | 通过 |
| 恢复轮额外写入 | 0 次 | 0 次 |
| 首轮与恢复轮完成判断 | `canCompleteNormally=true` | `canCompleteNormally=true` |
| 首轮与恢复轮进程退出 | 0 | 0 |
| 合成模型请求总数 | 6 | 6 |
| 权限检查 | 每次进程使用新的随机权限 profile | 原生命令探测返回 `READ_DENIED WRITE_DENIED` |

Swift 最新完整证据为 `/var/folders/bg/vcdydmhx7y52gty1pjsk1tsh0000gn/T/one-tool-bridge-OGamto/evidence.json`，日志为 `/tmp/one-codex-ancestor-controller-proof.log`，模式为 `--command-first --environment-proof --startup-proof`。首轮和恢复轮使用不同的 `one-workspace-*` profile，thread 保持一致。控制器检查官方返回的 `activePermissionProfile.id` 与本轮随机 profile 精确匹配，缺失或不匹配时在开始执行前拒绝。

这轮实际命令还验证了环境变量过滤。隔离配置故意使用 `inherit=all`、忽略默认排除项，并在 `set` 中重新导入合成 HTTP 凭据。最终 `include_only` 过滤得到 `TOKEN_HIDDEN`，外侧合成文件探测得到 `READ_DENIED WRITE_DENIED`。每次合成模型 HTTP 认证正常，模型输入正文没有包含该合成凭据。采用 core 继承与默认排除项的早期对照曾得到 `TOKEN_VISIBLE`，该反例已由最终过滤规则覆盖。整个验证使用合成凭据，供应商调用为 0。

启动隔离反例在实际初始化的父 Git 仓库中放入受信任的 `.codex` MCP 配置，并在私有 Codex home 放入 MCP 与 `SessionStart` hook。生产控制器通过 `config/read` 将这些 MCP 标记为关闭，启动配置将当前目录的全部祖先设为不受信任，并关闭 plugins、hooks 与 apps。首轮及新进程恢复均没有出现启动标记，`startupProof` 为 `home/project MCP and hooks did not start`，ONE 工具、原生命令和合成模型认证正常。

Mac 目录边界及文档工具测试记录为 `/tmp/one-codex-permissions-document-final.log`。已验证工作根与独立 scratch 可写，外侧合成文件的读写和指向外侧的链接读取被拒绝。Python 标准库生成 OOXML 后，ZIP 与 XML 回读字段 `B1=3000`。Homebrew Node 可以运行，无关包的链接读取被拒绝。真实编译的 ONE 文档助手在同一 profile 内写入并回读 `helper.txt` 一致。

Go 最新完整证据为 `/var/folders/bg/vcdydmhx7y52gty1pjsk1tsh0000gn/T/one-tool-bridge-EvkDSU/evidence.json`，日志为 `/tmp/one-bridge-final-go-protocol.log`。`nativeCommand=true`，`scopeProof=READ_DENIED WRITE_DENIED`。该结果覆盖合成用例中的指定越界读取和写入探测。Go 控制器的本次运行系统为 Mac，Windows 可执行文件和实体机继续使用后续验收记录。

复测入口为 `scripts/qa-codex-tool-bridge.ts`，生产控制器 fixture 分别为 `launcher/macos/CodexToolBridgeRuntimeFixture.swift` 与 `launcher/windows/codex_app_server_runtime_fixture.go`。更早的协议证据保留在 [BASELINE.md](BASELINE.md)。

## 服务端与本机故障回归

| 范围 | 已执行结果 | 具体证明 |
| --- | --- | --- |
| 准备状态与旧版本兼容 | 17 项通过 | 准备阶段优先显示；旧内置文件工具不会冒充已安装 Codex |
| 工具桥梁业务回归 | 20 项通过 | 准确任务身份、来源撤销、重复调用、未知交付和新轮接续 |
| Windows 包整理脚本 | 6 项通过 | 全部 45 个正式文件的路径、资源辅助程序、许可证及普通 ustar 文件结构 |
| Windows 安装核心 | 新增 8 项，`go test -race ./...` 通过 | 签名、包完整性、路径、失败保留旧安装、同版本修复回滚及额外 DLL 拒绝 |
| Windows 回执核心 | 新增 8 项，`go test -race ./...` 通过 | 精确身份、丢失确认、重启重发、ACK tombstone 和 HTML 长正文 |
| Windows 状态兼容 | 26 项相关状态套件通过，其中新增 3 项 Windows 回归 | 平台矩阵待开放时，已认证内置文件能力仍可就绪 |

服务端的知识与 Notion 测试使用合成适配器。此次独立审查发现并新增回归的情况包括：不同调用编号同时保存同稿时重复创建；同稿从中间稿改为最终稿时状态不推进；新交接操作丢失上一轮未知保存的查询引用。最新 20 项回归包含这些情况并通过。

Windows 安装测试使用包含 `MZ` 标记的合成文件和测试签名，不会运行这些文件。测试覆盖损坏包、路径穿越、大小写别名、链接、超大文件声明、健康检查失败、指针提交失败以及修改本地指针摘要后仍不能绕过原签名包检查。

回执测试覆盖工作区、用户、设备、安装、执行尝试、任务和轮次共七个字段；同一回执在连续三次重启后仍保持原编号和摘要，匹配确认前继续重发。并发受理只允许一次原执行；晚到终态和确认落盘失败保留原结果。

新增回归验证确认后的 tombstone 清除正文，并拒绝同身份再次写入晚到终态。包含 20 万个 `<` 的正文能够在 512 KiB 传输限制内持久化，重启后原文及摘要一致。同版本损坏修复先验证新包，再替换当前目录，激活失败会恢复原目录及指针，额外 DLL 会在执行前被拒绝。

以上为已执行的局部检查。正式应用、Mac、Windows CI 结果见下方候选构建记录；自动检查不代替真实业务验收与生产发布。

## Windows 官方实包

整理脚本为 `scripts/prepare-windows-codex-release.mjs`，在 Windows 使用系统 `tar.exe`，Mac 使用 `/usr/bin/tar`。先验证官方发布元数据、完整大小和 SHA-256，再重封为仅含普通文件的 gzip ustar；入口为 `bin/codex.exe`，保留辅助程序、ripgrep、包元数据及许可证。可选签名参数必须匹配启动器已有信任公钥。

固定官方资产为 `codex-package-x86_64-pc-windows-msvc.tar.gz`，版本 `0.160.1`，官方元数据大小为 `157434529` 字节，摘要为 `sha256:25c6fe4e46d5bff939312fc46de67ace37561f6f1f89b409af63fd8cc6098425`。

Windows CI 已取得完整官方资产并校验上述大小和摘要。正式 tar 清单包含 45 个普通文件，共 `450588539` 字节，约 429.7 MiB。新增根 LICENSE 和 NOTICE 后为 47 个文件，脚本和启动器的总解包上限按此调整为 512 MiB。主程序为 `326875440` 字节，code-mode-host 为 `74669360` 字节，单文件仍在 320 MiB 范围内。完整路径和大小保存在 [固定版本清单](windows-codex-0.160.1-inventory.json) 中。

第一轮准备检查发现 voice DLL 资源未被识别。已按官方布局保留整个 `codex-resources` 树，包含原位置的 command-runner、sandbox-setup、voice-host、DLL、JSON 和许可证。6 项脚本回归已通过。正式包重封、安装重建和篡改检查已通过；实际 Windows Codex 的动态工具及新进程恢复也已通过，具体范围见下方完整检查记录。严格 MXC 权限配置仍因 CI 宿主不支持而受阻。正式清单见 [文件清单记录](https://github.com/Sahaquiel-10th/theone/actions/runs/44088792778/job/134058292847)。

Windows 的 Codex 桥梁版本矩阵暂留空。状态检查按已认证启动器的 `local_tools_v1` 返回内置文件工具及真实启动器版本，目录正常时仍可继续使用内置文件读写。新启动器声明 managed/bridge 协议时也使用这一规则，当前状态明确显示 Codex 的 Windows 版本待验收。此分支已覆盖缺少 Windows Codex 清单、跳过原生 Codex 探测、权限归属与完整 readiness 回归。

Windows 原生 CI 已通过包含真实 Job 对象测试的 Go race 检查。期间曾遇到 GitHub 元数据上游失败；后续完整检查已取得正式包并运行固定 Codex，结果见下方 Windows CI 记录。

## 尚未执行的验收

- ONE Key 与真实模型供应商贯通、实际电力结算。
- 真实已授权得到大脑与 Notion 连接器闭环。
- Windows 严格目录隔离配置下的本机命令、文件业务及系统权限验收。
- Windows 实体机、Mac 完整业务入口及两端设备断线恢复。
- A 至 E 新旧路径性能对照、真实成功率、人工介入和费用比较。
- DeepSeek 组合和真实行业工作台试点。

[cases.json](cases.json) 与 [results-template.json](results-template.json) 已准备好固定素材和统计口径。未执行项保持 `not_run` 与 `null`，不填写推测数字。

## 候选构建与发布状态

开发草稿为 [PR #1](https://github.com/Sahaquiel-10th/theone/pull/1)，未合入主干、未部署。应用检查已在 [3317 项测试的 CI](https://github.com/Sahaquiel-10th/theone/actions/runs/44097009486/job/134086696447) 取得 3316 通过、0 失败、1 跳过，包整理脚本 6/6 和生产构建通过。

Mac 云端 Gateway 检查的挂死已由 [限时堆栈采样](https://github.com/Sahaquiel-10th/theone/actions/runs/44102880480/job/134107324671) 定位：旧 macOS 的根目录 URL 删除行为不收敛，导致权限配置构建不断累积祖先路径。修复改用 canonical 路径的字符串父目录，每轮严格变短，并明确在 `/` 结束；根目录、单层与 100 层无重复／有限终止回归通过。测试辅助程序也已限制进程与管道等待，避免再次盲等。

修复后的真实生产 Swift controller 证明为 `one-tool-bridge-OGamto/evidence.json`，日志 `/tmp/one-codex-ancestor-controller-proof.log`：6 次合成模型请求、同 thread 新进程恢复、首轮写 1 次／恢复写 0 次，`READ_DENIED WRITE_DENIED`、`TOKEN_HIDDEN`、模型 synthetic bearer 正常，home／父 Git 项目 MCP 与 hook 均未启动，外部供应商调用为 0。

[修复后的 Intel macOS 15 云端检查](https://github.com/Sahaquiel-10th/theone/actions/runs/44104021576/job/134111379215) 已通过，源码为 `6a8393d`。权限配置有限终止、24 组 App Server 控制器、13 组输入检查、9 组真实管道适配、动态工具重连、目录持久化、进程停止及 6 组回执传输均通过。该任务只运行 Mac 检查，应用、Windows 和部署步骤跳过；真实 Key、供应商与业务链路继续待验收。

Windows CI 已确证两个平台限制：MXC 在该宿主不可用，legacy unelevated 也拒绝精确的分离写入根。两者都保持明确拒绝，不扩大权限或冒充命令执行成功。CI 将这类兼容性反例与无本机命令的动态工具／同会话恢复正例分别记录；Windows 桥梁矩阵继续为空，内置文件能力仍可用。

[Windows 完整安装与工具协议检查](https://github.com/Sahaquiel-10th/theone/actions/runs/44101006047/job/134100680717) 已通过：原生 Go race 和 Job 进程测试通过，正式包安装／重建／损坏拒绝通过；实际固定 Codex 的无本机命令正例为 5 次本机合成模型请求、首轮写入 1 次、新进程恢复同 thread 后额外写入 0 次，两轮实际退出码均为 0。日志同时明确记录 `STRICT_BRIDGE_UNAVAILABLE` 与 `LEGACY_COMMAND_UNAVAILABLE`，不以此验收本机文件任务或解除 Windows 桥梁关闭状态。

两个 `0.4.31` 候选程序保存在本工作树的 `output/codex-bridge-candidates-20261117/`，不含 Key 凭据，没有安装或对外发布：

| 候选 | 构建事实 | 主程序 SHA-256 |
| --- | --- | --- |
| macOS | 祖先循环修复后的 arm64 + x86_64 通用构建，本地代码签名检查通过；旧候选保留于历史目录 | `e149183ec77447953f6cbcc5f98f259b9e6130e46f605e6d489ca9e0543b7037` |
| Windows | x86-64 GUI 构建 | `f0c0147d23c63576ef111772363720dcad56ae87395a4ea9c646afcc84d9dafa` |

候选尚未生成受既有发布公钥信任的运行时更新清单。本地代码签名不代替正式更新签名；Key 恢复后仍先跑旧路径基线，再安装候选做对照，不能先自动切换而丢失比较条件。
