CREATE TABLE graph_generations (
  generation_id TEXT PRIMARY KEY,
  generation_kind TEXT NOT NULL CHECK (generation_kind IN ('incremental','full')),
  state TEXT NOT NULL CHECK (state IN ('queued','building','verifying','ready','active','failed','superseded')),
  parent_generation_id TEXT REFERENCES graph_generations(generation_id),
  input_watermark TEXT NOT NULL,
  predicate_version TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  model_route_snapshot TEXT NOT NULL DEFAULT '{}',
  config_hash TEXT NOT NULL CHECK (length(config_hash) = 64),
  node_count INTEGER NOT NULL DEFAULT 0 CHECK (node_count >= 0),
  relation_count INTEGER NOT NULL DEFAULT 0 CHECK (relation_count >= 0),
  claim_count INTEGER NOT NULL DEFAULT 0 CHECK (claim_count >= 0),
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  activated_at TEXT,
  failure_json TEXT,
  CHECK (json_valid(model_route_snapshot)),
  CHECK (json_valid(checkpoint_json)),
  CHECK (failure_json IS NULL OR json_valid(failure_json))
) STRICT;

CREATE TABLE graph_active_generation (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  active_generation_id TEXT REFERENCES graph_generations(generation_id),
  previous_generation_id TEXT REFERENCES graph_generations(generation_id),
  updated_at TEXT NOT NULL
) STRICT;

INSERT INTO graph_active_generation(singleton_id, updated_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE graph_nodes (
  node_id TEXT PRIMARY KEY,
  node_kind TEXT NOT NULL CHECK (node_kind IN ('source','document','revision','chunk','entity','claim','topic')),
  external_ref_id TEXT,
  source_id TEXT,
  canonical_label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','active','stale','redirected','rejected','deleted')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('structural','explicit','user','model','rule')),
  properties_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (json_valid(properties_json))
) STRICT;

CREATE UNIQUE INDEX graph_nodes_external_ref_uq
  ON graph_nodes(node_kind, external_ref_id)
  WHERE external_ref_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX graph_nodes_kind_status_idx ON graph_nodes(node_kind, status, updated_at DESC);
CREATE INDEX graph_nodes_label_idx ON graph_nodes(normalized_label, node_kind);
CREATE INDEX graph_nodes_source_idx ON graph_nodes(source_id, node_kind, status);

CREATE TABLE graph_generation_nodes (
  generation_id TEXT NOT NULL REFERENCES graph_generations(generation_id),
  node_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
  PRIMARY KEY (generation_id, node_id)
) STRICT;

CREATE TABLE graph_entities (
  entity_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE REFERENCES graph_nodes(node_id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person','organization','project','concept','technology','product','event','place','work','dataset','method','standard','user_defined')),
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  description TEXT,
  identity_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed','active','needs_review','redirected','rejected','deleted')),
  origin TEXT NOT NULL CHECK (origin IN ('user','model','rule')),
  user_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (user_confirmed IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX graph_entities_identity_uq
  ON graph_entities(entity_type, identity_key)
  WHERE identity_key IS NOT NULL AND status <> 'deleted';
CREATE INDEX graph_entities_name_type_idx ON graph_entities(normalized_name, entity_type, status);

CREATE TABLE graph_entity_aliases (
  alias_id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  language TEXT,
  scope TEXT NOT NULL DEFAULT '',
  evidence_chunk_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('user','model','parser','rule')),
  created_at TEXT NOT NULL,
  UNIQUE(entity_id, normalized_alias, language, scope)
) STRICT;
CREATE INDEX graph_alias_lookup_idx ON graph_entity_aliases(normalized_alias, language);

CREATE TABLE graph_entity_redirects (
  source_entity_id TEXT PRIMARY KEY REFERENCES graph_entities(entity_id),
  target_entity_id TEXT NOT NULL REFERENCES graph_entities(entity_id),
  operation_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (source_entity_id <> target_entity_id)
) STRICT;

CREATE TABLE graph_predicates (
  predicate_key TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  layer TEXT NOT NULL CHECK (layer IN ('structural','explicit','semantic','claim','topic')),
  display_name TEXT NOT NULL,
  inverse_predicate_key TEXT,
  subject_kinds_json TEXT NOT NULL,
  object_kinds_json TEXT NOT NULL,
  symmetric INTEGER NOT NULL DEFAULT 0 CHECK (symmetric IN (0,1)),
  transitive INTEGER NOT NULL DEFAULT 0 CHECK (transitive IN (0,1)),
  temporal INTEGER NOT NULL DEFAULT 0 CHECK (temporal IN (0,1)),
  evidence_required INTEGER NOT NULL DEFAULT 1 CHECK (evidence_required IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('active','deprecated')),
  replacement_key TEXT,
  CHECK (json_valid(subject_kinds_json)),
  CHECK (json_valid(object_kinds_json))
) STRICT;

CREATE TABLE graph_relations (
  relation_id TEXT PRIMARY KEY,
  subject_node_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
  predicate_key TEXT NOT NULL REFERENCES graph_predicates(predicate_key),
  object_node_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
  qualifier_hash TEXT NOT NULL CHECK (length(qualifier_hash) = 64),
  qualifiers_json TEXT NOT NULL DEFAULT '{}',
  valid_from TEXT,
  valid_to TEXT,
  observed_at TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('structural','explicit_link','parser','user','model','rule')),
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','needs_review','stale','rejected','deprecated','deleted')),
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('high','medium','low','disputed','unknown')),
  confidence_json TEXT NOT NULL,
  claim_id TEXT,
  extraction_run_id TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (subject_node_id <> object_node_id OR predicate_key IN ('equivalent_to','similar_to')),
  CHECK (json_valid(qualifiers_json)),
  CHECK (json_valid(confidence_json))
) STRICT;

CREATE UNIQUE INDEX graph_relation_identity_uq
  ON graph_relations(subject_node_id, predicate_key, object_node_id, qualifier_hash, origin)
  WHERE deleted_at IS NULL;
CREATE INDEX graph_relation_out_idx ON graph_relations(subject_node_id, predicate_key, status, object_node_id);
CREATE INDEX graph_relation_in_idx ON graph_relations(object_node_id, predicate_key, status, subject_node_id);
CREATE INDEX graph_relation_claim_idx ON graph_relations(claim_id) WHERE claim_id IS NOT NULL;

CREATE TABLE graph_generation_relations (
  generation_id TEXT NOT NULL REFERENCES graph_generations(generation_id),
  relation_id TEXT NOT NULL REFERENCES graph_relations(relation_id),
  PRIMARY KEY (generation_id, relation_id)
) STRICT;

CREATE TABLE graph_relation_evidence (
  relation_id TEXT NOT NULL REFERENCES graph_relations(relation_id),
  evidence_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('chunk','claim','user_assertion')),
  chunk_id TEXT,
  claim_id TEXT,
  revision_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('support','contradict','context','definition')),
  directness TEXT NOT NULL CHECK (directness IN ('direct','paraphrase','inferred')),
  locator_json TEXT NOT NULL,
  excerpt_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','stale','withdrawn')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (relation_id, evidence_id),
  CHECK (chunk_id IS NOT NULL OR claim_id IS NOT NULL OR evidence_kind = 'user_assertion'),
  CHECK (json_valid(locator_json))
) STRICT;
CREATE INDEX graph_relation_evidence_chunk_idx ON graph_relation_evidence(chunk_id, state);

CREATE TABLE graph_claims (
  claim_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL UNIQUE REFERENCES graph_nodes(node_id),
  subject_node_id TEXT,
  predicate_key TEXT REFERENCES graph_predicates(predicate_key),
  object_node_id TEXT,
  value_json TEXT,
  qualifier_hash TEXT NOT NULL CHECK (length(qualifier_hash) = 64),
  qualifiers_json TEXT NOT NULL,
  normalized_statement TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  epistemic_status TEXT NOT NULL CHECK (epistemic_status IN ('fact','user_opinion','inference','unknown')),
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','user_confirmed','disputed','stale','superseded','rejected','deleted')),
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('high','medium','low','disputed','unknown')),
  confidence_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('user','model','rule','parser')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (object_node_id IS NOT NULL OR value_json IS NOT NULL),
  CHECK (json_valid(qualifiers_json)),
  CHECK (json_valid(confidence_json)),
  CHECK (value_json IS NULL OR json_valid(value_json))
) STRICT;
CREATE INDEX graph_claim_subject_idx ON graph_claims(subject_node_id, predicate_key, status);
CREATE INDEX graph_claim_statement_idx ON graph_claims(normalized_statement, status);

CREATE TABLE graph_generation_claims (
  generation_id TEXT NOT NULL REFERENCES graph_generations(generation_id),
  claim_id TEXT NOT NULL REFERENCES graph_claims(claim_id),
  PRIMARY KEY (generation_id, claim_id)
) STRICT;

CREATE TABLE graph_claim_evidence (
  claim_id TEXT NOT NULL REFERENCES graph_claims(claim_id),
  evidence_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('support','contradict','context','definition')),
  directness TEXT NOT NULL CHECK (directness IN ('direct','paraphrase','inferred')),
  source_lineage_key TEXT,
  locator_json TEXT NOT NULL,
  excerpt_hash TEXT NOT NULL CHECK (length(excerpt_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('active','stale','withdrawn')),
  extraction_run_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (claim_id, evidence_id),
  CHECK (json_valid(locator_json))
) STRICT;
CREATE INDEX graph_claim_evidence_chunk_idx ON graph_claim_evidence(chunk_id, state, claim_id);

CREATE TABLE graph_claim_relations (
  source_claim_id TEXT NOT NULL REFERENCES graph_claims(claim_id),
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supports','contradicts','refines','supersedes','equivalent_to','derived_from')),
  target_claim_id TEXT NOT NULL REFERENCES graph_claims(claim_id),
  confidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','stale')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_claim_id, relation_type, target_claim_id),
  CHECK (source_claim_id <> target_claim_id),
  CHECK (json_valid(confidence_json))
) STRICT;
CREATE INDEX graph_claim_relation_target_idx ON graph_claim_relations(target_claim_id, relation_type, status);

CREATE TABLE graph_conflict_sets (
  conflict_id TEXT PRIMARY KEY,
  conflict_key TEXT NOT NULL UNIQUE,
  subject_node_id TEXT,
  predicate_key TEXT,
  qualifier_scope_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','confirmed','partially_resolved','resolved','stale','deleted')),
  summary TEXT,
  resolution_json TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (resolution_json IS NULL OR json_valid(resolution_json))
) STRICT;

CREATE TABLE graph_conflict_members (
  conflict_id TEXT NOT NULL REFERENCES graph_conflict_sets(conflict_id),
  claim_id TEXT NOT NULL REFERENCES graph_claims(claim_id),
  position_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('position','counter_position')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (conflict_id, claim_id)
) STRICT;
CREATE INDEX graph_conflict_member_claim_idx ON graph_conflict_members(claim_id, conflict_id);

CREATE TABLE graph_unresolved_references (
  reference_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES graph_generations(generation_id),
  source_revision_id TEXT NOT NULL,
  source_chunk_id TEXT,
  reference_kind TEXT NOT NULL CHECK (reference_kind IN ('markdown','wiki','embed','citation')),
  raw_target TEXT NOT NULL,
  normalized_target TEXT NOT NULL,
  locator_json TEXT NOT NULL,
  resolution_state TEXT NOT NULL CHECK (resolution_state IN ('pending','ambiguous','resolved','missing','stale')),
  candidate_ids_json TEXT NOT NULL DEFAULT '[]',
  resolved_node_id TEXT,
  last_attempt_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (json_valid(locator_json)),
  CHECK (json_valid(candidate_ids_json))
) STRICT;
CREATE INDEX graph_unresolved_target_idx ON graph_unresolved_references(normalized_target, resolution_state);
CREATE INDEX graph_unresolved_generation_idx ON graph_unresolved_references(generation_id, resolution_state);

CREATE TABLE graph_semantic_neighbors (
  vector_space_id TEXT NOT NULL REFERENCES vector_spaces(vector_space_id),
  generation_id TEXT NOT NULL REFERENCES graph_generations(generation_id),
  source_node_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
  target_node_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
  source_content_hash TEXT NOT NULL,
  target_content_hash TEXT NOT NULL,
  score REAL NOT NULL CHECK (score >= -1 AND score <= 1),
  rank INTEGER NOT NULL CHECK (rank > 0),
  scope_key TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  stale_at TEXT,
  PRIMARY KEY (vector_space_id, generation_id, source_node_id, target_node_id, scope_key),
  CHECK (source_node_id <> target_node_id)
) STRICT;
CREATE INDEX graph_semantic_neighbor_lookup_idx
  ON graph_semantic_neighbors(vector_space_id, generation_id, source_node_id, scope_key, rank)
  WHERE stale_at IS NULL;

CREATE TABLE graph_extraction_runs (
  extraction_run_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES graph_generations(generation_id),
  run_kind TEXT NOT NULL CHECK (run_kind IN ('entity_claim','link_parse')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','partial')),
  input_revision_id TEXT,
  input_chunk_id TEXT,
  model_id TEXT,
  prompt_spec_version TEXT,
  schema_version TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  output_hash TEXT,
  checkpoint_json TEXT,
  error_json TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  CHECK (error_json IS NULL OR json_valid(error_json)),
  UNIQUE(run_kind, input_hash, schema_version, model_id, prompt_spec_version)
) STRICT;
CREATE INDEX graph_extraction_pending_idx ON graph_extraction_runs(state, run_kind, started_at);

INSERT INTO graph_predicates(predicate_key, schema_version, layer, display_name, inverse_predicate_key, subject_kinds_json, object_kinds_json, symmetric, transitive, temporal, evidence_required, status) VALUES
('contains','1','structural','contains','part_of','["source","document","revision"]','["document","revision","chunk"]',0,0,0,0,'active'),
('part_of','1','structural','part of','contains','["document","revision","chunk","entity"]','["source","document","revision","entity"]',0,0,0,0,'active'),
('revision_of','1','structural','revision of',NULL,'["revision"]','["document"]',0,0,0,0,'active'),
('derived_from','1','structural','derived from',NULL,'["document","revision","chunk","claim"]','["source","document","revision","chunk","claim"]',0,0,0,0,'active'),
('links_to','1','explicit','links to',NULL,'["document"]','["document"]',0,0,0,1,'active'),
('embeds','1','explicit','embeds',NULL,'["document"]','["document"]',0,0,0,1,'active'),
('cites','1','explicit','cites',NULL,'["document","claim"]','["document","claim"]',0,0,0,1,'active'),
('references','1','explicit','references',NULL,'["document","claim"]','["document","entity","claim"]',0,0,0,1,'active'),
('mentions','1','semantic','mentions',NULL,'["document","chunk"]','["entity"]',0,0,0,1,'active'),
('about','1','semantic','about',NULL,'["document","chunk","topic"]','["entity","topic"]',0,0,0,1,'active'),
('defined_in','1','semantic','defined in',NULL,'["entity"]','["document","chunk"]',0,0,0,1,'active'),
('is_a','1','semantic','is a',NULL,'["entity"]','["entity"]',0,1,0,1,'active'),
('instance_of','1','semantic','instance of',NULL,'["entity"]','["entity"]',0,0,0,1,'active'),
('has_part','1','semantic','has part','part_of','["entity"]','["entity"]',0,0,1,1,'active'),
('member_of','1','semantic','member of',NULL,'["entity"]','["entity"]',0,0,1,1,'active'),
('uses','1','semantic','uses',NULL,'["entity"]','["entity"]',0,0,1,1,'active'),
('depends_on','1','semantic','depends on',NULL,'["entity"]','["entity"]',0,0,1,1,'active'),
('implements','1','semantic','implements',NULL,'["entity"]','["entity"]',0,0,1,1,'active'),
('compatible_with','1','semantic','compatible with',NULL,'["entity"]','["entity"]',1,0,1,1,'active'),
('created_by','1','semantic','created by',NULL,'["entity"]','["entity"]',0,0,1,1,'active'),
('owned_by','1','semantic','owned by',NULL,'["entity"]','["entity"]',0,0,1,1,'active'),
('maintained_by','1','semantic','maintained by',NULL,'["entity"]','["entity"]',0,0,1,1,'active'),
('precedes','1','semantic','precedes','follows','["entity","claim"]','["entity","claim"]',0,0,1,1,'active'),
('follows','1','semantic','follows','precedes','["entity","claim"]','["entity","claim"]',0,0,1,1,'active'),
('supersedes','1','claim','supersedes',NULL,'["entity","claim"]','["entity","claim"]',0,0,1,1,'active'),
('causes','1','semantic','causes',NULL,'["entity","claim"]','["entity","claim"]',0,0,1,1,'active'),
('contributes_to','1','semantic','contributes to',NULL,'["entity","claim"]','["entity","claim"]',0,0,1,1,'active'),
('prevents','1','semantic','prevents',NULL,'["entity","claim"]','["entity","claim"]',0,0,1,1,'active'),
('similar_to','1','semantic','similar to',NULL,'["entity","document","chunk"]','["entity","document","chunk"]',1,0,0,1,'active'),
('alternative_to','1','semantic','alternative to',NULL,'["entity"]','["entity"]',1,0,1,1,'active'),
('different_from','1','semantic','different from',NULL,'["entity","claim"]','["entity","claim"]',1,0,0,1,'active'),
('supports','1','claim','supports',NULL,'["claim"]','["claim"]',0,0,0,1,'active'),
('contradicts','1','claim','contradicts',NULL,'["claim"]','["claim"]',1,0,0,1,'active'),
('refines','1','claim','refines',NULL,'["claim"]','["claim"]',0,0,0,1,'active'),
('equivalent_to','1','claim','equivalent to',NULL,'["claim","entity"]','["claim","entity"]',1,0,0,1,'active');

CREATE INDEX graph_generation_nodes_node_idx ON graph_generation_nodes(node_id, generation_id);
CREATE INDEX graph_generation_relations_relation_idx ON graph_generation_relations(relation_id, generation_id);
CREATE INDEX graph_generation_claims_claim_idx ON graph_generation_claims(claim_id, generation_id);
CREATE INDEX graph_generations_state_started_idx ON graph_generations(state, started_at DESC);

UPDATE workspace
SET database_schema_version = 6,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 6;
