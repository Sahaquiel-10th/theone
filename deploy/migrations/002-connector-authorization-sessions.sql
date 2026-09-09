-- Persist short-lived connector authorization transactions so an application
-- restart does not turn a completed provider consent into a failed callback.
USE theone_prod;

CREATE TABLE IF NOT EXISTS connector_authorization_sessions (
  id VARCHAR(96) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(96) NULL,
  user_id VARCHAR(96) NULL,
  parent_id VARCHAR(96) NULL,
  lookup_key VARCHAR(255) NULL,
  record_json JSON NOT NULL,
  created_at VARCHAR(40) NULL,
  updated_at VARCHAR(40) NULL,
  UNIQUE KEY uq_connector_authorization_sessions_lookup (lookup_key),
  KEY idx_connector_authorization_sessions_workspace (workspace_id),
  KEY idx_connector_authorization_sessions_workspace_user (workspace_id, user_id),
  KEY idx_connector_authorization_sessions_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES (2);
