# ONE MVP 数据模型

> 状态：V1 关系存储迁移中，2026-09-03

## 已有核心对象

### `users`

`id`、`username`、`password_hash`、`role`、`default_workspace_id`、`enabled`、时间戳。

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

### `devices`

`id`、`serial_number`、`status`、`assigned_workspace_id`、`credential_version`、创建/激活/挂失时间。

### `device_credentials`

`device_id`、凭证哈希或公钥、`status`、轮换时间。不得保存可直接还原的明文 Secret。

### `device_challenges`

`id`、`device_id`、challenge 哈希、过期时间、使用时间、失败次数。

### `one_time_login_codes`

只保存 Token 哈希：`device_id`、`workspace_id`、过期时间、兑换时间、来源信息。必须短 TTL、单次使用。

### `sessions`

`id`、`user_id`、`workspace_id`、`device_id`、Token 哈希、创建/过期/撤销时间和最近使用时间。

## 强制约束

- 所有业务记录使用 `workspace_id` 作为首要查询边界；
- 设备只能绑定一个有效 Workspace，换绑必须审计；
- challenge 和登录码过期或使用后不能重放；
- Knowledge Connection 不能跨 Workspace 读取；
- 断开连接必须清除加密 API Key；
- Migration 进入共享环境后只能追加。

## Codex 执行

### `execution_tasks`

保存 `workspace_id`、`user_id`、`conversation_id`、作为上下文终点的 `source_message_id`、`device_id`、内部执行说明、Codex thread ID、目标目录显示名、状态和时间戳。公开序列化必须移除内部执行说明和设备 ID。

### `execution_events`

保存 `workspace_id`、`user_id`、`task_id`、事件类型、展示文本和时间戳。事件只能由与任务完全匹配的已认证设备写入；每个任务限制事件数量和单条长度。

## 模型与电力

- `models`：接口协议、Base URL、加密 API Key、模型 ID、公开展示名、默认状态，以及每百万输入/输出 Token 的对外电力价与采购成本；采购成本仅超管可见。
- `power_accounts`：`workspace_id + user_id` 精确绑定的微电力余额。
- `power_ledger`：充值、赠送、调用、调整和退款；每条保存变动前后余额，调用条目关联模型与 usage。
- `recharge_orders`：申请电力、应付人民币、下单时汇率快照和订单状态。
- `model_usage_records`：输入/输出 Token、实扣、成本、请求 ID 和状态。
- `audit_logs`：登录、模型配置、知识故障、充值和聊天完成等非内容操作事件；不得保存聊天正文或凭据。

## V1 物理存储

- 每类业务对象使用独立 MySQL 表，每个对象独立一行；不再把完整系统状态写入单条 `app_state`。
- `workspace_id`、`user_id` 和父对象 ID 使用独立索引列，JSON 只承载当前 MVP 的完整对象结构。
- 用户名、Workspace slug、Workspace 成员关系、知识连接、ONE Key 序列号、一次性登录码和电力账户使用数据库唯一键防止重复。
- 每次业务变更在单个 InnoDB 事务内提交；失败时内存状态同步回滚。
- 首次切换自动从现有 `db.json` 导入；原文件和切换前环境配置保留为回退快照。
- 后续迁移只能通过追加 `schema_migrations` 版本完成，逐步把高频查询字段从 JSON 提升为普通列。
