# SQLite 迁移基线

> 状态：Phase 10 Schema 11 与副本迁移、原子替换、失败回滚已实现

## 契约

生产运行时只执行仓库内经过审查的 `drizzle/*.sql`，不会运行 `drizzle-kit push`。每个迁移按版本、名称和 SHA-256 校验和写入 `schema_migrations`，已应用迁移的校验和不匹配时立即停止。

每个数据库连接启用外键、`busy_timeout` 和受控 WAL。初始化在 `runtime/tmp/` 创建临时数据库，应用迁移、插入 Workspace 基线、执行 `PRAGMA integrity_check` 和 checkpoint 后，才原子发布为 `data/self.sqlite3`。

## 版本 1

`0001_workspace.sql` 创建：

- `schema_migrations`
- `workspace`
- `workspace_config_versions`
- `workspace_capabilities`
- `setup_sessions`
- `operations` 与非空幂等键唯一索引

## 版本 2

`0002_source.sql` 创建 Source、Blob、Snapshot、SnapshotEntry、Diff 和 ChangeBatch Receipt 表及索引。它只新增 Source 领域结构，并把 Workspace 数据库格式更新到 2。

`0003_connection.sql` 创建 Connection、Target、ScanRun、Observation、ChangeBatch/Item、EventHint、WriteReceipt、Failure 和 DaemonLease 表及索引，并把 Workspace 数据库格式更新到 3。Schema 2 → 3 同样只能通过显式 Migration Plan/Apply，迁移前备份保存在当前 Root。

`0004_ingestion_knowledge.sql` 创建 IngestionRun/entry result、Document、Revision、Chunk、Revision 映射、Run 映射、lineage 和 Note 表，将数据库格式更新到 4。Schema 3 → 4 的真实 Plan/Apply、备份与迁移后 Ingestion 已通过 Phase 3 Gate。

`0005_search_vectors.sql` 创建 Model Provider/Registry/Invocation、FTS Generation、VectorSpace/Build/Embedding、active pointers、Query Cache 和评测表，并发布 trigram FTS5 虚表，将数据库格式更新到 5。不同维度 vec0 表在受校验的 VectorSpace create 时按需创建；Schema 4 → 5 的真实 Plan/Apply、Root-local backup、FTS/vec 查询和迁移后重建由 Phase 4 Gate 验证。

`0006_graph_claims.sql` 创建 GraphGeneration/active pointer、GraphNode/Generation membership、Predicate Registry、Entity/Alias/Redirect、Relation/Claim/Evidence、ClaimRelation/Conflict、UnresolvedReference、SemanticNeighbor 和 ExtractionRun，并将格式更新到 6。Schema 5 → 6 的空库、真实旧格式 Plan/Apply、Root-local backup、完整性和 Graph 查询由 Phase 5 Gate 验证。

`0007_evidence_answers.sql` 创建 RetrievalRun/Candidate、EvidenceContext/Item、Answer/Statement/Citation 与失效/引用索引，并将格式更新到 7。Schema 6 → 7 的真实 Plan/Apply、Root-local backup、Context 重放、Citation 外键和迁移后 Ask 由 Phase 6 Gate 验证。

`0008_topic_synthesis.sql` 创建 Topic/Scope/Alias、SynthesisRun、不可变 TopicSnapshot、Section/Conclusion/Citation、Claim 投影和 KnowledgeGap，并将格式更新到 8。Schema 7 → 8 的真实 Plan/Apply、历史读取、引用完整性和迁移后 Topic Build 由 Phase 7 Gate 验证。

`0009_artifact_builds.sql` 创建 Template/Theme、Artifact、不可变 Build、Dependency/Component/File/Export 和 latest 指针，并将格式更新到 9。Schema 8 → 9 的真实 Plan/Apply、Build 不可变性、离线 HTML 和 Root 整体移动由 Phase 8 Gate 验证。

`0010_safe_operations.sql` 扩展 Operation，并创建不可变 Plan/Target、IdempotencyRecord、OperationChange、AuditEvent 和 SourcePurgeReceipt，将格式更新到 10。Schema 9 → 10 的真实 Plan/Apply、陈旧 Plan 拒绝、软删除/精确恢复、Undo、不可逆 Purge 和审计不可变性由 Phase 9 Gate 验证。

`0011_operations_jobs.sql` 创建 Job/JobEvent、Backup/BackupFile、VerificationRun/Issue、GcReceipt/Item 和 MaintenanceLease，将格式更新到 11。Schema 10 → 11 Gate 在迁移副本原子替换前注入失败，验证源数据库 Hash 不变；随后重试同一 Plan 成功。Job/Event、Plan 和审计历史继续由 SQLite 统一承载。

已有 Schema 1 Workspace 必须显式执行：

```text
self --root <ROOT> migration plan --json
self --root <ROOT> apply <plan-id> --json
```

Plan 固定来源数据库 Hash、起止版本和过期时间。Apply 使用 SQLite 一致性序列化结果在 `runtime/migrations/backups/` 保存来源 Schema 备份，在 `runtime/tmp/` 迁移副本并通过 Integrity Check 后，才原子发布新的 `data/self.sqlite3`。Plan 后数据库变化会返回 `plan_conflict`。

## 兼容与失败

- 数据库版本等于当前版本：允许正常读写。
- 数据库版本较低：状态为 `needs_migration`，普通写命令返回 `workspace_migration_required`。
- 数据库版本较高：状态为 `read_only`，普通写命令返回 `workspace_format_too_new`。
- Init 中断：不发布 `self.toml`；Journal 支持 Resume，清理由显式 Rollback Plan 执行。

普通命令不会隐式升级数据库。当前显式迁移服务已验证 1→11 的阶段链。Phase 10 Apply 使用当前数据库的一致性序列化副本，在 Root-local 临时目录完成全部待应用 Migration、迁移历史校验、`integrity_check`、外键检查和 checkpoint，随后才原子替换源数据库；替换前任何失败都会删除临时副本并保留源数据库。Workspace Backup 是独立的用户可恢复产物，不能与内部迁移备份混淆。
