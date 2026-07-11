CREATE TABLE sources (
  source_id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'markdown', 'directory', 'obsidian', 'web', 'text', 'jsonl')),
  mode TEXT NOT NULL CHECK (mode IN ('import', 'snapshot', 'mirror')),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'failed', 'deleted')),
  archive_status TEXT NOT NULL CHECK (archive_status IN ('registered', 'archiving', 'published', 'failed')),
  spec_json TEXT NOT NULL,
  current_snapshot_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE source_blobs (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL,
  relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE source_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  previous_snapshot_id TEXT REFERENCES source_snapshots(snapshot_id),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  manifest_relative_path TEXT NOT NULL UNIQUE,
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (source_id, sequence)
) STRICT;

CREATE TABLE source_snapshot_entries (
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
  logical_path TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES source_blobs(sha256),
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  origin_uri TEXT,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, logical_path)
) STRICT;

CREATE TABLE source_snapshot_changes (
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
  logical_path TEXT NOT NULL,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('added', 'modified', 'deleted')),
  previous_blob_sha256 TEXT,
  blob_sha256 TEXT,
  PRIMARY KEY (snapshot_id, logical_path)
) STRICT;

CREATE TABLE source_batch_receipts (
  change_batch_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
  accepted_at TEXT NOT NULL
) STRICT;

CREATE INDEX sources_state_updated_idx ON sources(state, updated_at DESC);
CREATE INDEX source_snapshots_source_created_idx ON source_snapshots(source_id, created_at DESC);
CREATE INDEX source_snapshot_entries_blob_idx ON source_snapshot_entries(blob_sha256);

UPDATE workspace
SET database_schema_version = 2,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 2;
