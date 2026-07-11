CREATE TABLE data_connections (
  connection_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory', 'project', 'obsidian')),
  state TEXT NOT NULL CHECK (state IN ('draft', 'initializing', 'active', 'paused', 'degraded', 'error', 'detached', 'deleted')),
  watch_mode TEXT NOT NULL CHECK (watch_mode IN ('poll', 'native', 'watch_and_reconcile')),
  scan_policy_json TEXT NOT NULL,
  filter_policy_json TEXT NOT NULL,
  resource_policy_json TEXT NOT NULL,
  config_version INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  reconcile_required INTEGER NOT NULL DEFAULT 1 CHECK (reconcile_required IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_scan_at TEXT,
  last_success_at TEXT,
  next_scan_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE connection_targets (
  target_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES data_connections(connection_id),
  uri TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('file', 'directory')),
  location_scope TEXT NOT NULL CHECK (location_scope IN ('external', 'managed_content')),
  canonical_path TEXT NOT NULL,
  target_identity_key TEXT NOT NULL,
  path_fingerprint_json TEXT,
  recursive INTEGER NOT NULL CHECK (recursive IN (0, 1)),
  follow_symlinks INTEGER NOT NULL DEFAULT 0 CHECK (follow_symlinks IN (0, 1)),
  case_sensitivity TEXT NOT NULL CHECK (case_sensitivity IN ('sensitive', 'insensitive', 'unknown')),
  status TEXT NOT NULL CHECK (status IN ('active', 'unavailable', 'permission_denied', 'rebind_required', 'deleted')),
  last_verified_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE connection_scan_runs (
  scan_run_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES data_connections(connection_id),
  job_id TEXT,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('initial', 'schedule', 'native_event', 'manual', 'recovery')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'enumerating', 'comparing', 'hashing', 'batching', 'succeeded', 'partial', 'failed', 'cancelled')),
  started_at TEXT,
  finished_at TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0,
  files_hashed INTEGER NOT NULL DEFAULT 0,
  files_ignored INTEGER NOT NULL DEFAULT 0,
  changes_created INTEGER NOT NULL DEFAULT 0,
  changes_modified INTEGER NOT NULL DEFAULT 0,
  changes_deleted INTEGER NOT NULL DEFAULT 0,
  changes_renamed INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  cursor_before_json TEXT,
  cursor_after_json TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  error_summary_json TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE connection_observations (
  observation_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES data_connections(connection_id),
  target_id TEXT NOT NULL REFERENCES connection_targets(target_id),
  relative_path TEXT NOT NULL,
  normalized_path_key TEXT NOT NULL,
  file_identity TEXT,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('file', 'directory', 'symlink')),
  size_bytes INTEGER,
  mtime_ns TEXT,
  quick_fingerprint TEXT,
  content_hash TEXT,
  snapshot_id TEXT REFERENCES source_snapshots(snapshot_id),
  seen_in_scan_id TEXT REFERENCES connection_scan_runs(scan_run_id),
  state TEXT NOT NULL CHECK (state IN ('active', 'missing_pending', 'ignored', 'deleted')),
  missing_since TEXT,
  ignore_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (target_id, normalized_path_key)
) STRICT;

CREATE TABLE connection_change_batches (
  change_batch_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES data_connections(connection_id),
  scan_run_id TEXT NOT NULL REFERENCES connection_scan_runs(scan_run_id),
  state TEXT NOT NULL CHECK (state IN ('detected', 'accepted', 'processing', 'succeeded', 'partial', 'failed', 'cancelled')),
  item_count INTEGER NOT NULL CHECK (item_count > 0),
  accepted_at TEXT,
  completed_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  operation_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE connection_change_items (
  change_item_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES connection_change_batches(change_batch_id),
  observation_id TEXT,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('created', 'modified', 'deleted', 'renamed', 'restored')),
  state TEXT NOT NULL CHECK (state IN ('detected', 'stabilized', 'accepted', 'archived', 'ingested', 'ignored', 'failed', 'retrying')),
  relative_path TEXT NOT NULL,
  previous_path TEXT,
  previous_hash TEXT,
  current_hash TEXT,
  observation_version INTEGER NOT NULL,
  snapshot_id TEXT REFERENCES source_snapshots(snapshot_id),
  document_revision_id TEXT,
  ingestion_run_id TEXT,
  error_code TEXT,
  error_detail_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE connection_event_hints (
  event_hint_id INTEGER PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES data_connections(connection_id),
  target_id TEXT NOT NULL REFERENCES connection_targets(target_id),
  event_kind TEXT NOT NULL,
  relative_path TEXT,
  received_at TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'coalesced', 'processed', 'expired'))
) STRICT;

CREATE TABLE connection_write_receipts (
  write_receipt_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES data_connections(connection_id),
  target_id TEXT NOT NULL REFERENCES connection_targets(target_id),
  relative_path TEXT NOT NULL,
  normalized_path_key TEXT NOT NULL,
  expected_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE connection_failures (
  failure_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES data_connections(connection_id),
  scan_run_id TEXT REFERENCES connection_scan_runs(scan_run_id),
  change_item_id TEXT,
  error_code TEXT NOT NULL,
  retryable INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  next_retry_at TEXT,
  resolved_at TEXT,
  detail_json TEXT NOT NULL
) STRICT;

CREATE TABLE connection_daemon_leases (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(workspace_id),
  instance_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  host_id TEXT NOT NULL,
  cli_version TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE UNIQUE INDEX connection_target_active_identity_idx
  ON connection_targets(target_identity_key) WHERE deleted_at IS NULL;
CREATE INDEX connections_schedule_idx ON data_connections(state, next_scan_at);
CREATE INDEX connections_source_idx ON data_connections(source_id);
CREATE INDEX connection_scans_history_idx ON connection_scan_runs(connection_id, created_at DESC);
CREATE INDEX connection_scans_state_idx ON connection_scan_runs(state, created_at);
CREATE INDEX connection_observations_identity_idx ON connection_observations(target_id, file_identity) WHERE file_identity IS NOT NULL;
CREATE INDEX connection_observations_missing_idx ON connection_observations(connection_id, state, missing_since);
CREATE INDEX connection_batches_pending_idx ON connection_change_batches(state, created_at);
CREATE INDEX connection_items_batch_idx ON connection_change_items(batch_id, state);
CREATE INDEX connection_items_path_idx ON connection_change_items(relative_path, created_at DESC);
CREATE INDEX connection_hints_pending_idx ON connection_event_hints(connection_id, state, received_at);
CREATE INDEX connection_receipts_match_idx ON connection_write_receipts(target_id, normalized_path_key, expected_hash) WHERE consumed_at IS NULL;
CREATE INDEX connection_failures_retry_idx ON connection_failures(resolved_at, retryable, next_retry_at);

UPDATE workspace
SET database_schema_version = 3,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 3;
