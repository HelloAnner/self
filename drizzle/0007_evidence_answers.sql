CREATE TABLE retrieval_runs (
  retrieval_run_id TEXT PRIMARY KEY,
  query_hash TEXT NOT NULL CHECK (length(query_hash) = 64),
  plan_version TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('text','vector','hybrid')),
  depth TEXT NOT NULL CHECK (depth IN ('shallow','normal','deep')),
  state TEXT NOT NULL CHECK (state IN ('running','ready','failed')),
  filters_json TEXT NOT NULL DEFAULT '{}',
  fts_generation_id TEXT,
  vector_space_id TEXT,
  vector_space_fingerprint TEXT,
  graph_generation_id TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  timings_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (json_valid(filters_json)),
  CHECK (json_valid(timings_json)),
  CHECK (json_valid(warnings_json))
) STRICT;

CREATE INDEX retrieval_runs_query_idx
  ON retrieval_runs(query_hash, state, created_at DESC);

CREATE TABLE retrieval_candidates (
  retrieval_run_id TEXT NOT NULL REFERENCES retrieval_runs(retrieval_run_id),
  chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(chunk_id),
  claim_id TEXT REFERENCES graph_claims(claim_id),
  rank INTEGER NOT NULL CHECK (rank > 0),
  score REAL NOT NULL,
  routes_json TEXT NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0,1)),
  PRIMARY KEY (retrieval_run_id, rank),
  CHECK (json_valid(routes_json))
) STRICT;

CREATE INDEX retrieval_candidates_selected_idx
  ON retrieval_candidates(retrieval_run_id, selected, rank);

CREATE TABLE evidence_contexts (
  context_id TEXT PRIMARY KEY,
  retrieval_run_id TEXT NOT NULL REFERENCES retrieval_runs(retrieval_run_id),
  context_hash TEXT NOT NULL CHECK (length(context_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('active','stale')),
  token_budget INTEGER NOT NULL CHECK (token_budget > 0),
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  prompt_spec_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  stale_at TEXT,
  stale_reason TEXT
) STRICT;

CREATE INDEX evidence_contexts_retrieval_idx
  ON evidence_contexts(retrieval_run_id, state);

CREATE TABLE evidence_context_items (
  context_id TEXT NOT NULL REFERENCES evidence_contexts(context_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  evidence_key TEXT NOT NULL,
  chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(chunk_id),
  document_id TEXT NOT NULL REFERENCES knowledge_documents(document_id),
  revision_id TEXT NOT NULL REFERENCES knowledge_revisions(revision_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
  blob_sha256 TEXT NOT NULL REFERENCES source_blobs(sha256),
  claim_id TEXT REFERENCES graph_claims(claim_id),
  claim_status TEXT,
  claim_confidence_level TEXT,
  excerpt_start INTEGER NOT NULL CHECK (excerpt_start >= 0),
  excerpt_end INTEGER NOT NULL CHECK (excerpt_end >= excerpt_start),
  excerpt_hash TEXT NOT NULL CHECK (length(excerpt_hash) = 64),
  role TEXT NOT NULL CHECK (role IN ('seed','graph_support','graph_contradict')),
  PRIMARY KEY (context_id, ordinal),
  UNIQUE (context_id, evidence_key)
) STRICT;

CREATE INDEX evidence_context_items_chunk_idx
  ON evidence_context_items(chunk_id, context_id);
CREATE INDEX evidence_context_items_source_idx
  ON evidence_context_items(source_id, context_id);

CREATE TABLE answer_runs (
  answer_id TEXT PRIMARY KEY,
  retrieval_run_id TEXT NOT NULL REFERENCES retrieval_runs(retrieval_run_id),
  context_id TEXT NOT NULL REFERENCES evidence_contexts(context_id),
  query_hash TEXT NOT NULL CHECK (length(query_hash) = 64),
  model_id TEXT REFERENCES models(model_id),
  invocation_id TEXT REFERENCES model_invocations(invocation_id),
  provider_actual_model_id TEXT,
  prompt_spec_version TEXT NOT NULL,
  allow_model_knowledge INTEGER NOT NULL DEFAULT 0 CHECK (allow_model_knowledge IN (0,1)),
  result_kind TEXT NOT NULL CHECK (result_kind IN ('answered','insufficient_evidence','conflicted','cannot_determine')),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed')),
  cache_state TEXT NOT NULL CHECK (cache_state IN ('active','stale')),
  summary_text TEXT NOT NULL,
  answer_hash TEXT NOT NULL CHECK (length(answer_hash) = 64),
  validation_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  stale_at TEXT,
  stale_reason TEXT,
  CHECK (json_valid(validation_json))
) STRICT;

CREATE INDEX answer_runs_query_cache_idx
  ON answer_runs(query_hash, cache_state, status, created_at DESC);
CREATE INDEX answer_runs_context_idx ON answer_runs(context_id);

CREATE TABLE answer_statements (
  statement_id TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL REFERENCES answer_runs(answer_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  statement_text TEXT NOT NULL,
  conclusion_type TEXT NOT NULL CHECK (conclusion_type IN ('fact','single_source','user_opinion','inference','conflict','unknown','model_knowledge')),
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('high','medium','low','disputed','unknown')),
  support_status TEXT NOT NULL CHECK (support_status IN ('supported','external','not_applicable')),
  UNIQUE (answer_id, ordinal)
) STRICT;

CREATE TABLE answer_citations (
  citation_id TEXT PRIMARY KEY,
  answer_id TEXT NOT NULL REFERENCES answer_runs(answer_id),
  statement_id TEXT NOT NULL REFERENCES answer_statements(statement_id),
  context_id TEXT NOT NULL,
  context_ordinal INTEGER NOT NULL,
  excerpt_start INTEGER NOT NULL CHECK (excerpt_start >= 0),
  excerpt_end INTEGER NOT NULL CHECK (excerpt_end >= excerpt_start),
  excerpt_hash TEXT NOT NULL CHECK (length(excerpt_hash) = 64),
  support_status TEXT NOT NULL CHECK (support_status = 'supported'),
  validation_rule TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (context_id, context_ordinal)
    REFERENCES evidence_context_items(context_id, ordinal)
) STRICT;

CREATE INDEX answer_citations_answer_idx ON answer_citations(answer_id, statement_id);

UPDATE workspace
SET database_schema_version = 7,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 7;
