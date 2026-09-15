# ONE MVP API

> 状态：2026-09-15 本地实现契约；本轮修改尚未上线或灌装，新接口不能视为生产已经可用。

## 通用规则

- 浏览器使用 HttpOnly Session Cookie；
- Workspace 从已认证身份和 Membership 解析；
- Provider 凭据永不返回浏览器；
- 错误响应包含稳定 `code` 和 `requestId`；
- Challenge、登录码和授权流全部有 TTL、Workspace/Device 绑定与重放保护。
- 本轮 Key Session/Launcher 还必须匹配当前电脑本地 `installationId`。浏览器附带预期账号 `X-One-User`，账号切换时拒绝旧页面请求并返回 `SESSION_CHANGED`，不得用该 Header 绕过服务端身份或 Membership。
- 除 `/api/me`、超管恢复登录和 OAuth 回调外，私人内容、知识连接、计费与管理接口都要求 ONE Key Session；超管接口同样要求超管自己的 Key 在场。

## ONE Key（当前）

### `POST /api/one-key/challenge`

Launcher 提交 `deviceId + installationId`，服务端返回短时 challenge。installationId 在当前电脑本地生成，不来自 U 盘。未知、挂失或停用设备拒绝；旧启动器缺失安装身份时要求升级，不签发可降级 Session。

### `POST /api/one-key/challenge/:challengeId/verify`

验证设备证明并签发一次性登录码。响应不直接返回长期浏览器 Session。

### `POST /api/auth/one-key/redeem`

Launcher 只把一次性码放在 URL Fragment（`#one-key=...`）中，因此 Web 服务器和代理日志不会收到它。浏览器立即兑换并清除 Fragment，服务端设置绑定用户/Workspace/设备/installationId 的 HttpOnly Session；重复兑换返回稳定错误。

### `GET /api/one-key/launcher`（WebSocket Upgrade）

Launcher 声明设备与 installationId 后完成签名认证。每次受保护请求匹配 Session 和当前 socket 的安装身份，再发一次性挑战；Launcher 必须当场读取 U 盘私钥签名。无通道或电脑不匹配直接拒绝，等待签名最多约 2 秒。Key 在别的电脑在线不算当前电脑在场。返回 428 的在场错误或 `ONE_KEY_UPGRADE_REQUIRED`，不允许先调用模型再拦截。

### `GET /api/admin/one-keys`

超管查看已签发 ONE Key 的绑定、状态和最后使用时间；不返回私钥。

### `POST /api/admin/one-keys`

运营初始化一枚 Key 并绑定目标 Workspace。首版只允许平台管理员。响应中的私钥只返回一次，必须直接写入目标 Key，不得进入日志或工单。

### `POST /api/admin/one-keys/:id/revoke`

挂失设备并使未完成的 challenge、一次性登录码失效；每次请求重新验证 Key 状态，旧 Session 不能绕过挂失。列表通过正常/归档筛选分开，设备记录不物理删除。

## 账号资料与内测反馈（本轮）

- `GET /api/me/profile`：返回当前账号默认 Workspace 的称呼和持久化引导进度；
- `PATCH /api/me/profile`：接受 `displayName`（1–40 个可见字符）或 `onboardingAction=knowledge_connected|knowledge_skipped|complete`。不能修改登录用户名、角色或 Workspace；connected 步骤验证当前 Workspace 确有连接，完成之前需填写称呼并选择连接或跳过；
- `POST /api/me/feedback`：接受本人 assistant `messageId`、`rating=helped|not_solved`、可选 `comment` 与 `shareComment=true`。有说明而没有明确同意时拒绝；最多 500 字符，requestId 从原消息/本人上下文记录派生，不信任客户传入的关联；
- `GET /api/conversations/:id/feedback`：读取本人该对话的最新回答反馈；前端不为每条消息自动发独立查询；
- `GET /api/admin/users/:id/beta?offset=0&limit=20`：仅在场超管返回 `{engagement,feedback}`。有效完成问答/知识回答/有效使用天数与首次使用时间不含私人内容；反馈默认折叠、分页（上限 50），只有用户明确分享的说明可见，不附带原问题、答案、来源或附件。

以上均要求在场 Key 和 Membership，普通账号不能使用超管接口，超管也不能借反馈接口读取他人私人对话。

## 内部连接工厂 0.1（2026-09-08）

- `GET /api/connectors`：在已验证的当前 Workspace 下列出服务端登记的连接器、版本、能力和状态，不触发远端探测。
- `POST /api/connectors/:id/check`：显式检查已登记连接器。得到的有效存储授权使用检索接口检查；本机执行只确认通道，不启动任务或隐式授权。
- 两者沿用 Session、Membership 和 ONE Key 请求证明，服务层再次校验 Workspace；不接受请求体或查询参数覆盖账号、工作区、设备或目标地址。
- 返回 `health.state/code/message/evidence`，显式检查另含 `checkedAt`；原始错误、密钥、设备标识和个人内容不出现在结果中。
- 无任意注册/脚本/URL 执行接口。详见 [内部连接工厂](CONNECTOR-FACTORY.md)。

## 得到授权兼容接口

### `GET /api/knowledge/connections/getnote`

返回当前 Workspace 连接状态，不返回凭据。

### `POST /api/knowledge/connections/getnote/device-flow`

启动官方授权。用户前提是已经注册得到并开通会员。当前官方响应有效期为 600 秒；过期后必须重新发起，ONE 不延长或复用失效授权码。

### `POST /api/knowledge/connections/getnote/test-connect`（仅开发诊断）

仅用于开发诊断，默认关闭。正式用户路径始终使用官方设备 OAuth：Client ID 属于 ONE，用户只需在得到官方页面登录并授权，不需要打开开发者后台、创建应用或复制 API Key。

### `POST /api/knowledge/connections/getnote/device-flow/:flowId/poll`

等待或上游临时失败时返回 202；成功换取的 API Key 先写入加密授权事务，再执行真实召回检查，避免验证暂时失败后重复消费一次性授权码。成功后按 Workspace 加密保存 API Key。业务请求按得到官方 CLI 当前契约发送 `Authorization: Bearer <API Key>` 和 `X-Client-ID`。首版不创建或绑定专属知识库。
授权事务同时绑定 Workspace、发起用户和连接器；服务器重启后可以继续轮询，其他账户使用同一 `flowId` 只会得到不存在。`authorization_pending`、`slow_down`、拒绝、过期和已消费分别处理；轮询中的短租约阻止多个标签页并发消费同一授权码。

### `DELETE /api/knowledge/connections/getnote/device-flow/:flowId`

取消当前用户、当前 Workspace 的未完成授权。取消或断开会原子清除授权事务，已经在途的旧轮询不能随后恢复连接。

### `DELETE /api/knowledge/connections/getnote`

清除加密凭据并停止后续召回。

## Notion MCP 只读连接

- `GET /api/knowledge/connections/notion`：返回当前 Workspace 的公开连接状态，不返回 OAuth 客户端 secret、access token 或 refresh token。
- `POST /api/knowledge/connections/notion/oauth/start`：为当前 Workspace 启动带 PKCE 的 Notion 官方 OAuth；仅 Workspace 所有者可用，返回官方授权地址。
- `GET /api/knowledge/connections/notion/oauth/callback`：使用只存哈希的短时、单次 state 完成 code 交换，真实执行一次只读检查后，把加密凭据绑定到发起授权的 Workspace，再无感返回 ONE。应用重启不会丢失尚未完成的回调。
- `DELETE /api/knowledge/connections/notion`：清除当前 Workspace 的用户令牌并停止 Notion 召回。

ONE 通过官方托管 MCP 只调用 `notion-fetch`、`notion-search` 和 `notion-ai-search`。即使 MCP 服务返回其他工具，它们也不会进入允许列表或模型工具面；首版不能创建、编辑、评论、移动或删除 Notion 内容。

## Chat（当前，已调整）

聊天请求由服务端使用当前 Workspace 已连接的知识来源执行实时搜索；多个 Provider 的结果公平合并后，将 Top K 作为不可信参考上下文注入模型，并在回答中附带来源。连接缺失时不执行第三方召回；单个 Provider 失败不允许回退到其他 Workspace 的连接。

- `POST /api/chat`：除现有 content/modelId/conversationId/attachmentIds 外，必须提供本次 `operationId`（16–128 位字母、数字、下划线或横线）。先验证 Key，再持久化去重状态，之后才写用户消息、召回与调用模型。
- 同一操作相同内容已完成则返回原结果；处理中返回 `CHAT_OPERATION_PENDING`；同一编号不同内容返回 `CHAT_OPERATION_CONFLICT`；同对话另有请求返回 `CHAT_CONVERSATION_BUSY`，不重复消费上游。
- `GET /api/chat/operations/:operationId`：按当前用户/Workspace 查询原结果；未决/中断/不可恢复结果使用明确错误，不自动重试模型。客户端网络错误应先查此接口，不能直接生成新编号重发。
- 每个回答保存 `requestId`、`knowledgeDiagnostics={status,failures}` 与可选 `attachmentWarning`。status 为 used/no_match/not_connected/partial/failed；部分来源失败也持续显示，不因其他来源成功而隐藏。
- 暂时知识故障允许下次请求或显式 check 重试；授权失效、权限不足明确要求处理，断开后不能由旧请求恢复连接。
- 附件后续上下文仅选择本对话、本用户/Workspace 的历史上传；显示截断/省略说明，不能重用另一对话的已绑定附件。重启保留附件摘要、诊断和原请求编号。

上线前先执行数据库追加迁移 `002-chat-operations.sql`。单笔模型账单幂等和整次用户提交去重分别承担不同层级的保护；本轮仍使用单应用实例 Store，不支持直接横向扩容。

## 本机执行（当前）

- `POST /api/executions/from-message`：从指定对话消息创建任务。服务端只读取截至该消息的当前 Workspace 对话，隐藏整理执行说明，并发送给当前 ONE Key 连接的本机 Runtime。
- `GET /api/executions?conversationId=...`：读取当前用户在该对话下的任务摘要。
- `GET /api/executions/:id`：读取任务和可展示事件，不返回内部执行说明或设备 ID。
- `GET /api/executions/:id/stream`：在一次 ONE Key 请求证明后持续推送任务状态、模型消息、命令与文件变更摘要，任务结束时关闭。
- `POST /api/executions/:id/messages`：在同一本机任务中继续发指令。
- `POST /api/executions/:id/cancel`：停止本机进程。

支持 Local Agent 的 Windows Launcher 在认证响应中声明 `local_tools_v1`。服务端随后通过同一 WebSocket 使用 `local_prepare` 选择工作目录，以 `tool_request/tool_result` 执行受限工具；macOS 仍使用现有 Codex Runtime 协议。两端执行统一本轮暂缓，不保证没有 Codex 的新 Mac 可执行本机任务。

所有读取、继续、停止与 Launcher 回传都同时校验 `workspaceId + userId + deviceId`，不能靠猜测任务 ID 跨租户访问。

## 模型与电力（当前）

- `GET /api/models`：只返回已开放模型的 ID、展示名、类型和默认标记，不返回供应商配置、Key、系统提示词或采购成本；
- `PATCH /api/me/model`：用户在设置深层选择自己的默认模型；
- `GET /api/me/billing`：只返回当前 Workspace 用户的余额、账单、充值订单和用量；
- `POST /api/me/recharge-orders`：创建充值订单。支付通道未接入前订单保持待处理；
- `/api/admin/models*`：超管维护接口地址、API Key、模型 ID、售价和进价；
- `/api/admin/operations`：超管读取经营总览、计量账单和非内容审计日志；
- `GET /api/admin/users/:id/usage?period=7d&offset=0&limit=20`：按用户读取分页模型用量（period 支持 all/7d/30d，每页上限 100），以及最近 100 条非内容活动；只允许在场超管 Key；不返回对话标题、正文、附件名称或知识原文；
- `POST /api/admin/users/:id/usage/:usageId/resolve`：超管按上游实际 Token 核对（action=provider_usage），或明确免扣释放预占（action=waive）；绑定精确用户与 Workspace，重复结算不会再次扣款；
- `DELETE /api/admin/users/:id`：拒绝物理删除；请通过 PATCH enabled=false 停用归档。不能停用当前超管或通过开户接口新增/提升超管；
- `GET /api/admin/context-traces`：超管读取自己管理 Workspace 内、由自己发起的最近 100 次成功问答上下文摘要；
- `GET /api/admin/context-traces/:id`：超管按次查看自己的平台提示词、模型提示词、知识召回原文、附件、联网结果、历史对话和当前问题；不允许借超管身份读取其他内测用户的聊天内容，也不包含任何 Provider 或模型密钥；
- `POST /api/admin/users/:id/power`：赠送电力并原子写入账本；
- `POST /api/admin/recharge-orders/:id/approve`：人工确认充值入账；
- `PATCH /api/admin/settings/billing`：配置人民币购买电力的汇率。

账本使用微电力：`1 电力 = 1,000,000 微电力`。每次调用先持久化独立 pending 记录并预占余额，按发起时价格快照和有效的上游 usage 结算，释放剩余预占。失败记录耗时但不扣用户电力。用量缺失/非法时保留 needs_review 与预占，不猜测 Token 收费；该用户暂停后续模型调用，等待超管核对或免扣。进程重启把未决 pending 转为待核对。若真实用量超过预占，零售扣费不超过本次预占，记录 billingCapped 和按配置计算的完整成本。图片模型必须配置 imagePowerPerCall/costImagePowerPerCall，按一次生成一张的固定价格结算，未配置不调用上游。

`/api/admin/operations` 同时返回数据库探测、磁盘可用比例、本地/异地备份成功标记；36 小时未成功为 stale，没有标记为 unverified。页面刷新检查，尚无主动通知。`/api/health` 探测数据库失败时返回 503。

上下文调试按账号限额保存，仅供超管查看自己发起的问答；删除对话时同步清理。停用用户不删除账单、使用记录或用户资料。它不是查看内测用户私人内容的入口。

## 租户验收规则

每条身份、连接和聊天路径必须证明：

- Workspace A 不能读取或使用 Workspace B 的 Key、Session、连接和召回结果；
- 猜测 ID 不泄露资源是否存在；
- 挂失 Key、撤销 Session、断开 Provider 后立即停止对应能力；
- Provider 失败不能跨租户降级；
- 凭据不出现在响应、URL、日志和模型上下文中。
