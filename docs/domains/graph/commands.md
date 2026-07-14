# Graph CLI 契约

> 实现状态：Phase 10 已在既有查询/构建/导出、Trace 与安全生命周期之上接入 durable Job；`--detach` 返回 Job，`--wait` 等待完成。split、复杂 update、Conflict resolve 和 Predicate 写入仍属后续范围。

## 1. 查询

```bash
self graph status
self graph show --topic topic:top_123
self graph neighbors entity:ent_123 --depth 1
self graph neighbors document:doc_123 --predicate links_to --depth 2
self graph path entity:ent_123 entity:ent_456 --max-depth 4
self graph subgraph --seed entity:ent_123 --nodes 100 --edges 300
self graph search '上下文隔离'
self graph explain relation:rel_123
self graph trace claim:clm_123
```

所有遍历命令必须有默认和硬上限。JSON 输出包含 `generation_id`、nodes、edges、truncated、cursor 和 trace；裁剪不能静默发生。

## 2. 文档关联

```bash
self graph links document:doc_123
self graph backlinks document:doc_123
self graph unresolved list --status ambiguous
self graph unresolved show reference:gref_123
self graph unresolved resolve reference:gref_123 document:doc_456 --plan
self graph unresolved retry --all
```

Resolve 修改 Graph 投影，不自动修改外部 Markdown。需要回写链接时使用 Note/Source 的独立安全修改 Plan。

## 3. Entity

```bash
self entity show entity:ent_123
self entity aliases entity:ent_123
self entity mentions entity:ent_123
self entity candidates --name 'Self'
self entity create --type project --name 'Self' --user-asserted --plan
self entity update entity:ent_123 --set description='...' --plan
self entity merge entity:ent_123 entity:ent_456 --plan
self entity split entity:ent_123 --spec split.json --plan
self entity confirm entity:ent_123 [--if-version 1] [--idempotency-key key]
self entity reject entity:ent_123 --reason '错误消歧' [--if-version 1]
self entity delete entity:ent_123 --plan [--idempotency-key key]
self entity restore entity:ent_123 [--if-version 2]
```

Merge/Split Plan 必须列出 Alias、Mention、Relation、Claim、Topic、Artifact 和 Redirect 影响。

## 4. Relation

```bash
self relation show relation:rel_123
self relation evidence relation:rel_123
self relation create entity:ent_123 depends_on entity:ent_456 \
  --evidence chunk:chk_123 --plan
self relation confirm relation:rel_123
self relation reject relation:rel_123 --reason '证据不支持'
self relation update relation:rel_123 --set valid_to=2026-07-11 --plan
self relation delete relation:rel_123 --plan
self relation restore relation:rel_123
```

Predicate、Domain/Range、时间和 Evidence 在创建 Plan 时校验。不存在的 Predicate 返回 `unknown_predicate`，不由 CLI 临时创建。

## 5. Claim 和冲突

```bash
self claim show claim:clm_123
self claim evidence claim:clm_123
self claim relations claim:clm_123
self claim conflicts claim:clm_123
self claim confirm claim:clm_123
self claim reject claim:clm_123 --reason '来源已经过期'
self claim update claim:clm_123 --set valid_to=2026-12-31 --plan
self claim delete claim:clm_123 --plan
self claim restore claim:clm_123

self conflict show conflict:cfs_123
self conflict resolve conflict:cfs_123 --resolution resolution.json --plan
```

解决冲突不删除失败一方；它记录适用范围、用户判断和证据，旧状态仍在历史中。

## 6. Predicate Registry

```bash
self graph predicate list
self graph predicate show depends_on
self graph predicate validate ./predicate.json
self graph predicate add ./predicate.json --plan
self graph predicate deprecate old_key --replacement new_key --plan
```

增加/改变 Predicate 属于 Graph Schema 操作，需要 Migration/兼容评估，不能由普通模型抽取自动执行。

## 7. 构建、重建和验证

```bash
self graph build --changed-only --detach
self graph rebuild --layer structure --detach
self graph rebuild --layer links --detach
self graph rebuild --layer mentions --detach
self graph rebuild --layer relations --detach
self graph rebuild --layer claims --detach
self graph rebuild --layer neighbors --vector-space vector-space:vsp_123 --detach
self graph rebuild --layer all --plan
self graph diff generation:ggen_123 generation:ggen_456
self graph activate generation:ggen_456 --plan
self graph verify
self graph verify --deep
```

`rebuild --layer all` 创建 shadow Generation，不清空 Active Graph。耗时操作快速返回 Job；activate 和旧 Generation 清理使用 Plan/Apply。

## 8. 导出

```bash
self graph export --format json --topic topic:top_123 --output ./exports/topic.json
self graph export --format jsonld --scope workspace --output ./exports/graph.jsonld
self graph export --format graphml --topic topic:top_123 --output ./exports/topic.graphml
```

导出路径可位于用户显式指定位置，但导出不是数据库备份。默认导出 active、非 deleted 对象，并可选择是否包含 proposed/stale 和 Evidence locator。

## 9. 稳定错误码

| 错误码 | 含义 |
| --- | --- |
| `graph_node_not_found` | 节点或外部引用不存在 |
| `unknown_predicate` | Predicate Registry 无该键 |
| `predicate_domain_mismatch` | subject/object 类型不合法 |
| `evidence_required` | 事实关系缺少 Evidence |
| `entity_merge_conflict` | Merge 存在版本、类型或 Redirect 冲突 |
| `entity_redirect_cycle` | 操作会产生 Redirect 环 |
| `reference_ambiguous` | 显式链接存在多个候选 |
| `graph_traversal_limit` | 请求超过硬遍历边界 |
| `graph_generation_incomplete` | Generation 未通过激活门禁 |
| `graph_version_conflict` | Plan 后对象已变化 |

## 10. Agent 协议

- 所有对象使用稳定完整 ID。
- 写请求支持 `--idempotency-key` 和 `--if-version`。
- 高影响修改返回 Plan；`self apply` 才产生效果。
- `--jsonl` 用于大型 Subgraph、Rebuild 进度和 Export。
- stdout 只输出结果，模型/解析进度写 stderr。

Phase 5 的 `graph subgraph` 同时返回 `nodes`、`edges` 与 Cytoscape `elements`；`graph export --scope workspace` 不使用局部子图上限，导出 Active Generation 的完整成员，并明确写入用户指定路径。

Phase 9 的 delete 只软删除稳定对象和对应 GraphNode，保留 Generation、Evidence、Redirect、Claim/Relation 历史；Plan 精确列出受影响 Relation、Claim、Topic 和 Artifact。Restore 从 OperationChange 恢复相同 ID 的 before 状态并递增版本。Confirm/Reject 以一个事务写入对象状态、Answer/Topic/Artifact 失效和不可变审计；相同幂等键不会重复递增版本。
