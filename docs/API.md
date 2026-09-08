# ONE MVP API

> 状态：2026-08-28；“当前”已存在，“目标”随首版实现。

## 通用规则

- 浏览器使用 HttpOnly Session Cookie；
- Workspace 从已认证身份和 Membership 解析；
- Provider 凭据永不返回浏览器；
- 错误响应包含稳定 `code` 和 `requestId`；
- Challenge、登录码和授权流全部有 TTL、Workspace/Device 绑定与重放保护。

## ONE Key（当前）

### `POST /api/one-key/challenge`

Launcher 提交设备 ID，服务端返回短时 challenge。未知、挂失或停用设备拒绝。

### `POST /api/one-key/challenge/:challengeId/verify`

验证设备证明并签发一次性登录码。响应不直接返回长期浏览器 Session。

### `POST /api/auth/one-key/redeem`

Launcher 只把一次性码放在 URL Fragment（`#one-key=...`）中，因此 Web 服务器和代理日志不会收到它。浏览器立即兑换并清除 Fragment，服务端设置 HttpOnly Session；重复兑换返回稳定错误。

### `GET /api/admin/one-keys`

超管查看已签发 ONE Key 的绑定、状态和最后使用时间；不返回私钥。

### `POST /api/admin/one-keys`

运营初始化一枚 Key 并绑定目标 Workspace。首版只允许平台管理员。响应中的私钥只返回一次，必须直接写入目标 Key，不得进入日志或工单。

### `POST /api/admin/one-keys/:id/revoke`

挂失设备并使未完成的 challenge、一次性登录码失效。已存在浏览器 Session 的集中撤销作为上线前加固项。

## 得到连接（当前）

### `GET /api/knowledge/connections/getnote`

返回当前 Workspace 连接状态，不返回凭据。

### `POST /api/knowledge/connections/getnote/device-flow`

启动官方授权。用户前提是已经注册得到并开通会员。

### `POST /api/knowledge/connections/getnote/test-connect`（仅开发诊断）

仅用于开发诊断，默认关闭。正式用户路径始终使用官方设备 OAuth：Client ID 属于 ONE，用户只需在得到官方页面登录并授权，不需要打开开发者后台、创建应用或复制 API Key。

### `POST /api/knowledge/connections/getnote/device-flow/:flowId/poll`

等待时返回 202；成功后按 Workspace 加密保存 API Key。首版不再创建或绑定专属知识库。

### `DELETE /api/knowledge/connections/getnote`

清除加密凭据并停止后续召回。

## Chat（当前，已调整）

聊天请求由服务端使用当前 Workspace 的连接执行得到全局语义搜索，将 Top K 结果作为不可信参考上下文注入模型，并在回答中附带来源。连接缺失时不执行第三方召回；Provider 失败时记录故障并降级为无知识回答，不中断模型主链。

## 本机执行（当前）

- `POST /api/executions/from-message`：从指定对话消息创建任务。服务端只读取截至该消息的当前 Workspace 对话，隐藏整理执行说明，并发送给当前 ONE Key 连接的本机 Runtime。
- `GET /api/executions?conversationId=...`：读取当前用户在该对话下的任务摘要。
- `GET /api/executions/:id`：读取任务和可展示事件，不返回内部执行说明或设备 ID。
- `GET /api/executions/:id/stream`：在一次 ONE Key 请求证明后持续推送任务状态、模型消息、命令与文件变更摘要，任务结束时关闭。
- `POST /api/executions/:id/messages`：在同一本机任务中继续发指令。
- `POST /api/executions/:id/cancel`：停止本机进程。

新版 Launcher 在认证响应中声明 `local_tools_v1`。服务端随后通过同一 WebSocket 使用 `local_prepare` 选择工作目录，以 `tool_request/tool_result` 执行受限工具；不声明该能力的旧 macOS Launcher 回退到原 Codex Runtime 协议。

所有读取、继续、停止与 Launcher 回传都同时校验 `workspaceId + userId + deviceId`，不能靠猜测任务 ID 跨租户访问。

## 模型与电力（当前）

- `GET /api/models`：只返回超管已开放的模型和对外价格，不返回 Key、系统提示词或采购成本；
- `PATCH /api/me/model`：用户在设置深层选择自己的默认模型；
- `GET /api/me/billing`：只返回当前 Workspace 用户的余额、账单、充值订单和用量；
- `POST /api/me/recharge-orders`：创建充值订单。支付通道未接入前订单保持待处理；
- `/api/admin/models*`：超管维护接口地址、API Key、模型 ID、售价和进价；
- `/api/admin/operations`：超管读取经营总览、计量账单和非内容审计日志；
- `GET /api/admin/context-traces`：超管读取最近 100 次成功问答的上下文摘要；
- `GET /api/admin/context-traces/:id`：超管按次查看分区后的平台提示词、模型提示词、知识召回原文、附件、联网结果、历史对话和当前问题。该接口包含用户私密内容，只允许超管访问；不包含任何 Provider 或模型密钥；
- `POST /api/admin/users/:id/power`：赠送电力并原子写入账本；
- `POST /api/admin/recharge-orders/:id/approve`：人工确认充值入账；
- `PATCH /api/admin/settings/billing`：配置人民币购买电力的汇率。

账本使用微电力：`1 电力 = 1,000,000 微电力`。每次模型调用按当时输入/输出售价结算，并保存售价、成本、Token、请求 ID 与余额快照。

上下文调试记录只保留最近 200 次成功问答；删除用户或对话时同步删除。它是经产品方明确批准的首版诊断能力，不属于一般用户功能。

## 租户验收规则

每条身份、连接和聊天路径必须证明：

- Workspace A 不能读取或使用 Workspace B 的 Key、Session、连接和召回结果；
- 猜测 ID 不泄露资源是否存在；
- 挂失 Key、撤销 Session、断开 Provider 后立即停止对应能力；
- Provider 失败不能跨租户降级；
- 凭据不出现在响应、URL、日志和模型上下文中。
