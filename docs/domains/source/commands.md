# Source CLI Contract

> 状态：Phase 3 updated

## 命令

```text
self source add <input> [--kind <kind>] [--name <name>] [--mode <mode>]
  [--recursive] [--include <glob>...] [--exclude <glob>...] [--no-build] [--json]
self source list [--status active|failed|deleted] [--json]
self source show <source-id> [--json]
self source status <source-id> [--json]
self source files <source-id> [--snapshot <snapshot-id>] [--json]
self source sync [source-id] [--all] [--changed-only] [--json]
self source retry <source-id> [--json]
self source delete <source-id> --plan [--json]
self source restore <source-id> [--json]
```

stdin 使用 `<input> = -`，必须给出 `--kind text|jsonl` 与 `--name`。Web 仅允许 `http:`/`https:`；Phase 2 不实现 crawl。`--include/--exclude` 使用 Workspace 统一的 `/` 分隔逻辑路径匹配。

默认成功返回 `source_id`、`snapshot_id`、`ingestion_run_id`、`archive_status=published`、`ingestion_status=ready`、Document/Chunk 统计和 Operation ID。`--no-build` 明确只归档并返回 `ingestion_status=not_started`。

## 稳定错误

| 错误码 | 含义 |
| --- | --- |
| `source_input_invalid` | 输入、kind、mode 或 Glob 非法 |
| `source_not_found` | Source ID 不存在 |
| `source_deleted` | 当前操作不允许 deleted Source |
| `source_not_syncable` | stdin 等来源无法重新读取 |
| `source_unavailable` | 外部 Target 不可访问；旧证据保留 |
| `source_archive_failed` | Hash、复制、Fetch 或发布失败 |
| `source_blob_corrupt` | 已存在 Blob 与其路径 Hash 不一致 |
| `source_plan_required` | Delete 缺少 `--plan` |
| `source_plan_conflict` | Source 在 Plan 后已变化 |
| `ingestion_parse_failed` | 归档成功，但受支持内容无法确定性解析 |

`source delete` 仅生成 Plan；物理 `purge`、下游影响传播和 Undo 在 Phase 9 后实现。
