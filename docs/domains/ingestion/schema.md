# Ingestion SQLite Schema

> 状态：Database Schema 4 implemented；Migration 为 `drizzle/0004_ingestion_knowledge.sql`。

| 表 | 所有权与用途 |
| --- | --- |
| `ingestion_runs` | Run 状态、版本、fingerprint、checkpoint、计数和错误 |
| `ingestion_entry_results` | Snapshot entry 的 parsed/skipped/failed 结果 |

`ingestion_runs.idempotency_key` 唯一；Run 状态和 Source 的 `ingestion_status/current_ingestion_run_id` 在短事务中同步。`ingestion_entry_results` 只保存规范结果 Hash 和统计，不复制正文。正文由不可变 Knowledge Revision 持有。

Schema 4 为 `sources` 增加：

- `ingestion_status = not_started|queued|running|ready|failed`
- `current_ingestion_run_id`

Source 归档新 Snapshot 时先重置为 `not_started`；无变化 Snapshot 保留当前 ready 投影。Schema 3 → 4 必须通过 Migration Plan/Apply 并在 Root 内生成一致性备份。
