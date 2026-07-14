CREATE TABLE automation_jobs (
  job_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  operation_id TEXT,
  parent_job_id TEXT REFERENCES automation_jobs(job_id),
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','waiting','succeeded','partial','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  input_json TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  progress_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_json TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  cancel_requested_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  worker_pid INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK (json_valid(input_json)),
  CHECK (json_valid(checkpoint_json)),
  CHECK (json_valid(progress_json)),
  CHECK (result_json IS NULL OR json_valid(result_json)),
  CHECK (error_json IS NULL OR json_valid(error_json))
) STRICT;
CREATE UNIQUE INDEX automation_jobs_idempotency_uq
  ON automation_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX automation_jobs_state_priority_idx
  ON automation_jobs(state, priority DESC, created_at);
CREATE INDEX automation_jobs_kind_created_idx
  ON automation_jobs(kind, created_at DESC);

CREATE TABLE automation_job_events (
  job_id TEXT NOT NULL REFERENCES automation_jobs(job_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  state TEXT NOT NULL,
  progress_json TEXT NOT NULL DEFAULT '{}',
  message TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, sequence),
  CHECK (json_valid(progress_json))
) STRICT;
CREATE INDEX automation_job_events_created_idx
  ON automation_job_events(created_at, job_id);

CREATE TABLE operation_backups (
  backup_id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES automation_jobs(job_id),
  operation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('creating','ready','failed','deleted')),
  manifest_relative_path TEXT NOT NULL UNIQUE,
  manifest_hash TEXT,
  database_hash TEXT,
  database_schema_version INTEGER NOT NULL,
  includes_models INTEGER NOT NULL DEFAULT 0 CHECK (includes_models IN (0, 1)),
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  verified_at TEXT
) STRICT;
CREATE INDEX operation_backups_state_created_idx
  ON operation_backups(state, created_at DESC);

CREATE TABLE operation_backup_files (
  backup_id TEXT NOT NULL REFERENCES operation_backups(backup_id),
  relative_path TEXT NOT NULL,
  file_kind TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mode INTEGER,
  PRIMARY KEY (backup_id, relative_path)
) STRICT;

CREATE TABLE operation_verification_runs (
  verification_id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES automation_jobs(job_id),
  mode TEXT NOT NULL CHECK (mode IN ('shallow','deep','backup','restore')),
  state TEXT NOT NULL CHECK (state IN ('running','passed','failed')),
  checked_json TEXT NOT NULL DEFAULT '{}',
  issue_count INTEGER NOT NULL DEFAULT 0 CHECK (issue_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (json_valid(checked_json))
) STRICT;
CREATE INDEX operation_verification_runs_started_idx
  ON operation_verification_runs(started_at DESC);

CREATE TABLE operation_verification_issues (
  verification_id TEXT NOT NULL REFERENCES operation_verification_runs(verification_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  severity TEXT NOT NULL CHECK (severity IN ('warning','error')),
  code TEXT NOT NULL,
  resource_id TEXT,
  relative_path TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (verification_id, ordinal),
  CHECK (json_valid(details_json))
) STRICT;

CREATE TABLE operation_gc_receipts (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
  plan_id TEXT NOT NULL UNIQUE,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  reclaimed_bytes INTEGER NOT NULL CHECK (reclaimed_bytes >= 0),
  proof_hash TEXT NOT NULL CHECK (length(proof_hash) = 64),
  completed_at TEXT NOT NULL
) STRICT;

CREATE TABLE operation_gc_items (
  operation_id TEXT NOT NULL REFERENCES operation_gc_receipts(operation_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  candidate_kind TEXT NOT NULL,
  resource_id TEXT,
  relative_path TEXT,
  content_hash TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  proof_json TEXT NOT NULL,
  PRIMARY KEY (operation_id, ordinal),
  CHECK (content_hash IS NULL OR length(content_hash) = 64),
  CHECK (json_valid(proof_json))
) STRICT;

CREATE TABLE operation_maintenance_lease (
  singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
  owner TEXT NOT NULL,
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  purpose TEXT NOT NULL,
  pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER automation_job_events_immutable_update
BEFORE UPDATE ON automation_job_events BEGIN
  SELECT RAISE(ABORT, 'automation_job_event_immutable');
END;
CREATE TRIGGER automation_job_events_immutable_delete
BEFORE DELETE ON automation_job_events BEGIN
  SELECT RAISE(ABORT, 'automation_job_event_immutable');
END;
CREATE TRIGGER operation_backup_files_immutable_update
BEFORE UPDATE ON operation_backup_files BEGIN
  SELECT RAISE(ABORT, 'operation_backup_file_immutable');
END;
CREATE TRIGGER operation_verification_issues_immutable_update
BEFORE UPDATE ON operation_verification_issues BEGIN
  SELECT RAISE(ABORT, 'operation_verification_issue_immutable');
END;
CREATE TRIGGER operation_verification_issues_immutable_delete
BEFORE DELETE ON operation_verification_issues BEGIN
  SELECT RAISE(ABORT, 'operation_verification_issue_immutable');
END;
CREATE TRIGGER operation_gc_items_immutable_update
BEFORE UPDATE ON operation_gc_items BEGIN
  SELECT RAISE(ABORT, 'operation_gc_item_immutable');
END;
CREATE TRIGGER operation_gc_items_immutable_delete
BEFORE DELETE ON operation_gc_items BEGIN
  SELECT RAISE(ABORT, 'operation_gc_item_immutable');
END;

UPDATE workspace
SET database_schema_version = 11,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 11;
