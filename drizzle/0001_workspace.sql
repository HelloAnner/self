CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE workspace (
  workspace_id TEXT PRIMARY KEY,
  singleton_key INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton_key = 1),
  state TEXT NOT NULL CHECK (state IN ('initializing', 'active', 'read_only', 'needs_migration', 'damaged', 'deleted')),
  format_version INTEGER NOT NULL,
  database_schema_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;

CREATE TABLE workspace_config_versions (
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  version INTEGER NOT NULL CHECK (version > 0),
  content_hash TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, version)
) STRICT;

CREATE TABLE workspace_capabilities (
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  capability TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available', 'unconfigured', 'degraded', 'unavailable', 'unsupported')),
  version TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, capability)
) STRICT;

CREATE TABLE setup_sessions (
  setup_session_id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspace(workspace_id),
  state TEXT NOT NULL,
  current_step TEXT NOT NULL,
  profile TEXT NOT NULL,
  answers_json TEXT NOT NULL DEFAULT '{}',
  created_resource_ids_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  target_id TEXT,
  idempotency_key TEXT,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE UNIQUE INDEX operations_idempotency_key_unique
  ON operations(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

PRAGMA user_version = 1;
