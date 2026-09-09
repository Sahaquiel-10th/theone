# ONE MVP 架构

> 状态：快速上线目标架构，2026-08-30

## 形态

首版保持模块化 TypeScript 单体，增加一个轻量原生 Launcher：

```text
ONE Key / Launcher
        │ claim + login challenge + per-request proof
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

Windows 首版把 Local Agent 与 ONE Key Launcher 打包成一个原生程序。首次执行选择允许 ONE 操作的本地文件夹，此后在同一台电脑复用；写文件和运行命令在本机再次确认。旧版 macOS Launcher 继续使用随包 Codex Runtime，直至共用 Local Agent 内核适配完成。

Launcher 把 ONE Key 建模为“可实时读取并签名”的在场状态，而不是一次启动事件。系统休眠、网络切换或服务重启只会使 WebSocket 暂时离线；Launcher 在同一枚凭证可读取时持续重连，页面对 `ONE_KEY_REQUIRED` 做有限退避重试。拔出 U 盘后挑战无法签名，服务端不会用历史在线状态放行请求。

## ONE Key 登录

普通网页不能作为稳定的 U 盘凭证读取器。ONE Key 上运行已签名/公证的 Launcher：

1. 读取 `device.dat` 中的设备 ID 和原型凭证；
2. 请求服务端 challenge；
3. 证明设备凭证；
4. 获取短时、单次、绑定设备的一次性登录码；
5. 打开 ONE 浏览器地址；
6. 浏览器兑换 Session，一次性码立即失效。

V0.1 普通 U 盘凭证可能被复制，必须诚实记录这一安全边界。后续可替换为安全芯片或 FIDO2，服务端协议尽量保持不变。

## Key 生产、激活与多设备

1. 后台按批次生成高熵一次性认领码，只持久化哈希、序列号、批次和未激活状态。
2. 初始化工具向每枚普通 U 盘写入同一 Launcher 和该盘唯一认领资料；不提前创建或绑定用户。
3. 首次激活先验证认领码，再完成手机号/微信身份验证。
4. Launcher 在首次激活时生成正式 Ed25519 密钥；私钥只留在 U 盘，服务端保存公钥并原子消费认领码。
5. `User 1 → N OneKeyDevice`；设备使用不可变序列号和可修改显示名称区分。
6. 挂失不可逆，并自动进入归档视图；归档保留最小 tombstone，防止旧凭证或序列号复活。

前期由单盘初始化程序逐枚灌装；中期使用多口设备并行；大批量时由供应商按同一认领码清单完成个性化写入。生产规模变化不改变激活协议。

## 请求级 Key 证明与受信任设备

- Launcher 登录后保持一条经过设备签名认证的 WebSocket，只使用网络级保活，不执行周期性业务签名或数据库写入。
- 严格模式下，每个受保护 API 在真正执行前生成短时、单次 Challenge；Launcher 必须从 U 盘重新读取私钥并签名，服务端验签后才继续当前请求。
- U 盘拔出或 Launcher 退出后无法响应下一个 Challenge；页面可保留已显示内容，但新请求返回 `ONE_KEY_REQUIRED`。
- 已经通过证明并开始执行的原子请求允许完成，拔出 Key 不追溯取消该请求；下一次请求重新证明。
- Challenge 只存在于内存，多实例部署后使用 Redis 等短期存储；数据库只记录登录、挂失、绑定、撤销和并发副本等安全事件。
- 同一 `deviceId` 只允许一个已认证 Launcher 连接。新连接替换旧连接并写入并发异常日志；复制普通 U 盘只能克隆同一身份、账号和余额，不能创建新设备记录。
- 受信任设备模式下，普通 API 可以使用长期设备授权；敏感 API 仍执行同样的实时请求证明。
- Key 挂失必须阻止新 challenge、未使用登录码和后续请求证明；已签发 Session 不能绕过设备状态检查。

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
