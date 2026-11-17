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
| 合成模型请求总数 | 5 | 6 |
| 权限检查 | 每次进程使用新的随机权限 profile | 原生命令探测返回 `READ_DENIED WRITE_DENIED` |

Swift 最新完整证据为 `/var/folders/bg/vcdydmhx7y52gty1pjsk1tsh0000gn/T/one-tool-bridge-o3Ae5o/evidence.json`。首轮和恢复轮使用不同的 `one-workspace-*` profile，thread 保持一致。控制器检查官方返回的 `activePermissionProfile.id` 与本轮随机 profile 精确匹配，缺失或不匹配时在开始执行前拒绝。

Mac 目录边界及文档工具测试记录为 `/tmp/one-codex-permissions-document-final.log`。已验证工作根与独立 scratch 可写，外侧合成文件的读写和指向外侧的链接读取被拒绝。Python 标准库生成 OOXML 后，ZIP 与 XML 回读字段 `B1=3000`。Homebrew Node 可以运行，无关包的链接读取被拒绝。真实编译的 ONE 文档助手在同一 profile 内写入并回读 `helper.txt` 一致。

Go 完整证据为 `/var/folders/bg/vcdydmhx7y52gty1pjsk1tsh0000gn/T/one-tool-bridge-jnHKff/evidence.json`。`nativeCommand=true`，`scopeProof=READ_DENIED WRITE_DENIED`。该结果覆盖合成用例中的指定越界读取和写入探测。Go 控制器在 Mac 上运行的结果，不等同于 Windows 可执行文件或实体机已验收。

复测入口为 `scripts/qa-codex-tool-bridge.ts`，生产控制器 fixture 分别为 `launcher/macos/CodexToolBridgeRuntimeFixture.swift` 与 `launcher/windows/codex_app_server_runtime_fixture.go`。更早的协议证据保留在 [BASELINE.md](BASELINE.md)。

## 服务端与本机故障回归

| 范围 | 已执行结果 | 具体证明 |
| --- | --- | --- |
| 准备状态与旧版本兼容 | 17 项通过 | 准备阶段优先显示；旧内置文件工具不会冒充已安装 Codex |
| 工具桥梁业务回归 | 20 项通过 | 准确任务身份、来源撤销、重复调用、未知交付和新轮接续 |
| Windows 包整理脚本 | 6 项通过 | 全部 45 个正式文件的路径、资源辅助程序、许可证及普通 ustar 文件结构 |
| Windows 安装核心 | 新增 5 项，`go test -race ./...` 通过 | 签名、包完整性、路径、失败保留旧安装和重启校验 |
| Windows 回执核心 | 新增 6 项，`go test -race ./...` 通过 | 精确身份、丢失确认、重启重发和原执行不重跑 |

服务端的知识与 Notion 测试使用合成适配器。此次独立审查发现并新增回归的情况包括：不同调用编号同时保存同稿时重复创建；同稿从中间稿改为最终稿时状态不推进；新交接操作丢失上一轮未知保存的查询引用。最新 20 项回归包含这些情况并通过。

Windows 安装测试使用包含 `MZ` 标记的合成文件和测试签名，不会运行这些文件。测试覆盖损坏包、路径穿越、大小写别名、链接、超大文件声明、健康检查失败、指针提交失败以及修改本地指针摘要后仍不能绕过原签名包检查。

回执测试覆盖工作区、用户、设备、安装、执行尝试、任务和轮次共七个字段；同一回执在连续三次重启后仍保持原编号和摘要，匹配确认前继续重发。并发受理只允许一次原执行；晚到终态和确认落盘失败保留原结果。

以上为已执行的本地检查。全量应用、Mac、Windows CI 最终计数和构建结果由正式 CI 完成后补充，不以局部检查替代发布通过。

## Windows 官方实包

整理脚本为 `scripts/prepare-windows-codex-release.mjs`，在 Windows 使用系统 `tar.exe`，Mac 使用 `/usr/bin/tar`。先验证官方发布元数据、完整大小和 SHA-256，再重封为仅含普通文件的 gzip ustar；入口为 `bin/codex.exe`，保留辅助程序、ripgrep、包元数据及许可证。可选签名参数必须匹配启动器已有信任公钥。

固定官方资产为 `codex-package-x86_64-pc-windows-msvc.tar.gz`，版本 `0.160.1`，官方元数据大小为 `157434529` 字节，摘要为 `sha256:25c6fe4e46d5bff939312fc46de67ace37561f6f1f89b409af63fd8cc6098425`。

Windows CI 已取得完整官方资产并校验上述大小和摘要。正式 tar 清单包含 45 个普通文件，共 `450588539` 字节，约 429.7 MiB。新增根 LICENSE 和 NOTICE 后为 47 个文件，脚本和启动器的总解包上限按此调整为 512 MiB。主程序为 `326875440` 字节，code-mode-host 为 `74669360` 字节，单文件仍在 320 MiB 范围内。完整路径和大小保存在 [固定版本清单](windows-codex-0.160.1-inventory.json) 中。

第一轮准备检查发现 voice DLL 资源未被识别。已按官方布局保留整个 `codex-resources` 树，包含原位置的 command-runner、sandbox-setup、voice-host、DLL、JSON 和许可证。6 项脚本回归已通过，重新封装、Windows 控制器实进程与恢复结果待下一轮 CI 补充。正式清单见 [Windows CI 记录](https://github.com/Sahaquiel-10th/theone/actions/runs/44088792778/job/134058292847)。

## 尚未执行的验收

- ONE Key 与真实模型供应商贯通、实际电力结算。
- 真实已授权得到大脑与 Notion 连接器闭环。
- Windows 正式 Codex 实包运行、原生进程与系统权限检查。
- Windows 实体机、Mac 完整业务入口及两端设备断线恢复。
- A 至 E 新旧路径性能对照、真实成功率、人工介入和费用比较。
- DeepSeek 组合和真实行业工作台试点。

[cases.json](cases.json) 与 [results-template.json](results-template.json) 已准备好固定素材和统计口径。未执行项保持 `not_run` 与 `null`，不填写推测数字。
