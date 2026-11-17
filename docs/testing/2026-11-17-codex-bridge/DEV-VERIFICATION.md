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

Swift 完整证据为 `/var/folders/bg/vcdydmhx7y52gty1pjsk1tsh0000gn/T/one-tool-bridge-aKrzJh/evidence.json`。首轮和恢复轮使用不同的 `one-workspace-*` profile，thread 保持一致。该记录证明指定 profile 下的实际工具回调与接续。

Go 完整证据为 `/var/folders/bg/vcdydmhx7y52gty1pjsk1tsh0000gn/T/one-tool-bridge-jnHKff/evidence.json`。`nativeCommand=true`，`scopeProof=READ_DENIED WRITE_DENIED`。该结果覆盖合成用例中的指定越界读取和写入探测。Go 控制器在 Mac 上运行的结果，不等同于 Windows 可执行文件或实体机已验收。

复测入口为 `scripts/qa-codex-tool-bridge.ts`，生产控制器 fixture 分别为 `launcher/macos/CodexToolBridgeRuntimeFixture.swift` 与 `launcher/windows/codex_app_server_runtime_fixture.go`。更早的协议证据保留在 [BASELINE.md](BASELINE.md)。

## 服务端与本机故障回归

| 范围 | 已执行结果 | 具体证明 |
| --- | --- | --- |
| 准备状态与旧版本兼容 | 17 项通过 | 准备阶段优先显示；旧内置文件工具不会冒充已安装 Codex |
| 工具桥梁业务回归 | 20 项通过 | 准确任务身份、来源撤销、重复调用、未知交付和新轮接续 |
| Windows 包整理脚本 | 3 项通过 | 路径、必要辅助程序和普通 ustar 文件结构 |
| Windows 安装核心 | 新增 5 项，`go test -race ./...` 通过 | 签名、包完整性、路径、失败保留旧安装和重启校验 |
| Windows 回执核心 | 新增 6 项，`go test -race ./...` 通过 | 精确身份、丢失确认、重启重发和原执行不重跑 |

服务端的知识与 Notion 测试使用合成适配器。此次独立审查发现并新增回归的情况包括：不同调用编号同时保存同稿时重复创建；同稿从中间稿改为最终稿时状态不推进；新交接操作丢失上一轮未知保存的查询引用。最新 20 项回归包含这些情况并通过。

Windows 安装测试使用包含 `MZ` 标记的合成文件和测试签名，不会运行这些文件。测试覆盖损坏包、路径穿越、大小写别名、链接、超大文件声明、健康检查失败、指针提交失败以及修改本地指针摘要后仍不能绕过原签名包检查。

回执测试覆盖工作区、用户、设备、安装、执行尝试、任务和轮次共七个字段；同一回执在连续三次重启后仍保持原编号和摘要，匹配确认前继续重发。并发受理只允许一次原执行；晚到终态和确认落盘失败保留原结果。

以上为已执行的本地检查。全量应用、Mac、Windows CI 最终计数和构建结果由正式 CI 完成后补充，不以局部检查替代发布通过。

## Windows 官方实包

整理脚本为 `scripts/prepare-windows-codex-release.mjs`，在 Windows 使用系统 `tar.exe`，Mac 使用 `/usr/bin/tar`。先验证官方发布元数据、完整大小和 SHA-256，再重封为仅含普通文件的 gzip ustar；入口为 `bin/codex.exe`，保留辅助程序、ripgrep、包元数据及许可证。可选签名参数必须匹配启动器已有信任公钥。

固定官方资产为 `codex-package-x86_64-pc-windows-msvc.tar.gz`，版本 `0.160.1`，官方元数据大小为 `157434529` 字节，摘要为 `sha256:25c6fe4e46d5bff939312fc46de67ace37561f6f1f89b409af63fd8cc6098425`。

本机资产下载多次超时，已停止并保留部分下载。完整实包的大小、成员和重新封装尚未在本机验证，待 Windows CI 获取正式实包后补充。当前没有可据此发布的实包通过结论。

## 尚未执行的验收

- ONE Key 与真实模型供应商贯通、实际电力结算。
- 真实已授权得到大脑与 Notion 连接器闭环。
- Windows 正式 Codex 实包运行、原生进程与系统权限检查。
- Windows 实体机、Mac 完整业务入口及两端设备断线恢复。
- A 至 E 新旧路径性能对照、真实成功率、人工介入和费用比较。
- DeepSeek 组合和真实行业工作台试点。

[cases.json](cases.json) 与 [results-template.json](results-template.json) 已准备好固定素材和统计口径。未执行项保持 `not_run` 与 `null`，不填写推测数字。
