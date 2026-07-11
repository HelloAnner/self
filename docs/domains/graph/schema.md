# Graph SQLite Schema

> 本文给出逻辑 Schema 基线。正式 Migration 需要使用项目统一 ID、时间、审计列和严格表模式，并在真实 SQLite/sqlite-vec 上验证。

## 1. 表清单与所有权

| 表 | 作用 |
| --- | --- |
| `graph_generations` | 派生图谱构建和激活版本 |
| `graph_nodes` | 统一遍历节点投影 |
| `graph_entities` | Entity 业务字段 |
| `graph_entity_aliases` | 多语言别名和来源 |
| `graph_entity_redirects` | merge 后永久 ID 重定向 |
| `graph_predicates` | 受控 Predicate Registry |
| `graph_relations` | 有类型的有向关系 |
| `graph_relation_evidence` | Relation 到 Claim/Chunk 的证据 |
| `graph_claims` | 带限定和时间的主张 |
| `graph_claim_evidence` | Claim 支持、反证和上下文 |
| `graph_claim_relations` | Claim 之间的关系/冲突 |
| `graph_conflict_sets` / `graph_conflict_members` | 冲突聚合、成员和解决记录 |
| `graph_unresolved_references` | 未解析显式文档链接 |
| `graph_semantic_neighbors` | 绑定 VectorSpace 的 Top-K 相似投影 |
| `graph_extraction_runs` | 抽取批次、算法、模型和状态 |

这些表都由 Graph 领域唯一写入。Knowledge/Topic 对象只通过稳定 ID 投影，不允许 Graph 修改其权威表。

## 2. `graph_generations`

```sql
CREATE TABLE graph_generations (
  generation_id          TEXT PRIMARY KEY,
  generation_kind        TEXT NOT NULL,
  state                   TEXT NOT NULL,
  parent_generation_id   TEXT,
  input_watermark         TEXT NOT NULL,
  predicate_version      TEXT NOT NULL,
  extractor_version      TEXT NOT NULL,
  model_route_snapshot   TEXT NOT NULL,
  config_hash            TEXT NOT NULL,
  started_at             TEXT NOT NULL,
  completed_at           TEXT,
  activated_at           TEXT,
  failure_json           TEXT,
  CHECK (state IN ('queued','building','verifying','ready','active','failed','superseded'))
) STRICT;
```

Workspace 的 Active Graph Generation 指针单独保存。人工对象和显式链接可以跨 Generation 复用；模型派生记录必须携带 Generation。

## 3. `graph_nodes`

```sql
CREATE TABLE graph_nodes (
  node_id                 TEXT PRIMARY KEY,
  node_kind               TEXT NOT NULL,
  external_ref_id         TEXT,
  canonical_label         TEXT NOT NULL,
  normalized_label        TEXT NOT NULL,
  status                  TEXT NOT NULL,
  generation_id           TEXT,
  source_kind             TEXT NOT NULL,
  properties_json         TEXT NOT NULL DEFAULT '{}',
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  FOREIGN KEY (generation_id) REFERENCES graph_generations(generation_id),
  CHECK (node_kind IN ('source','document','revision','chunk','entity','claim','topic')),
  CHECK (status IN ('proposed','active','stale','redirected','rejected','deleted')),
  CHECK (json_valid(properties_json))
) STRICT;

CREATE UNIQUE INDEX graph_nodes_external_ref_uq
  ON graph_nodes(node_kind, external_ref_id)
  WHERE external_ref_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX graph_nodes_kind_status_idx
  ON graph_nodes(node_kind, status, updated_at DESC);

CREATE INDEX graph_nodes_label_idx
  ON graph_nodes(normalized_label, node_kind);
```

正文、完整 Page IR 和大属性不能塞入 `properties_json`。需要过滤、排序或约束的字段必须升格为正式列或专表。

## 4. Entity、Alias 与 Redirect

```sql
CREATE TABLE graph_entities (
  entity_id               TEXT PRIMARY KEY,
  node_id                 TEXT NOT NULL UNIQUE,
  entity_type             TEXT NOT NULL,
  canonical_name          TEXT NOT NULL,
  normalized_name         TEXT NOT NULL,
  description             TEXT,
  identity_key            TEXT,
  status                  TEXT NOT NULL,
  user_confirmed          INTEGER NOT NULL DEFAULT 0,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  FOREIGN KEY (node_id) REFERENCES graph_nodes(node_id),
  CHECK (user_confirmed IN (0,1)),
  CHECK (status IN ('proposed','active','needs_review','redirected','rejected','deleted'))
) STRICT;

CREATE UNIQUE INDEX graph_entities_identity_uq
  ON graph_entities(entity_type, identity_key)
  WHERE identity_key IS NOT NULL AND status <> 'deleted';

CREATE INDEX graph_entities_name_type_idx
  ON graph_entities(normalized_name, entity_type, status);

CREATE TABLE graph_entity_aliases (
  alias_id                TEXT PRIMARY KEY,
  entity_id               TEXT NOT NULL,
  alias                   TEXT NOT NULL,
  normalized_alias        TEXT NOT NULL,
  language                TEXT,
  scope                   TEXT,
  evidence_chunk_id       TEXT,
  origin                  TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES graph_entities(entity_id),
  UNIQUE(entity_id, normalized_alias, language, scope)
) STRICT;

CREATE INDEX graph_alias_lookup_idx
  ON graph_entity_aliases(normalized_alias, language);

CREATE TABLE graph_entity_redirects (
  source_entity_id        TEXT PRIMARY KEY,
  target_entity_id        TEXT NOT NULL,
  operation_id            TEXT NOT NULL,
  reason                  TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  CHECK (source_entity_id <> target_entity_id)
) STRICT;
```

Redirect 查询必须检测环；Merge 事务禁止产生 target → source 或更长环路。

## 5. `graph_predicates`

```sql
CREATE TABLE graph_predicates (
  predicate_key           TEXT PRIMARY KEY,
  schema_version          TEXT NOT NULL,
  layer                   TEXT NOT NULL,
  display_name            TEXT NOT NULL,
  inverse_predicate_key   TEXT,
  subject_kinds_json      TEXT NOT NULL,
  object_kinds_json       TEXT NOT NULL,
  symmetric               INTEGER NOT NULL DEFAULT 0,
  transitive              INTEGER NOT NULL DEFAULT 0,
  temporal                INTEGER NOT NULL DEFAULT 0,
  evidence_required       INTEGER NOT NULL DEFAULT 1,
  status                  TEXT NOT NULL,
  replacement_key         TEXT,
  CHECK (json_valid(subject_kinds_json)),
  CHECK (json_valid(object_kinds_json)),
  CHECK (symmetric IN (0,1)),
  CHECK (transitive IN (0,1)),
  CHECK (temporal IN (0,1)),
  CHECK (evidence_required IN (0,1))
) STRICT;
```

内置 Predicate 由 Migration Seed 管理。修改方向、对称性或 Domain/Range 属于 Graph Schema 变更，不能只改 Prompt。

## 6. `graph_relations`

```sql
CREATE TABLE graph_relations (
  relation_id             TEXT PRIMARY KEY,
  subject_node_id         TEXT NOT NULL,
  predicate_key           TEXT NOT NULL,
  object_node_id          TEXT NOT NULL,
  qualifier_hash          TEXT NOT NULL,
  qualifiers_json         TEXT NOT NULL DEFAULT '{}',
  valid_from              TEXT,
  valid_to                TEXT,
  observed_at             TEXT,
  origin                  TEXT NOT NULL,
  status                  TEXT NOT NULL,
  confidence_level        TEXT NOT NULL,
  confidence_json         TEXT NOT NULL,
  claim_id                TEXT,
  generation_id           TEXT,
  extraction_run_id       TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  FOREIGN KEY (subject_node_id) REFERENCES graph_nodes(node_id),
  FOREIGN KEY (object_node_id) REFERENCES graph_nodes(node_id),
  FOREIGN KEY (predicate_key) REFERENCES graph_predicates(predicate_key),
  FOREIGN KEY (generation_id) REFERENCES graph_generations(generation_id),
  CHECK (subject_node_id <> object_node_id OR predicate_key IN ('equivalent_to','similar_to')),
  CHECK (json_valid(qualifiers_json)),
  CHECK (json_valid(confidence_json)),
  CHECK (status IN ('proposed','accepted','needs_review','stale','rejected','deprecated','deleted'))
) STRICT;

CREATE UNIQUE INDEX graph_relation_identity_uq
  ON graph_relations(subject_node_id, predicate_key, object_node_id, qualifier_hash, origin)
  WHERE deleted_at IS NULL;

CREATE INDEX graph_relation_out_idx
  ON graph_relations(subject_node_id, predicate_key, status, object_node_id);

CREATE INDEX graph_relation_in_idx
  ON graph_relations(object_node_id, predicate_key, status, subject_node_id);

CREATE INDEX graph_relation_claim_idx
  ON graph_relations(claim_id) WHERE claim_id IS NOT NULL;
```

邻居查询必须命中 out/in 索引。对称边在写入前 canonicalize；逆边查询由 Predicate Registry 展开。

## 7. Relation Evidence

```sql
CREATE TABLE graph_relation_evidence (
  relation_id             TEXT NOT NULL,
  evidence_id             TEXT NOT NULL,
  evidence_kind           TEXT NOT NULL,
  chunk_id                TEXT,
  claim_id                TEXT,
  revision_id             TEXT,
  role                    TEXT NOT NULL,
  directness              TEXT NOT NULL,
  locator_json            TEXT NOT NULL,
  excerpt_hash            TEXT,
  state                   TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  PRIMARY KEY (relation_id, evidence_id),
  FOREIGN KEY (relation_id) REFERENCES graph_relations(relation_id),
  CHECK (chunk_id IS NOT NULL OR claim_id IS NOT NULL),
  CHECK (json_valid(locator_json)),
  CHECK (role IN ('support','contradict','context','definition'))
) STRICT;

CREATE INDEX graph_relation_evidence_chunk_idx
  ON graph_relation_evidence(chunk_id, state);
```

`chunk_id`、`revision_id` 属于跨领域稳定引用，由 `self verify` 检查存在性和历史保留，不由 Graph 外键级联删除。

## 8. Claim 表

```sql
CREATE TABLE graph_claims (
  claim_id                TEXT PRIMARY KEY,
  node_id                 TEXT NOT NULL UNIQUE,
  subject_node_id         TEXT,
  predicate_key           TEXT,
  object_node_id          TEXT,
  value_json              TEXT,
  qualifier_hash          TEXT NOT NULL,
  qualifiers_json         TEXT NOT NULL,
  normalized_statement    TEXT NOT NULL,
  valid_from              TEXT,
  valid_to                TEXT,
  epistemic_status        TEXT NOT NULL,
  status                  TEXT NOT NULL,
  confidence_level        TEXT NOT NULL,
  confidence_json         TEXT NOT NULL,
  origin                  TEXT NOT NULL,
  generation_id           TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  deleted_at              TEXT,
  FOREIGN KEY (node_id) REFERENCES graph_nodes(node_id),
  CHECK (object_node_id IS NOT NULL OR value_json IS NOT NULL),
  CHECK (json_valid(qualifiers_json)),
  CHECK (json_valid(confidence_json)),
  CHECK (value_json IS NULL OR json_valid(value_json)),
  CHECK (status IN ('proposed','accepted','user_confirmed','disputed','stale','superseded','rejected','deleted'))
) STRICT;

CREATE INDEX graph_claim_subject_idx
  ON graph_claims(subject_node_id, predicate_key, status);

CREATE INDEX graph_claim_statement_idx
  ON graph_claims(normalized_statement, status);

CREATE TABLE graph_claim_evidence (
  claim_id                TEXT NOT NULL,
  evidence_id             TEXT NOT NULL,
  chunk_id                TEXT NOT NULL,
  revision_id             TEXT NOT NULL,
  role                    TEXT NOT NULL,
  directness              TEXT NOT NULL,
  source_lineage_key      TEXT,
  locator_json            TEXT NOT NULL,
  excerpt_hash            TEXT NOT NULL,
  state                   TEXT NOT NULL,
  extraction_run_id       TEXT,
  created_at              TEXT NOT NULL,
  PRIMARY KEY (claim_id, evidence_id),
  FOREIGN KEY (claim_id) REFERENCES graph_claims(claim_id),
  CHECK (json_valid(locator_json))
) STRICT;

CREATE INDEX graph_claim_evidence_chunk_idx
  ON graph_claim_evidence(chunk_id, state, claim_id);

CREATE TABLE graph_claim_relations (
  source_claim_id         TEXT NOT NULL,
  relation_type           TEXT NOT NULL,
  target_claim_id         TEXT NOT NULL,
  confidence_json         TEXT NOT NULL,
  status                  TEXT NOT NULL,
  generation_id           TEXT,
  created_at              TEXT NOT NULL,
  PRIMARY KEY (source_claim_id, relation_type, target_claim_id),
  CHECK (source_claim_id <> target_claim_id),
  CHECK (relation_type IN ('supports','contradicts','refines','supersedes','equivalent_to','derived_from')),
  CHECK (json_valid(confidence_json))
) STRICT;

CREATE INDEX graph_claim_relation_target_idx
  ON graph_claim_relations(target_claim_id, relation_type, status);
```

## 9. Conflict Set

```sql
CREATE TABLE graph_conflict_sets (
  conflict_id             TEXT PRIMARY KEY,
  conflict_key            TEXT NOT NULL UNIQUE,
  subject_node_id         TEXT,
  predicate_key           TEXT,
  qualifier_scope_hash    TEXT NOT NULL,
  status                  TEXT NOT NULL,
  summary                 TEXT,
  resolution_json         TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK (status IN ('proposed','confirmed','partially_resolved','resolved','stale','deleted')),
  CHECK (resolution_json IS NULL OR json_valid(resolution_json))
) STRICT;

CREATE TABLE graph_conflict_members (
  conflict_id             TEXT NOT NULL,
  claim_id                TEXT NOT NULL,
  position_key            TEXT NOT NULL,
  role                    TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  PRIMARY KEY (conflict_id, claim_id),
  FOREIGN KEY (conflict_id) REFERENCES graph_conflict_sets(conflict_id),
  FOREIGN KEY (claim_id) REFERENCES graph_claims(claim_id)
) STRICT;

CREATE INDEX graph_conflict_member_claim_idx
  ON graph_conflict_members(claim_id, conflict_id);
```

`resolved` 表示已经记录适用范围或用户判断，不代表删除失败一方。Resolution 必须引用保留的 Claim/Evidence。

## 10. 未解析链接

```sql
CREATE TABLE graph_unresolved_references (
  reference_id            TEXT PRIMARY KEY,
  source_revision_id      TEXT NOT NULL,
  source_chunk_id         TEXT,
  reference_kind          TEXT NOT NULL,
  raw_target              TEXT NOT NULL,
  normalized_target       TEXT NOT NULL,
  locator_json            TEXT NOT NULL,
  resolution_state        TEXT NOT NULL,
  candidate_ids_json      TEXT NOT NULL DEFAULT '[]',
  resolved_node_id        TEXT,
  last_attempt_at         TEXT,
  created_at              TEXT NOT NULL,
  CHECK (json_valid(locator_json)),
  CHECK (json_valid(candidate_ids_json)),
  CHECK (resolution_state IN ('pending','ambiguous','resolved','missing','stale'))
) STRICT;

CREATE INDEX graph_unresolved_target_idx
  ON graph_unresolved_references(normalized_target, resolution_state);
```

## 11. Semantic Neighbor

```sql
CREATE TABLE graph_semantic_neighbors (
  vector_space_id         TEXT NOT NULL,
  source_node_id          TEXT NOT NULL,
  target_node_id          TEXT NOT NULL,
  source_content_hash     TEXT NOT NULL,
  target_content_hash     TEXT NOT NULL,
  score                   REAL NOT NULL,
  rank                    INTEGER NOT NULL,
  scope_key               TEXT NOT NULL,
  algorithm_version       TEXT NOT NULL,
  computed_at             TEXT NOT NULL,
  stale_at                TEXT,
  PRIMARY KEY (vector_space_id, source_node_id, target_node_id, scope_key),
  CHECK (rank > 0),
  CHECK (source_node_id <> target_node_id)
) STRICT;

CREATE INDEX graph_semantic_neighbor_lookup_idx
  ON graph_semantic_neighbors(vector_space_id, source_node_id, scope_key, rank)
  WHERE stale_at IS NULL;
```

每个 source/scope 的行数必须有硬上限。VectorSpace 变化或内容 Hash 变化时，旧记录整体 stale；不能跨空间复用 score。

## 12. Extraction Run

```sql
CREATE TABLE graph_extraction_runs (
  extraction_run_id       TEXT PRIMARY KEY,
  generation_id           TEXT NOT NULL,
  run_kind                TEXT NOT NULL,
  state                   TEXT NOT NULL,
  input_revision_id       TEXT,
  input_chunk_id          TEXT,
  model_id                TEXT,
  prompt_spec_version     TEXT,
  schema_version          TEXT NOT NULL,
  input_hash              TEXT NOT NULL,
  output_hash             TEXT,
  checkpoint_json         TEXT,
  error_json              TEXT,
  started_at              TEXT NOT NULL,
  completed_at            TEXT,
  UNIQUE(run_kind, input_hash, schema_version, model_id, prompt_spec_version),
  CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json))
) STRICT;

CREATE INDEX graph_extraction_pending_idx
  ON graph_extraction_runs(state, run_kind, started_at);
```

## 13. 有界遍历

所有路径查询必须同时限制：

- `max_depth`
- `max_nodes`
- `max_edges`
- Predicate allowlist
- 节点/关系状态
- Topic/Source/时间等 Scope

Recursive CTE 维护 visited path 防环。默认深度 2，交互硬上限建议 4；更深分析进入后台 Job。

## 14. 事务与版本

- 单 Chunk 抽取结果在短事务中发布 Node/Entity/Claim/Relation/Evidence。
- Graph 不在模型调用期间保持事务。
- Generation 激活只更新指针和状态，不搬迁全图。
- Entity merge/split、Relation/Claim 修改使用乐观版本和 Plan/Apply。
- Evidence 失效与 Relation/Claim stale 在同一应用工作流提交。
- Schema Migration 由 Operations 管理；Graph Rebuild 不是数据库 Migration。

## 15. 验证查询

`self graph verify` 至少检查：

- Relation subject/object 和 Predicate 存在。
- 事实 Relation/Claim 满足 Evidence 要求。
- Evidence 引用的 Chunk/Revision 存在或被历史保留。
- Redirect 无环且最终指向 active Entity。
- 对称 Relation 已 canonicalize。
- `qualifier_hash` 与 JSON 一致。
- SemanticNeighbor 空间、内容 Hash、Top-K 和 Rank 合法。
- Active Generation 完整，无 failed/partial 未解释记录。
- ClaimRelation 不产生非法自环或方向重复。
