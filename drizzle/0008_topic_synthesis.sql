CREATE TABLE topics (
  topic_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  scope_text TEXT NOT NULL,
  exclude_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active','stale','needs_review','deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  latest_snapshot_id TEXT,
  stale_reason TEXT,
  stale_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX topics_name_uq
  ON topics(normalized_name) WHERE status <> 'deleted';
CREATE INDEX topics_status_updated_idx ON topics(status, updated_at DESC);
CREATE INDEX topics_latest_snapshot_idx ON topics(latest_snapshot_id);

CREATE TABLE topic_aliases (
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, normalized_alias)
) STRICT;
CREATE INDEX topic_aliases_lookup_idx ON topic_aliases(normalized_alias, topic_id);

CREATE TABLE topic_synthesis_runs (
  synthesis_run_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  context_id TEXT REFERENCES evidence_contexts(context_id),
  parent_snapshot_id TEXT,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('full','rebuild')),
  state TEXT NOT NULL CHECK (state IN ('running','ready','failed')),
  retrieval_mode TEXT NOT NULL CHECK (retrieval_mode IN ('text','vector','hybrid')),
  scope_version INTEGER NOT NULL CHECK (scope_version > 0),
  fts_generation_id TEXT,
  vector_space_id TEXT,
  graph_generation_id TEXT,
  input_watermark TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  synthesis_rule_version TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (candidate_count >= 0),
  claim_count INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  timings_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (json_valid(timings_json)),
  CHECK (json_valid(warnings_json)),
  CHECK (error_json IS NULL OR json_valid(error_json))
) STRICT;
CREATE INDEX topic_synthesis_runs_topic_idx
  ON topic_synthesis_runs(topic_id, created_at DESC);

CREATE TABLE topic_snapshots (
  topic_snapshot_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(topic_id),
  synthesis_run_id TEXT NOT NULL UNIQUE REFERENCES topic_synthesis_runs(synthesis_run_id),
  parent_snapshot_id TEXT REFERENCES topic_snapshots(topic_snapshot_id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
  scope_json TEXT NOT NULL,
  watermarks_json TEXT NOT NULL,
  health_status TEXT NOT NULL CHECK (health_status IN ('healthy','degraded','needs_review','insufficient')),
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('high','medium','low','disputed','unknown')),
  confidence_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  change_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (topic_id, sequence),
  CHECK (json_valid(scope_json)),
  CHECK (json_valid(watermarks_json)),
  CHECK (json_valid(confidence_json)),
  CHECK (json_valid(coverage_json)),
  CHECK (json_valid(change_summary_json))
) STRICT;
CREATE INDEX topic_snapshots_topic_idx ON topic_snapshots(topic_id, sequence DESC);

CREATE TABLE topic_snapshot_claims (
  topic_snapshot_id TEXT NOT NULL REFERENCES topic_snapshots(topic_snapshot_id),
  claim_id TEXT NOT NULL REFERENCES graph_claims(claim_id),
  cluster_key TEXT NOT NULL,
  conclusion_type TEXT NOT NULL CHECK (conclusion_type IN ('consensus','single_source','user_opinion','inference','conflict')),
  role TEXT NOT NULL CHECK (role IN ('core','supporting','contradicting','context','excluded')),
  independent_source_count INTEGER NOT NULL CHECK (independent_source_count >= 0),
  evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
  source_lineages_json TEXT NOT NULL,
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('high','medium','low','disputed','unknown')),
  confidence_json TEXT NOT NULL,
  PRIMARY KEY (topic_snapshot_id, claim_id),
  CHECK (json_valid(source_lineages_json)),
  CHECK (json_valid(confidence_json))
) STRICT;
CREATE INDEX topic_snapshot_claims_claim_idx
  ON topic_snapshot_claims(claim_id, topic_snapshot_id);
CREATE INDEX topic_snapshot_claims_cluster_idx
  ON topic_snapshot_claims(topic_snapshot_id, cluster_key, conclusion_type);

CREATE TABLE topic_snapshot_nodes (
  topic_snapshot_id TEXT NOT NULL REFERENCES topic_snapshots(topic_snapshot_id),
  node_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
  node_kind TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('core','supporting','context')),
  PRIMARY KEY (topic_snapshot_id, node_id)
) STRICT;

CREATE TABLE topic_snapshot_relations (
  topic_snapshot_id TEXT NOT NULL REFERENCES topic_snapshots(topic_snapshot_id),
  relation_id TEXT NOT NULL REFERENCES graph_relations(relation_id),
  predicate_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('core','supporting','contradicting','context')),
  PRIMARY KEY (topic_snapshot_id, relation_id)
) STRICT;

CREATE TABLE topic_report_outlines (
  topic_snapshot_id TEXT PRIMARY KEY REFERENCES topic_snapshots(topic_snapshot_id),
  outline_json TEXT NOT NULL,
  outline_hash TEXT NOT NULL CHECK (length(outline_hash) = 64),
  created_at TEXT NOT NULL,
  CHECK (json_valid(outline_json))
) STRICT;

CREATE TABLE topic_report_sections (
  section_id TEXT PRIMARY KEY,
  topic_snapshot_id TEXT NOT NULL REFERENCES topic_snapshots(topic_snapshot_id),
  parent_section_id TEXT REFERENCES topic_report_sections(section_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  section_kind TEXT NOT NULL CHECK (section_kind IN ('overview','consensus','single_source','user_opinion','inference','conflict','unknown')),
  title TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('high','medium','low','disputed','unknown')),
  confidence_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  health_status TEXT NOT NULL CHECK (health_status IN ('healthy','degraded','needs_review','insufficient')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('added','modified','unchanged')),
  created_at TEXT NOT NULL,
  UNIQUE (topic_snapshot_id, ordinal),
  CHECK (json_valid(confidence_json)),
  CHECK (json_valid(coverage_json))
) STRICT;
CREATE INDEX topic_report_sections_snapshot_idx
  ON topic_report_sections(topic_snapshot_id, ordinal);

CREATE TABLE topic_report_conclusions (
  conclusion_id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES topic_report_sections(section_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  statement_text TEXT NOT NULL,
  conclusion_type TEXT NOT NULL CHECK (conclusion_type IN ('consensus','single_source','user_opinion','inference','conflict','unknown')),
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('high','medium','low','disputed','unknown')),
  support_status TEXT NOT NULL CHECK (support_status IN ('supported','not_applicable')),
  explanation_json TEXT NOT NULL,
  UNIQUE (section_id, ordinal),
  CHECK (json_valid(explanation_json))
) STRICT;

CREATE TABLE topic_report_citations (
  topic_citation_id TEXT PRIMARY KEY,
  conclusion_id TEXT NOT NULL REFERENCES topic_report_conclusions(conclusion_id),
  claim_id TEXT NOT NULL REFERENCES graph_claims(claim_id),
  evidence_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(chunk_id),
  revision_id TEXT NOT NULL REFERENCES knowledge_revisions(revision_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
  blob_sha256 TEXT NOT NULL REFERENCES source_blobs(sha256),
  excerpt_start INTEGER NOT NULL CHECK (excerpt_start >= 0),
  excerpt_end INTEGER NOT NULL CHECK (excerpt_end >= excerpt_start),
  excerpt_hash TEXT NOT NULL CHECK (length(excerpt_hash) = 64),
  source_lineage_key TEXT NOT NULL,
  directness TEXT NOT NULL CHECK (directness IN ('direct','paraphrase','inferred')),
  role TEXT NOT NULL CHECK (role IN ('support','contradict','context','definition')),
  validation_rule TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX topic_report_citations_conclusion_idx
  ON topic_report_citations(conclusion_id, claim_id);
CREATE INDEX topic_report_citations_chunk_idx
  ON topic_report_citations(chunk_id, conclusion_id);

CREATE TABLE topic_knowledge_gaps (
  knowledge_gap_id TEXT PRIMARY KEY,
  topic_snapshot_id TEXT NOT NULL REFERENCES topic_snapshots(topic_snapshot_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  question_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('high','medium','low')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  related_claim_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (topic_snapshot_id, ordinal),
  CHECK (json_valid(related_claim_ids_json))
) STRICT;

CREATE TRIGGER topic_snapshots_immutable_update
BEFORE UPDATE ON topic_snapshots BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;
CREATE TRIGGER topic_snapshots_immutable_delete
BEFORE DELETE ON topic_snapshots BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;
CREATE TRIGGER topic_snapshot_claims_immutable_update
BEFORE UPDATE ON topic_snapshot_claims BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;
CREATE TRIGGER topic_snapshot_claims_immutable_delete
BEFORE DELETE ON topic_snapshot_claims BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;
CREATE TRIGGER topic_report_sections_immutable_update
BEFORE UPDATE ON topic_report_sections BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;
CREATE TRIGGER topic_report_sections_immutable_delete
BEFORE DELETE ON topic_report_sections BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;
CREATE TRIGGER topic_report_conclusions_immutable_update
BEFORE UPDATE ON topic_report_conclusions BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;
CREATE TRIGGER topic_report_conclusions_immutable_delete
BEFORE DELETE ON topic_report_conclusions BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;
CREATE TRIGGER topic_report_citations_immutable_update
BEFORE UPDATE ON topic_report_citations BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;
CREATE TRIGGER topic_report_citations_immutable_delete
BEFORE DELETE ON topic_report_citations BEGIN SELECT RAISE(ABORT, 'topic_snapshot_immutable'); END;

UPDATE workspace
SET database_schema_version = 8,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 8;
