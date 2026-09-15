-- Append-only V2: durable chat request deduplication, scoped to exact workspace/user.
-- Apply with the ONE database migration administrator before deploying this version.
USE theone_prod;

CREATE TABLE IF NOT EXISTS chat_operations (
  id VARCHAR(96) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(96) NULL,
  user_id VARCHAR(96) NULL,
  parent_id VARCHAR(96) NULL,
  lookup_key VARCHAR(255) NULL,
  record_json JSON NOT NULL,
  created_at VARCHAR(40) NULL,
  updated_at VARCHAR(40) NULL,
  UNIQUE KEY uq_chat_operations_lookup (lookup_key),
  KEY idx_chat_operations_workspace (workspace_id),
  KEY idx_chat_operations_workspace_user (workspace_id, user_id),
  KEY idx_chat_operations_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES (2);
