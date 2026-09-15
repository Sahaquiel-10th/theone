# ONE MVP 数据模型

> 状态：关系存储生产基线已存在；2026-09-14 本轮本地变更待发布，新增 `002-chat-operations.sql` 待执行。此文不代表生产已迁移。

## 已有核心对象

### `users`

`id`、`username`、`password_hash`、`role`、`default_workspace_id`、`enabled`、时间戳。

本轮增加可选 `profile` JSON：`workspaceId`、`displayName`、`onboarding` 和 `updatedAt`。`onboarding` 保存首次称呼时间、知识步骤选择（pending/connected/skipped）、步骤时间、完成时间。称呼不修改唯一用户名；引导按账号持久化，不按浏览器或 U 盘重复。资料修改必须验证启用账号、默认 Workspace、有效 Membership 和在场 Key。此字段复用已有用户记录，不新增资料表。

### `workspaces`

租户根：`id`、`name`、`slug`、`status`、时间戳。

### `workspace_members`

`workspace_id`、`user_id`、`role`，唯一约束 `(workspace_id, user_id)`。

### `knowledge_connections`

- `id`、`workspace_id`、`provider`；
- `status`：`pending | connected | error | revoked`；
- `client_id`、`encrypted_api_key`；
- `credential_expires_at`、`last_checked_at`、`last_error`；
- 时间戳。

`provider_space_id/name` 仅作为旧数据兼容字段，不再是首版全局召回的前提。

### `retrieval_logs`

`workspace_id`、`user_id`、`conversation_id`、`query`、`provider`、命中摘要、注入上下文和时间戳。上线前评审原文保留策略。

## ONE Key 首版新增

### `one_key_devices`

`id`、`serialNumber`、`workspaceId`、`userId`、`status=active|revoked`、`publicKey`、`createdAt`、`lastUsedAt`、`revokedAt`。当前预绑定模式没有未激活状态或用户认领记录。

### 设备私钥与电脑安装身份

服务端数据库只保存 Ed25519 公钥，不存在独立 `device_credentials` 表；初始化响应只下载一次私钥，灌装到 U 盘 `.one/credential.json`。普通文件凭证仍可能被复制。

`installationId` 由电脑本地生成并保留，禁止随 U 盘灌装；它是本机安装身份而非硬件证明。服务器把此身份嵌入登录 challenge、登录码和 Session，并与当前在线 Launcher 匹配；同一枚 Key 插到电脑 B 不能为电脑 A 的旧 Session 提供在场证明。

### `device_challenges`

`id`、`deviceId`、`installationId`、随机 `nonce`、过期时间、使用时间、失败次数。当前登录 challenge 为 2 分钟，最多 5 次失败。请求级短时 challenge 则仅在内存，消费后删除，不形成周期性业务数据库写入。

### `one_time_login_codes`

只保存 Token 哈希：`deviceId`、`installationId`、`workspaceId`、`userId`、过期时间和兑换时间。当前 TTL 为 60 秒，必须单次使用。

### 浏览器 Session（非独立表）

当前使用签名 Session Token + HttpOnly Cookie，带 `sub`、`role`、`workspaceId`、`deviceId`、`installationId` 和过期时间，不存在独立 `sessions` 表。每个请求重新读取账号角色/启用状态、Membership 与 Key 状态，不能靠未过期 Token 绕过挂失或停用。缺失 installationId 的旧 Session 需要新版启动器重新登录。

## 强制约束

- 所有业务记录使用 `workspace_id` 作为首要查询边界；
- 设备只能绑定一个有效 Workspace，换绑必须审计；
- challenge 和登录码过期或使用后不能重放；
- Knowledge Connection 不能跨 Workspace 读取；
- 断开连接必须清除加密 API Key；
- Migration 进入共享环境后只能追加。

## 知识连接凭据

`knowledge_connections` 以 `workspace_id + provider` 唯一。GetNote 保存加密 API Key；Notion 保存加密 access token、refresh token、OAuth client secret、过期时间，以及用于展示的 Workspace 名称。公开接口只能返回状态、展示名称和检查时间，不能返回任何加密字段或上游用户标识。

`knowledge_connections.authorizationSession` 保存十分钟级别的嵌入式授权事务，包含 `workspaceId`、`userId`、连接器、协议、状态和过期时间。OAuth state 只保存哈希；设备码、PKCE verifier 等载荷加密保存。一个 Workspace 的同一连接器最多存在一笔进行中的事务；完成、取消或失败后立即清除，不能跨 Workspace/用户轮询或复用。它复用现有关系记录，不需要为短期状态增加独立数据库权限或迁移表。

知识凭据的新密文使用 Workspace、平台和字段名作为 AES-GCM 附加认证数据。数据库记录误绑定到另一账户时不能成功解密；V1 旧密文仅为滚动兼容保留。

## 本机执行

### `execution_tasks`

保存 `workspace_id`、`user_id`、`conversation_id`、作为上下文终点的 `source_message_id`、`device_id`、执行提供方、内部执行说明、目标目录显示名、状态和时间戳。公开序列化必须移除内部执行说明和设备 ID。

### `execution_events`

保存 `workspace_id`、`user_id`、`task_id`、事件类型、展示文本和时间戳。事件只能由与任务完全匹配的已认证设备写入；每个任务限制事件数量和单条长度。

## 模型与电力

- `models`：接口协议、Base URL、加密 API Key、模型 ID、公开展示名、默认状态，以及每百万输入/输出 Token 的对外电力价与采购成本；采购成本仅超管可见。
- `power_accounts`：`workspace_id + user_id` 精确绑定的微电力余额，reservedMicros 对应持久化的未决调用；重启不把未知用量当免费，而是转入待核对并重建预占。
- `power_ledger`：充值、赠送、调用、调整和退款；每条保存变动前后余额，调用条目关联模型与 usage。
- `recharge_orders`：申请电力、应付人民币、下单时汇率快照和订单状态。
- `model_usage_records`：输入/输出 Token、实扣、成本、请求 ID 和状态。
- 普通问答、执行指令整理和 Local Agent 每一步都先原子预占再结算，多个并发请求不能重复花同一份余额。使用记录以独立 ID 实现幂等结算，保存价格快照、用途、开始时间和耗时。状态为 pending/success/failed/needs_review/waived；source=provider/fixed/unknown（旧 estimated 仅兼容历史）。没有 usage 的文本调用不估算收费，等待人工核对；图片使用明确的固定单次售价与成本。
- 模型成本是按管理员进价配置计算的估算，不等于中转站实际账单；缺失成本必须显示未确认，赠送电力的消耗不能作为现金收入或实际利润。
- 当前 MySQL 存储仍由单进程加载业务状态并串行提交事务；部署必须保持 ONE 单实例。多进程/多机器扩容前必须改为数据库原子扣款/锁，不能直接增加实例。
- `audit_logs`：登录、模型配置、知识故障、充值和聊天完成等非内容操作事件；不得自动保存聊天正文或凭据。`beta.feedback` 是显式用户反馈事件，details 仅含 helped/not_solved、是否同意分享及可选说明；同一回答最新反馈计入统计，重复相同提交不新增事件。普通审计列表不展示说明，超管专用反馈接口只展示用户明确同意交出的说明。

## 本轮请求去重与消息连续性

### `chat_operations`（追加迁移 002）

- 精确绑定 `workspaceId + userId + operationId`，存 `payloadHash`、原 `requestId`、状态 pending/completed/failed/interrupted、对话/回答 ID、是否可重试和时间戳；不保存第二份问题或聊天正文。
- operationId 相同但 payloadHash 不同必须拒绝；同一对话有 pending 时禁止另一个新提交并行。
- completed 与回答入库在同一事务提交；重复请求查原消息，不重复调用或计费。原对话删除后仍保留去重 tombstone，旧请求不会重新执行。
- 启动恢复只把 pending 标为 interrupted，未知上游执行结果不自动重试。与模型 usage 的独立幂等结算是两层不同保护。
- 数据库唯一 lookup key 与工作区/用户/父对象索引由 `deploy/migrations/002-chat-operations.sql` 创建；先迁移后部署，运行账号不需要新增 DDL 权限。

### `messages` / `attachments`

- 消息保留 `attachmentIds`、`requestId`、`knowledgeDiagnostics`、`attachmentWarning`。重启恢复只挂回相同用户、Workspace 和对话的附件公开摘要，绝不返回 storagePath。
- 后续问题从同一对话最近的用户附件中选择上下文；当前上传优先，数量/图片数/文字预算有上限。超限、部分未纳入会留下明确提示。
- 知识诊断保留 used/no_match/not_connected/partial/failed 和脱敏原因；不把临时连接错误等同于永久撤销。知识连接的成功/失败更新须防止过时请求覆盖更新的授权或断开。
- 附件原件仍在应用私有文件存储；数据库记录与 COS 数据库备份不包含这些原件的完整异地副本。本轮完整附件/密钥备份与恢复演练暂缓。

### 内测有效使用统计

从精确用户/Workspace 的 `chat.completed` 事件统计完成回答、knowledgeUsed、第一次成功/知识回答、有效活跃天数和跨日再次使用；已完成本机任务另计。登录、失败调用及 Local Agent 内部模型步骤不冒充用户完成问答，不需要读取私人内容。

## V1 物理存储

- 每类业务对象使用独立 MySQL 表，每个对象独立一行；不再把完整系统状态写入单条 `app_state`。
- `workspace_id`、`user_id` 和父对象 ID 使用独立索引列，JSON 只承载当前 MVP 的完整对象结构。
- 用户名、Workspace slug、Workspace 成员关系、知识连接、ONE Key 序列号、一次性登录码和电力账户使用数据库唯一键防止重复。
- 每次业务变更在单个 InnoDB 事务内提交；失败时内存状态同步回滚。
- 首次切换自动从现有 `db.json` 导入；原文件和切换前环境配置保留为回退快照。
- 后续迁移只能通过追加 `schema_migrations` 版本完成，逐步把高频查询字段从 JSON 提升为普通列。
