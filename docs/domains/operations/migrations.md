# SQLite 迁移基线

> 状态：Phase 3 schema 4 与显式 Migration Plan/Apply 已实现

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

已有 Schema 1 Workspace 必须显式执行：

```text
self --root <ROOT> migration plan --json
self --root <ROOT> apply <plan-id> --json
```

Plan 固定来源数据库 Hash、起止版本和过期时间。Apply 使用 SQLite 一致性序列化结果在 `runtime/migrations/backups/` 保存 Schema 1 备份，在 `runtime/tmp/` 迁移副本并通过 Integrity Check 后，才原子发布新的 `data/self.sqlite3`。Plan 后数据库变化会返回 `plan_conflict`。

## 兼容与失败

- 数据库版本等于当前版本：允许正常读写。
- 数据库版本较低：状态为 `needs_migration`，普通写命令返回 `workspace_migration_required`。
- 数据库版本较高：状态为 `read_only`，普通写命令返回 `workspace_format_too_new`。
- Init 中断：不发布 `self.toml`；Journal 支持 Resume，清理由显式 Rollback Plan 执行。

普通命令不会隐式升级数据库。当前显式迁移服务相邻开发格式；通用 Migration 编排、跨平台原子替换、备份策略和完整崩溃恢复矩阵在 Phase 10 完成。
