# Source SQLite Schema

> 状态：Schema 2 基表 implemented；Schema 4 增加 Ingestion 状态投影

## 表所有权

| 表 | 用途 | 核心约束 |
| --- | --- | --- |
| `sources` | Source 聚合和规范 SourceSpec | public ID PK；identity key unique；current Snapshot pointer transactionally validated |
| `source_blobs` | 内容寻址原始字节元数据 | SHA-256 PK；Root 相对路径 unique |
| `source_snapshots` | 不可变 Snapshot 版本 | public ID PK；`(source_id, sequence)` unique |
| `source_snapshot_entries` | Snapshot 文件/网页条目 | `(snapshot_id, logical_path)` PK；Blob FK |
| `source_snapshot_changes` | 与前一 Snapshot 的 Diff | `(snapshot_id, logical_path)` PK；added/modified/deleted |
| `source_batch_receipts` | Connection ChangeBatch 幂等接纳回执 | change batch ID unique；Snapshot FK |

`sources.current_snapshot_id` 只在 Snapshot、entries、changes 和 Manifest 均已准备后于同一事务切换。Snapshot 行不执行 Update；Source 生命周期、当前指针和最近错误允许受版本约束地更新。

## Root 文件布局

```text
content/sources/
├── blobs/sha256/<first-two>/<full-sha256>
├── snapshots/<source-id>/<sequence>.json
└── imports/<source-id>/...
```

数据库只保存 Root 相对路径。外部 locator 属于显式授权的 SourceSpec，不用于定位内部证据。Blob 使用原子写入、只读式内容校验和按 Hash 去重；Manifest 为规范排序 JSON。

## Migration 2

`0002_source.sql` 只新增 Source 自有表和索引，并设置 `PRAGMA user_version = 2`。已有格式 1 实例必须通过显式 Migration Plan/Apply；普通 Source 命令在 `needs_migration` 状态拒绝写入。

Schema 4 为 `sources` 增加 `ingestion_status` 和 `current_ingestion_run_id`，字段仍是 Ingestion 事件在 Source 聚合上的只读进度投影，不把 Revision/Chunk 所有权转给 Source。
