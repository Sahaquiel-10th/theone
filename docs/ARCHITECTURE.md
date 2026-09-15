# ONE MVP 架构

> 状态：2026-09-15 本地内测修复架构；本轮尚未发布或灌装。以下区分已实现机制与待验/后续能力，不代表真人系统验收完成。

## 形态

首版保持模块化 TypeScript 单体，增加一个轻量原生 Launcher：

```text
ONE Key / Launcher
        │ pre-bound device + computer-bound login + per-request proof
        ▼
React Web ── HttpOnly Session ── Express API
                                  ├── Identity / Device / Workspace
                                  ├── Chat
                                  ├── Knowledge Connector
                                  │      ├── GetNoteConnector
                                  │      └── NotionMcpConnector (read only)
                                  ├── Model Gateway
                                  └── Minimal Operations
                                           │
                           Store + encrypted provider credentials
```

本机执行复用同一个 Launcher 通道。ONE 始终是用户唯一看到的界面：服务端把“截至用户所点消息”的对话整理成执行说明，再由支持 function calling 的模型驱动 ONE Local Agent。模型密钥只留在服务端；Launcher 只接收单个、本次任务绑定的工具请求，执行结果沿已认证的 ONE Key WebSocket 返回，并通过 SSE 推送到执行页。

Windows 首版把 Local Agent 与 ONE Key Launcher 打包成一个原生程序。首次执行选择允许 ONE 操作的本地文件夹，此后在同一台电脑复用；写文件和运行命令在本机再次确认。macOS 执行路径仍依赖可找到的 Codex Runtime（可选随包提供或本机已有安装），不能假设任意新 Mac 已具备执行环境。本轮明确暂缓两端执行内核及计费路径统一，不把普通知识问答和本机执行兼容性混为一谈。

Launcher 把 ONE Key 建模为“可实时读取并签名”的在场状态，而不是一次启动事件。首次双击会在当前用户目录安装一个不含凭证和私钥的轻量在场检测器；后续读取、签名始终直接发生在 U 盘上。系统休眠、网络切换、服务重启或同一枚 Key 重新插入后，检测器自动恢复 WebSocket，浏览器无需刷新。拔出 U 盘后检测器断开连接且无法为下一次请求签名。聊天还要求会话本身由 ONE Key 签发，账号密码会话不能绕过设备在场证明。电脑重启后首版仍需双击一次，不创建系统级自启动项。

## ONE Key 登录

普通网页不能作为稳定的 U 盘凭证读取器。ONE Key 上运行原生 Launcher；当前 Mac 为 ad-hoc 签名，正式 Developer ID/公证及 Windows Authenticode 仍待办理：

1. 读取 U 盘 `.one/credential.json` 的设备 ID 和 Ed25519 原型凭证；
2. 读取当前电脑本地生成、没有写进 U 盘的随机 `installationId`，一并请求服务端 challenge；
3. 证明设备凭证；
4. 获取短时、单次、绑定设备、用户、Workspace 和安装身份的一次性登录码；
5. 打开 ONE 浏览器地址；
6. 浏览器兑换带相同绑定的 Session，一次性码立即失效。无安装身份的旧版启动器/Session 需要更新启动器并重新双击登录，不兼容降级绕过。

本輪 macOS Launcher 版本为 0.2.8，显式分别以 `arm64-apple-macosx13.0` 与 `x86_64-apple-macosx13.0` 编译后合并为 Universal；Windows x64 为 0.2.4。版本递增用于更新本机驻留程序；构建目标不是已经在 macOS 13/Intel/Windows 真人系统上全部验证的承诺。

V0.1 普通 U 盘凭证可能被复制，必须诚实记录这一安全边界。后续可替换为安全芯片或 FIDO2，服务端协议尽量保持不变。

## Key 生产、激活与多设备

1. 内测由超管人工开户、建立 Membership，并把 Key 预绑定到精确用户及 Workspace。
2. 服务端初始化时生成 Ed25519 密钥，私钥只在该响应下载一次；灌装程序写入 U 盘，服务端数据库只保存公钥。
3. `User 1 → N OneKeyDevice`；当前以序列号、账号和最近使用时间区分，普通用户名称引导不等于 Key 自定义命名功能。
4. 挂失不可逆，正常与归档列表分开；保留设备最小记录并阻止后续 challenge/code/proof。

未激活认领码、手机号/微信认领、首次在设备端生成密钥和供应商批量个性化写入属于后续生产方案，尚未提供。本轮不改变人工预绑定内测路径。

## 请求级 Key 证明与受信任设备

- Launcher 登录后保持一条经过设备签名认证的 WebSocket，只使用网络级保活，不执行周期性业务签名或数据库写入。
- 严格模式下，每个受保护 API 在真正执行前生成短时、单次 Challenge；Launcher 必须从 U 盘重新读取私钥并签名，服务端验签后才继续当前请求。
- Session 与在线 socket 的 `installationId` 必须一致，随后还要通过该 socket 的当前签名；不能把“同一设备 ID 在别处在线”视为当前电脑插着 Key。请求证明超时上限当前为 2 秒，已知没有通道时直接拒绝。
- U 盘拔出后无法响应下一个 Challenge；页面可保留已显示内容，但新请求在知识召回、模型调用和计费之前返回 `ONE_KEY_REQUIRED`。
- 已经通过证明并开始执行的原子请求允许完成，拔出 Key 不追溯取消该请求；下一次请求重新证明。
- Challenge 只存在于内存，多实例部署后使用 Redis 等短期存储；数据库只记录登录、挂失、绑定、撤销和并发副本等安全事件。
- 同一 `deviceId` 只允许一个已认证 Launcher 连接。新连接替换旧连接并写入并发异常日志；复制普通 U 盘只能克隆同一身份、账号和余额，不能创建新设备记录。
- 受信任设备模式尚未开放，不能把本机 installationId 视为长期免 Key 授权。
- Key 挂失必须阻止新 challenge、未使用登录码和后续请求证明；已签发 Session 不能绕过设备状态检查。
- 浏览器请求携带预期账号标识；同一浏览器另一标签页切换账号后，旧页面请求返回 `SESSION_CHANGED`，前端清理旧数据并重新确认身份，避免请求静默落入新账号。

## Knowledge Connector

2026-09-08：增加服务端内部连接器登记表与 ConnectorService。知识适配器和执行适配器共享能力描述、版本、停用与状态检查契约，保留各自的数据调用和任务生命周期。现有得到授权接口不迁移；Windows Local Agent 与 macOS Codex 的分发改走登记表。没有通用 MCP/API 动态执行器，也不开放客户注册代码。详见 [内部连接工厂 0.1](CONNECTOR-FACTORY.md)。

2026-09-09：连接工厂进入 0.2。增加数据库持久化的短时授权事务、安全策略清单、精确 HTTPS 域名白名单、响应与 MCP 调用资源上限、凭据的 Workspace/平台/字段密码学绑定，以及授权后的真实只读验证。平台内容和 MCP 元数据一律是不可信输入；管理员不能查看其他用户的上下文原文。关系型 Store 当前仍为单应用进程缓存，水平扩容前必须升级为数据库级条件更新。

业务层只依赖通用搜索能力：

```ts
interface KnowledgeConnector {
  search(credentials, query, topK): Promise<KnowledgeResult[]>;
}
```

授权协议属于具体 Connector Adapter。当前支持：

- GetNote 第一次通过官方设备授权绑定用户账号，并实时调用账号全局语义搜索；
- Notion 使用官方托管 MCP、OAuth 2.0 Authorization Code + PKCE，只允许 `notion-fetch`、`notion-search` 和 `notion-ai-search` 三个只读工具；
- API Key、OAuth access token、refresh token 和动态客户端 secret 按 Workspace 使用认证加密保存；
- Notion access token 临近过期时由服务端刷新，浏览器永远不接触 Token；
- 不复制第三方知识正文到 ONE；
- 指定知识库搜索作为后续可选能力，不再自动创建 ONE 知识库。

GetNote 设备授权码使用官方 `expires_in`，当前真实接口返回 600 秒。ONE 的浏览器与持久化授权事务都按该有效期终止，不尝试延长失效代码。轮询兼容官方成功数据和 `success:false` 错误信封中的 `authorization_pending/slow_down`；成功换取的 Key 先保存到 Workspace/用户绑定的加密事务，再验证 `note.recall.read`，避免一次性代码被重复消费。取消、断开或新授权会使旧事务失效，旧请求不能覆盖新状态。业务 API 与官方 CLI 保持 `Bearer` 鉴权兼容。

## 查询链路

```text
用户问题
   ├── KnowledgeService → current workspace connections
   │                        ├── GetNote global recall
   │                        └── Notion MCP search + fetch
   └── optional web search
             ↓
      merge + context budget
             ↓
         Model Gateway
             ↓
       AI answer + sources
```

第三方召回内容始终是不可信输入，即使来自用户自己的 Notion，也可能包含复制内容、共享页面、模板或协作者写入。知识正文放入高优先级约束下的独立参考区，其中的角色设定、命令和工具调用要求不得执行；Notion 写工具还在代码层完全不可达。Provider 失败时可以降级为无知识回答并明确提示，但绝不能使用其他 Workspace 的连接兜底。

### 内测可靠性补充（本轮）

- 连接故障不再把得到连接永久锁成“不再尝试”。暂时失败后，下一次提问或显式检查会重新请求；成功恢复 connected。授权失效/权限不足仍明确要求用户处理，不绕过授权。
- 多 Connector 并行召回，返回 `used/no_match/not_connected/partial/failed` 和脱敏失败原因；部分来源失败也留在当前回答中，不被其他来源成功掩盖。过时请求不能覆盖用户刚断开的连接或新凭据。
- 附件上下文由精确用户/Workspace/当前对话筛选，本次上传优先，再取该对话最近的历史附件；限制数量与文字预算，并显示省略提示。重启从关系记录恢复消息的附件摘要、诊断和请求编号。
- `chat_operations` 在任何消息写入、召回或模型调用前持久化 operationId 与请求摘要。原回答与 completed 状态同事务保存；相同提交只读取原结果，同一对话忙时拒绝另一次新提交。重启把未决操作标记 interrupted，不自动重放可能已经扣费的上游调用。
- `002-chat-operations.sql` 必须先由数据库迁移管理员执行；ONE 运行账号继续保持最小权限和单应用实例，不为自动建表增加 DDL 权限。
- 称呼和引导进度嵌入账号资料，精确绑定默认 Workspace；反馈仅保存明确分享的评价/说明和已知请求编号。超管有效使用统计来自完成事件，不读取其他人的私人上下文。

数据库异地备份现状不作扩大承诺：附件原件和恢复凭据的独立安全备份/完整恢复演练本轮暂缓。

## 本机执行边界

- 用户点击某条消息旁的执行按钮，是一次明确的本地执行授权；只编译从对话起点到该消息（含）的上下文。
- 编译出的内部执行说明和设备 ID 不返回浏览器；浏览器只取得任务状态和脱敏事件。
- Local Agent 的文件工具拒绝越出用户授权目录并阻止符号链接逃逸；写入和命令执行需要本机确认。
- Windows PowerShell 命令本身可能访问授权目录之外，因此首版明确展示完整命令并逐次确认；原生系统沙箱仍是后续加固项。
- 每个任务精确绑定 `workspaceId + userId + deviceId`；不匹配的 Launcher 回传直接丢弃。
- 后续消息携带当前任务事件摘要继续执行；结果持续显示在 ONE，切回白色聊天页不会终止后台任务。

## 租户与凭据边界

- 每个用户数据记录携带 `workspaceId`；
- 服务端通过 Membership 得到授权 Workspace，不信任浏览器直接传值；
- Knowledge Connection 唯一绑定 Workspace；
- 凭据使用认证加密，仅在服务端 Connector 调用前解密；
- 管理员默认不能查看个人知识内容或凭据；
- 检索日志不得记录凭据，原文保留量按最小化原则处理。

## 后续兼容

V2 可以为 Connector 增加 `listDocuments/getDocument/sync`，把外部资料定期复制到 ONE 自有知识库。但首版接口和表不假装同步已经存在，也不提前建设 Source/Memory/RAG 系统。
