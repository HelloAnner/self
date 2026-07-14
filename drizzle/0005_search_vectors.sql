CREATE TABLE model_providers (
  provider_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('openai_compatible', 'test_deterministic')),
  protocol TEXT NOT NULL CHECK (protocol IN ('openai-compatible', 'fixture')),
  endpoint_identity TEXT NOT NULL,
  api_key_env TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'failed')),
  circuit_state TEXT NOT NULL DEFAULT 'closed' CHECK (circuit_state IN ('closed', 'open', 'half_open')),
  last_error_code TEXT,
  last_error_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE models (
  model_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES model_providers(provider_id),
  capability TEXT NOT NULL CHECK (capability IN ('embedding', 'chat', 'rerank', 'vision', 'ocr')),
  provider_model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  revision_stability TEXT NOT NULL CHECK (revision_stability IN ('fixed', 'floating')),
  dimensions_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('active', 'disabled', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, capability, provider_model_id, model_revision)
) STRICT;

CREATE TABLE vector_spaces (
  vector_space_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(model_id),
  state TEXT NOT NULL CHECK (state IN ('building', 'verifying', 'ready', 'failed', 'deprecated', 'deleted')),
  space_fingerprint TEXT NOT NULL UNIQUE CHECK (length(space_fingerprint) = 64),
  provider_type TEXT NOT NULL,
  provider_endpoint_identity TEXT NOT NULL,
  provider_model_id TEXT NOT NULL,
  model_revision TEXT NOT NULL,
  revision_stability TEXT NOT NULL CHECK (revision_stability IN ('fixed', 'floating')),
  tokenizer_revision TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK (dimensions > 0 AND dimensions <= 8192),
  scalar_type TEXT NOT NULL CHECK (scalar_type = 'float32'),
  pooling TEXT NOT NULL,
  normalization TEXT NOT NULL CHECK (normalization = 'l2'),
  distance_metric TEXT NOT NULL CHECK (distance_metric = 'cosine'),
  query_instruction_id TEXT NOT NULL,
  query_instruction_text TEXT NOT NULL,
  document_instruction_id TEXT,
  document_instruction_text TEXT,
  embedding_input_version TEXT NOT NULL,
  sentinel_fingerprint TEXT,
  sentinel_tolerance REAL NOT NULL DEFAULT 0.00001 CHECK (sentinel_tolerance > 0),
  coverage_count INTEGER NOT NULL DEFAULT 0 CHECK (coverage_count >= 0),
  expected_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_chunk_count >= 0),
  last_error_code TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  deprecated_at TEXT,
  deleted_at TEXT
) STRICT;

CREATE TABLE model_invocations (
  invocation_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES model_providers(provider_id),
  model_id TEXT NOT NULL REFERENCES models(model_id),
  vector_space_id TEXT REFERENCES vector_spaces(vector_space_id),
  operation_kind TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  input_count INTEGER NOT NULL CHECK (input_count > 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  provider_actual_model_id TEXT,
  prompt_tokens INTEGER CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  duration_ms REAL,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE TABLE model_sentinel_results (
  vector_space_id TEXT NOT NULL REFERENCES vector_spaces(vector_space_id),
  invocation_id TEXT NOT NULL REFERENCES model_invocations(invocation_id),
  sentinel_fingerprint TEXT NOT NULL CHECK (length(sentinel_fingerprint) = 64),
  provider_actual_model_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('baseline', 'match', 'drift')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (vector_space_id, invocation_id)
) STRICT;

CREATE TABLE vector_build_runs (
  vector_build_run_id TEXT PRIMARY KEY,
  vector_space_id TEXT NOT NULL REFERENCES vector_spaces(vector_space_id),
  state TEXT NOT NULL CHECK (state IN ('queued', 'building', 'verifying', 'ready', 'failed', 'cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  input_watermark TEXT NOT NULL,
  cursor_chunk_id TEXT,
  chunks_total INTEGER NOT NULL DEFAULT 0 CHECK (chunks_total >= 0),
  chunks_embedded INTEGER NOT NULL DEFAULT 0 CHECK (chunks_embedded >= 0),
  chunks_reused INTEGER NOT NULL DEFAULT 0 CHECK (chunks_reused >= 0),
  chunks_failed INTEGER NOT NULL DEFAULT 0 CHECK (chunks_failed >= 0),
  batch_size INTEGER NOT NULL CHECK (batch_size > 0 AND batch_size <= 100),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE TABLE knowledge_embeddings (
  embedding_id TEXT PRIMARY KEY,
  vector_space_id TEXT NOT NULL REFERENCES vector_spaces(vector_space_id),
  chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(chunk_id),
  chunk_content_hash TEXT NOT NULL CHECK (length(chunk_content_hash) = 64),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  vector_hash TEXT NOT NULL CHECK (length(vector_hash) = 64),
  provider_actual_model_id TEXT,
  invocation_id TEXT REFERENCES model_invocations(invocation_id),
  state TEXT NOT NULL CHECK (state IN ('active', 'stale')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (vector_space_id, chunk_id, chunk_content_hash)
) STRICT;

CREATE TABLE knowledge_active_vector_space (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  active_vector_space_id TEXT REFERENCES vector_spaces(vector_space_id),
  previous_vector_space_id TEXT REFERENCES vector_spaces(vector_space_id),
  activated_at TEXT,
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO knowledge_active_vector_space(singleton_id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE vector_space_evaluations (
  evaluation_id TEXT PRIMARY KEY,
  left_vector_space_id TEXT NOT NULL REFERENCES vector_spaces(vector_space_id),
  right_vector_space_id TEXT REFERENCES vector_spaces(vector_space_id),
  kind TEXT NOT NULL CHECK (kind IN ('verify', 'compare')),
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  fixture_id TEXT,
  fixture_hash TEXT,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE retrieval_query_cache (
  vector_space_id TEXT NOT NULL REFERENCES vector_spaces(vector_space_id),
  query_hash TEXT NOT NULL CHECK (length(query_hash) = 64),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  embedding_blob BLOB NOT NULL,
  vector_hash TEXT NOT NULL CHECK (length(vector_hash) = 64),
  provider_actual_model_id TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0 CHECK (hit_count >= 0),
  PRIMARY KEY (vector_space_id, query_hash, input_hash)
) STRICT;

CREATE TABLE knowledge_index_generations (
  index_generation_id TEXT PRIMARY KEY,
  index_kind TEXT NOT NULL CHECK (index_kind = 'fts'),
  state TEXT NOT NULL CHECK (state IN ('building', 'verifying', 'ready', 'failed', 'deprecated', 'deleted')),
  algorithm_version TEXT NOT NULL,
  input_watermark TEXT NOT NULL,
  expected_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_chunk_count >= 0),
  indexed_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (indexed_chunk_count >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  deprecated_at TEXT,
  deleted_at TEXT
) STRICT;

CREATE TABLE knowledge_active_indexes (
  index_kind TEXT PRIMARY KEY CHECK (index_kind = 'fts'),
  active_generation_id TEXT REFERENCES knowledge_index_generations(index_generation_id),
  previous_generation_id TEXT REFERENCES knowledge_index_generations(index_generation_id),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO knowledge_active_indexes(index_kind, updated_at)
VALUES ('fts', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  index_generation_id UNINDEXED,
  chunk_id UNINDEXED,
  document_id UNINDEXED,
  source_id UNINDEXED,
  revision_id UNINDEXED,
  content_text,
  title_text,
  path_text,
  tags_text,
  tokenize='trigram'
);

CREATE INDEX models_capability_state_idx ON models(capability, state);
CREATE INDEX model_invocations_model_created_idx ON model_invocations(model_id, created_at DESC);
CREATE INDEX vector_spaces_model_state_idx ON vector_spaces(model_id, state);
CREATE INDEX vector_build_runs_space_created_idx ON vector_build_runs(vector_space_id, created_at DESC);
CREATE INDEX knowledge_embeddings_space_state_idx ON knowledge_embeddings(vector_space_id, state, chunk_id);
CREATE INDEX knowledge_embeddings_chunk_idx ON knowledge_embeddings(chunk_id, vector_space_id);
CREATE INDEX knowledge_index_generations_kind_state_idx ON knowledge_index_generations(index_kind, state, created_at DESC);

UPDATE workspace
SET database_schema_version = 5,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 5;
