CREATE TABLE ingestion_runs (
  ingestion_run_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('source_add', 'source_sync', 'connection', 'manual', 'rebuild', 'recovery')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'parsing', 'normalized', 'chunked', 'publishing', 'ready', 'failed', 'retrying', 'cancelled')),
  parser_version TEXT NOT NULL,
  normalizer_version TEXT NOT NULL,
  chunker_version TEXT NOT NULL,
  config_fingerprint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  files_total INTEGER NOT NULL DEFAULT 0 CHECK (files_total >= 0),
  files_parsed INTEGER NOT NULL DEFAULT 0 CHECK (files_parsed >= 0),
  files_skipped INTEGER NOT NULL DEFAULT 0 CHECK (files_skipped >= 0),
  documents_published INTEGER NOT NULL DEFAULT 0 CHECK (documents_published >= 0),
  chunks_published INTEGER NOT NULL DEFAULT 0 CHECK (chunks_published >= 0),
  chunks_reused INTEGER NOT NULL DEFAULT 0 CHECK (chunks_reused >= 0),
  chunks_tombstoned INTEGER NOT NULL DEFAULT 0 CHECK (chunks_tombstoned >= 0),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  retry_of_run_id TEXT REFERENCES ingestion_runs(ingestion_run_id),
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE ingestion_entry_results (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(ingestion_run_id),
  logical_path TEXT NOT NULL,
  blob_sha256 TEXT REFERENCES source_blobs(sha256),
  parser_id TEXT,
  parser_version TEXT,
  state TEXT NOT NULL CHECK (state IN ('parsed', 'skipped', 'failed')),
  normalized_content_hash TEXT,
  block_count INTEGER NOT NULL DEFAULT 0 CHECK (block_count >= 0),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  error_code TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, logical_path)
) STRICT;

CREATE TABLE knowledge_documents (
  document_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  logical_path TEXT NOT NULL,
  normalized_path_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  current_revision_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (source_id, normalized_path_key)
) STRICT;

CREATE TABLE knowledge_revisions (
  revision_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(document_id),
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
  logical_path TEXT NOT NULL,
  blob_sha256 TEXT NOT NULL REFERENCES source_blobs(sha256),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  previous_revision_id TEXT REFERENCES knowledge_revisions(revision_id),
  parser_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  normalizer_version TEXT NOT NULL,
  algorithm_fingerprint TEXT NOT NULL CHECK (length(algorithm_fingerprint) = 64),
  normalized_content_hash TEXT NOT NULL CHECK (length(normalized_content_hash) = 64),
  structure_hash TEXT NOT NULL CHECK (length(structure_hash) = 64),
  title TEXT,
  language TEXT NOT NULL,
  content_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(ingestion_run_id),
  created_at TEXT NOT NULL,
  UNIQUE (document_id, snapshot_id, algorithm_fingerprint),
  UNIQUE (document_id, sequence),
  FOREIGN KEY (snapshot_id, logical_path) REFERENCES source_snapshot_entries(snapshot_id, logical_path)
) STRICT;

CREATE TABLE knowledge_chunks (
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(document_id),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  content_text TEXT NOT NULL,
  block_kind TEXT NOT NULL,
  token_estimate INTEGER NOT NULL CHECK (token_estimate >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'tombstoned')),
  first_seen_revision_id TEXT NOT NULL REFERENCES knowledge_revisions(revision_id),
  last_seen_revision_id TEXT NOT NULL REFERENCES knowledge_revisions(revision_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  tombstoned_at TEXT
) STRICT;

CREATE TABLE knowledge_revision_chunks (
  revision_id TEXT NOT NULL REFERENCES knowledge_revisions(revision_id),
  chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(chunk_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  heading_path_json TEXT NOT NULL DEFAULT '[]',
  source_start_line INTEGER,
  source_end_line INTEGER,
  anchor_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (revision_id, chunk_id),
  UNIQUE (revision_id, ordinal)
) STRICT;

CREATE TABLE knowledge_run_documents (
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(ingestion_run_id),
  document_id TEXT NOT NULL REFERENCES knowledge_documents(document_id),
  revision_id TEXT NOT NULL REFERENCES knowledge_revisions(revision_id),
  logical_path TEXT NOT NULL,
  reused_revision INTEGER NOT NULL CHECK (reused_revision IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (ingestion_run_id, document_id)
) STRICT;

CREATE TABLE knowledge_chunk_lineage (
  previous_chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(chunk_id),
  next_chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(chunk_id),
  ingestion_run_id TEXT NOT NULL REFERENCES ingestion_runs(ingestion_run_id),
  relationship TEXT NOT NULL CHECK (relationship IN ('modified', 'split', 'merged')),
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (previous_chunk_id, next_chunk_id, ingestion_run_id)
) STRICT;

CREATE TABLE knowledge_notes (
  note_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  document_id TEXT REFERENCES knowledge_documents(document_id),
  relative_path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE INDEX ingestion_runs_source_created_idx ON ingestion_runs(source_id, created_at DESC);
CREATE INDEX ingestion_runs_snapshot_state_idx ON ingestion_runs(snapshot_id, state);
CREATE INDEX ingestion_entry_results_state_idx ON ingestion_entry_results(ingestion_run_id, state);
CREATE INDEX knowledge_documents_source_state_idx ON knowledge_documents(source_id, state, logical_path);
CREATE INDEX knowledge_revisions_document_created_idx ON knowledge_revisions(document_id, created_at DESC);
CREATE INDEX knowledge_revisions_snapshot_idx ON knowledge_revisions(snapshot_id);
CREATE INDEX knowledge_chunks_document_state_idx ON knowledge_chunks(document_id, state);
CREATE INDEX knowledge_chunks_hash_idx ON knowledge_chunks(document_id, content_hash);
CREATE INDEX knowledge_revision_chunks_chunk_idx ON knowledge_revision_chunks(chunk_id, revision_id);
CREATE INDEX knowledge_run_documents_revision_idx ON knowledge_run_documents(revision_id);

ALTER TABLE sources ADD COLUMN ingestion_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK (ingestion_status IN ('not_started', 'queued', 'running', 'ready', 'failed'));
ALTER TABLE sources ADD COLUMN current_ingestion_run_id TEXT REFERENCES ingestion_runs(ingestion_run_id);

UPDATE workspace
SET database_schema_version = 4,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 4;
