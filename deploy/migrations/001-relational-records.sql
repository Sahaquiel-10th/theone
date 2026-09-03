-- ONE relational record store V1. This migration only creates `theone_prod`.
CREATE DATABASE IF NOT EXISTS theone_prod
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE theone_prod;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT NOT NULL PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS _one_record_template (
  id VARCHAR(96) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(96) NULL,
  user_id VARCHAR(96) NULL,
  parent_id VARCHAR(96) NULL,
  lookup_key VARCHAR(255) NULL,
  record_json JSON NOT NULL,
  created_at VARCHAR(40) NULL,
  updated_at VARCHAR(40) NULL,
  UNIQUE KEY uq_lookup (lookup_key),
  KEY idx_workspace (workspace_id),
  KEY idx_workspace_user (workspace_id, user_id),
  KEY idx_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS workspaces LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS workspace_members LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS conversation_folders LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS models LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS conversations LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS messages LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS user_saved_memories LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS retrieval_logs LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS context_traces LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS model_usage_records LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS knowledge_connections LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS one_key_devices LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS device_challenges LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS one_time_login_codes LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS power_accounts LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS power_ledger LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS recharge_orders LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS audit_logs LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS agents LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS attachments LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS execution_tasks LIKE _one_record_template;
CREATE TABLE IF NOT EXISTS execution_events LIKE _one_record_template;

DROP TABLE _one_record_template;

CREATE TABLE IF NOT EXISTS system_settings (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  record_json JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES (1);
