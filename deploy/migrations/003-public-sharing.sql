-- Append-only V3. Apply only to ONE; no changes to other applications.
USE theone_prod;
CREATE TABLE IF NOT EXISTS publications (
  id VARCHAR(96) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(96) NULL,
  user_id VARCHAR(96) NULL,
  parent_id VARCHAR(96) NULL,
  lookup_key VARCHAR(255) NULL,
  record_json JSON NOT NULL,
  created_at VARCHAR(40) NULL,
  updated_at VARCHAR(40) NULL,
  UNIQUE KEY uq_publications_lookup (lookup_key),
  KEY idx_publications_workspace (workspace_id),
  KEY idx_publications_workspace_user (workspace_id, user_id),
  KEY idx_publications_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS public_sessions (
  id VARCHAR(96) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(96) NULL,
  user_id VARCHAR(96) NULL,
  parent_id VARCHAR(96) NULL,
  lookup_key VARCHAR(255) NULL,
  record_json JSON NOT NULL,
  created_at VARCHAR(40) NULL,
  updated_at VARCHAR(40) NULL,
  UNIQUE KEY uq_public_sessions_lookup (lookup_key),
  KEY idx_public_sessions_workspace (workspace_id),
  KEY idx_public_sessions_workspace_user (workspace_id, user_id),
  KEY idx_public_sessions_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS public_runs (
  id VARCHAR(96) NOT NULL PRIMARY KEY,
  workspace_id VARCHAR(96) NULL,
  user_id VARCHAR(96) NULL,
  parent_id VARCHAR(96) NULL,
  lookup_key VARCHAR(255) NULL,
  record_json JSON NOT NULL,
  created_at VARCHAR(40) NULL,
  updated_at VARCHAR(40) NULL,
  UNIQUE KEY uq_public_runs_lookup (lookup_key),
  KEY idx_public_runs_workspace (workspace_id),
  KEY idx_public_runs_workspace_user (workspace_id, user_id),
  KEY idx_public_runs_parent (parent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (version) VALUES (3);
