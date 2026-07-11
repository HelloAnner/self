# Connection SQLite Schema

> 所有表位于唯一的 `data/self.sqlite3`。Connection 领域拥有下列表的写入规则，其他领域只能通过公开 Repository 或 Read Model 访问。
>
> Phase 2.5 由 `drizzle/0003_connection.sql` 落地为数据库 Schema 3。下列 SQL 使用已发布的完整资源列名，后续字段只能通过显式 Migration 增加。

## 1. 表清单

| 表 | 用途 |
| --- | --- |
| `data_connections` | 持久化需要监控的连接及策略 |
| `connection_targets` | 具体文件或目录目标 |
| `connection_scan_runs` | 每次扫描和对账运行 |
| `connection_observations` | 最近已知外部文件清单 |
| `connection_change_batches` | 一次可靠变化批次 |
| `connection_change_items` | 批次中的文件级变化 |
| `connection_event_hints` | 原生 watcher 的短期提示队列 |
| `connection_write_receipts` | Self 对 managed content 的预期内部写入回执 |
| `connection_failures` | 可重试和需干预错误 |
| `connection_daemon_leases` | 后台进程 Leader 租约 |

公共 Operation、Job 和 Audit 表仍由 Automation 领域拥有，不在 Connection 中复制。

## 2. `data_connections`

```sql
CREATE TABLE data_connections (
  connection_id         TEXT PRIMARY KEY,
  workspace_id          TEXT NOT NULL,
  source_id             TEXT NOT NULL,
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN (
                          'file', 'directory', 'project', 'obsidian'
                        )),
  state                 TEXT NOT NULL CHECK (state IN (
                          'draft', 'initializing', 'active', 'paused',
                          'degraded', 'error', 'detached', 'deleted'
                        )),
  watch_mode            TEXT NOT NULL CHECK (watch_mode IN (
                          'poll', 'native', 'watch_and_reconcile'
                        )),
  scan_policy_json      TEXT NOT NULL,
  filter_policy_json    TEXT NOT NULL,
  resource_policy_json  TEXT NOT NULL,
  config_version        INTEGER NOT NULL DEFAULT 1 CHECK (config_version > 0),
  reconcile_required    INTEGER NOT NULL DEFAULT 1 CHECK (reconcile_required IN (0, 1)),
  revision              INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_scan_at          TEXT,
  last_success_at       TEXT,
  next_scan_at          TEXT,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspace(workspace_id),
  FOREIGN KEY (source_id) REFERENCES sources(source_id)
) STRICT;

CREATE INDEX idx_connections_state_next_scan
  ON data_connections(state, next_scan_at);

CREATE INDEX idx_connections_source
  ON data_connections(source_id);
```

Policy JSON 写入前必须通过版本化 Zod Schema。不要把未经验证的任意 JSON 存入表中。

## 3. `connection_targets`

v1 由 Application 不变量保证每个 Connection 只有一个 active Target。单独建表是为了保留 Target 的 rebind、不可用和软删除历史；未来支持多 Target 前必须新增 ADR、命令和冲突规则。

```sql
CREATE TABLE connection_targets (
  target_id             TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL,
  uri                   TEXT NOT NULL,
  target_kind           TEXT NOT NULL CHECK (target_kind IN ('file', 'directory')),
  location_scope        TEXT NOT NULL CHECK (location_scope IN ('external', 'managed_content')),
  canonical_path        TEXT NOT NULL,
  target_identity_key   TEXT NOT NULL,
  path_fingerprint_json TEXT,
  recursive             INTEGER NOT NULL CHECK (recursive IN (0, 1)),
  follow_symlinks       INTEGER NOT NULL DEFAULT 0 CHECK (follow_symlinks IN (0, 1)),
  case_sensitivity      TEXT NOT NULL CHECK (case_sensitivity IN (
                          'sensitive', 'insensitive', 'unknown'
                        )),
  status                TEXT NOT NULL CHECK (status IN (
                          'active', 'unavailable', 'permission_denied',
                          'rebind_required', 'deleted'
                        )),
  last_verified_at      TEXT,
  revision              INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  FOREIGN KEY (connection_id) REFERENCES data_connections(connection_id)
) STRICT;

CREATE UNIQUE INDEX idx_connection_target_global_identity
  ON connection_targets(target_identity_key)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_connection_targets_status
  ON connection_targets(connection_id, status);
```

`external` 的 `canonical_path` 是明确允许的 ExternalInputPath，不受 Root 相对路径规则约束。`managed_content` 必须位于 Root 的允许子树中，并同时保存 Root 相对 URI。Connection 不得通过 Target 执行任何写操作。

## 4. `connection_scan_runs`

```sql
CREATE TABLE connection_scan_runs (
  scan_run_id           TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL,
  job_id                TEXT,
  trigger_kind          TEXT NOT NULL CHECK (trigger_kind IN (
                          'initial', 'schedule', 'native_event',
                          'manual', 'recovery'
                        )),
  state                 TEXT NOT NULL CHECK (state IN (
                          'queued', 'enumerating', 'comparing', 'hashing',
                          'batching', 'succeeded', 'partial', 'failed', 'cancelled'
                        )),
  started_at            TEXT,
  finished_at           TEXT,
  files_seen            INTEGER NOT NULL DEFAULT 0,
  files_hashed          INTEGER NOT NULL DEFAULT 0,
  files_ignored         INTEGER NOT NULL DEFAULT 0,
  changes_created       INTEGER NOT NULL DEFAULT 0,
  changes_modified      INTEGER NOT NULL DEFAULT 0,
  changes_deleted       INTEGER NOT NULL DEFAULT 0,
  changes_renamed       INTEGER NOT NULL DEFAULT 0,
  error_count           INTEGER NOT NULL DEFAULT 0,
  cursor_before_json    TEXT,
  cursor_after_json     TEXT,
  metrics_json          TEXT NOT NULL DEFAULT '{}',
  error_summary_json    TEXT,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES data_connections(connection_id)
) STRICT;

CREATE INDEX idx_connection_scan_runs_history
  ON connection_scan_runs(connection_id, created_at DESC);

CREATE INDEX idx_connection_scan_runs_state
  ON connection_scan_runs(state, created_at);
```

ScanRun 是不可变历史；运行中允许更新阶段和计数，进入终态后只允许补充诊断，不允许改变结果语义。

## 5. `connection_observations`

```sql
CREATE TABLE connection_observations (
  observation_id        TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL,
  target_id             TEXT NOT NULL,
  relative_path         TEXT NOT NULL,
  normalized_path_key   TEXT NOT NULL,
  file_identity         TEXT,
  entry_kind            TEXT NOT NULL CHECK (entry_kind IN (
                          'file', 'directory', 'symlink'
                        )),
  size_bytes            INTEGER,
  mtime_ns              TEXT,
  quick_fingerprint     TEXT,
  content_hash          TEXT,
  snapshot_id           TEXT,
  seen_in_scan_id       TEXT,
  state                 TEXT NOT NULL CHECK (state IN (
                          'active', 'missing_pending', 'ignored', 'deleted'
                        )),
  missing_since         TEXT,
  ignore_reason         TEXT,
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES data_connections(connection_id),
  FOREIGN KEY (target_id) REFERENCES connection_targets(target_id),
  FOREIGN KEY (seen_in_scan_id) REFERENCES connection_scan_runs(scan_run_id),
  FOREIGN KEY (snapshot_id) REFERENCES source_snapshots(snapshot_id)
) STRICT;

CREATE UNIQUE INDEX idx_connection_observation_path
  ON connection_observations(target_id, normalized_path_key);

CREATE INDEX idx_connection_observation_identity
  ON connection_observations(target_id, file_identity)
  WHERE file_identity IS NOT NULL;

CREATE INDEX idx_connection_observation_hash
  ON connection_observations(connection_id, content_hash)
  WHERE content_hash IS NOT NULL;

CREATE INDEX idx_connection_observation_missing
  ON connection_observations(connection_id, state, missing_since);
```

大小写不敏感文件系统的 `normalized_path_key` 使用统一 case-fold 规则；原始展示仍使用 `relative_path`。

`mtime_ns` 使用十进制 TEXT 保存，因为纳秒时间通常超过 JavaScript 的安全整数范围；比较前按 BigInt 解析，不能经由 number 丢失精度。

## 6. `connection_change_batches`

```sql
CREATE TABLE connection_change_batches (
  change_batch_id       TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL,
  scan_run_id           TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN (
                          'detected', 'accepted', 'processing',
                          'succeeded', 'partial', 'failed', 'cancelled'
                        )),
  item_count            INTEGER NOT NULL,
  accepted_at           TEXT,
  completed_at          TEXT,
  retry_count           INTEGER NOT NULL DEFAULT 0,
  idempotency_key       TEXT NOT NULL,
  operation_id          TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES data_connections(connection_id),
  FOREIGN KEY (scan_run_id) REFERENCES connection_scan_runs(scan_run_id),
  UNIQUE (idempotency_key)
) STRICT;

CREATE INDEX idx_connection_batches_pending
  ON connection_change_batches(state, created_at);
```

Idempotency Key 推荐由 `connection_id + target inventory version + sorted change fingerprint` 计算。

## 7. `connection_change_items`

```sql
CREATE TABLE connection_change_items (
  change_item_id        TEXT PRIMARY KEY,
  batch_id              TEXT NOT NULL,
  observation_id        TEXT,
  change_kind           TEXT NOT NULL CHECK (change_kind IN (
                          'created', 'modified', 'deleted', 'renamed', 'restored'
                        )),
  state                 TEXT NOT NULL CHECK (state IN (
                          'detected', 'stabilized', 'accepted', 'archived',
                          'ingested', 'ignored', 'failed', 'retrying'
                        )),
  relative_path         TEXT NOT NULL,
  previous_path         TEXT,
  previous_hash         TEXT,
  current_hash          TEXT,
  observation_version   INTEGER NOT NULL,
  snapshot_id           TEXT,
  document_revision_id  TEXT,
  ingestion_run_id      TEXT,
  error_code            TEXT,
  error_detail_json     TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY (batch_id) REFERENCES connection_change_batches(change_batch_id),
  FOREIGN KEY (snapshot_id) REFERENCES source_snapshots(snapshot_id)
) STRICT;

CREATE INDEX idx_connection_change_items_batch
  ON connection_change_items(batch_id, state);

CREATE INDEX idx_connection_change_items_path
  ON connection_change_items(relative_path, created_at DESC);
```

## 8. `connection_event_hints`

原生 watcher 事件只是短期提示，不是知识历史：

```sql
CREATE TABLE connection_event_hints (
  event_hint_id         INTEGER PRIMARY KEY,
  connection_id         TEXT NOT NULL,
  target_id             TEXT NOT NULL,
  event_kind            TEXT NOT NULL,
  relative_path         TEXT,
  received_at           TEXT NOT NULL,
  dedupe_key            TEXT NOT NULL,
  state                 TEXT NOT NULL CHECK (state IN (
                          'pending', 'coalesced', 'processed', 'expired'
                        )),
  FOREIGN KEY (connection_id) REFERENCES data_connections(connection_id),
  FOREIGN KEY (target_id) REFERENCES connection_targets(target_id)
) STRICT;

CREATE INDEX idx_connection_event_hints_pending
  ON connection_event_hints(connection_id, state, received_at);
```

Event Hint 可按短期保留策略清理；ChangeBatch 和 ScanRun 才是可审计历史。

## 9. `connection_write_receipts`

```sql
CREATE TABLE connection_write_receipts (
  write_receipt_id      TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL,
  target_id             TEXT NOT NULL,
  relative_path         TEXT NOT NULL,
  normalized_path_key   TEXT NOT NULL,
  expected_hash         TEXT NOT NULL,
  operation_id          TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  consumed_at           TEXT,
  created_at            TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES data_connections(connection_id),
  FOREIGN KEY (target_id) REFERENCES connection_targets(target_id)
) STRICT;

CREATE INDEX idx_connection_write_receipts_match
  ON connection_write_receipts(target_id, normalized_path_key, expected_hash)
  WHERE consumed_at IS NULL;
```

Receipt 只能抑制 path 和 content hash 都完全匹配的内部写入。过期或 Hash 不匹配时按普通外部变化处理，防止覆盖用户并发编辑。

## 10. `connection_failures`

```sql
CREATE TABLE connection_failures (
  failure_id            TEXT PRIMARY KEY,
  connection_id         TEXT NOT NULL,
  scan_run_id           TEXT,
  change_item_id        TEXT,
  error_code            TEXT NOT NULL,
  retryable             INTEGER NOT NULL CHECK (retryable IN (0, 1)),
  attempt               INTEGER NOT NULL,
  first_seen_at         TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL,
  next_retry_at         TEXT,
  resolved_at           TEXT,
  detail_json           TEXT NOT NULL,
  FOREIGN KEY (connection_id) REFERENCES data_connections(connection_id),
  FOREIGN KEY (scan_run_id) REFERENCES connection_scan_runs(scan_run_id)
) STRICT;

CREATE INDEX idx_connection_failures_retry
  ON connection_failures(resolved_at, retryable, next_retry_at);
```

Detail 必须脱敏，不能保存文件完整内容或凭证。

## 11. `connection_daemon_leases`

```sql
CREATE TABLE connection_daemon_leases (
  workspace_id          TEXT PRIMARY KEY REFERENCES workspace(workspace_id),
  instance_id           TEXT NOT NULL,
  pid                   INTEGER NOT NULL,
  host_id               TEXT NOT NULL,
  cli_version           TEXT NOT NULL,
  protocol_version      INTEGER NOT NULL,
  started_at            TEXT NOT NULL,
  heartbeat_at          TEXT NOT NULL,
  lease_expires_at      TEXT NOT NULL,
  version               INTEGER NOT NULL
) STRICT;
```

Lease 更新使用 compare-and-swap：

```sql
UPDATE connection_daemon_leases
SET heartbeat_at = ?, lease_expires_at = ?, version = version + 1
WHERE workspace_id = ? AND instance_id = ? AND version = ?;
```

受影响行数不是 1 时，Daemon 必须认为自己已经失去 Leadership，停止调度并退出。

## 12. 事务边界

一次扫描不使用一个超长事务。推荐边界：

1. 创建 ScanRun：短事务。
2. 枚举和 Hash：事务外，只写临时 inventory。
3. 比较 inventory 并生成 Batch：短事务，检查 Observation Version。
4. Source 复制文件并计算 Blob：事务外。
5. Source 发布 Snapshot 并更新 ChangeItem：短事务。
6. Ingestion 完成后更新进度投影：短事务。

文件 Hash、复制、模型和解析都禁止放在 SQLite 事务内。

## 13. Retention

- Observation：保留当前状态和 tombstone；历史由 ScanRun、ChangeItem、Source Snapshot 和 Document Revision 表达。
- ScanRun：成功运行可按策略压缩统计，但最近运行和失败运行长期保留。
- Event Hint：默认保留 24 小时或处理完成后短期清理。
- Write Receipt：消费后短期保留用于审计；未消费回执过期后安全清理。
- ChangeBatch/Item：至少保留到所有关联 Source Snapshot、Document Revision 和 Artifact 超出保留期。
- Failure：解决后按审计策略保留。
- 永久清理只能由 Operations GC 根据引用证明执行。

## 14. Schema 验证查询

`self verify` 至少检查：

- v1 active Connection 是否恰好存在一个 active Target。
- Observation 是否引用有效 Target。
- accepted Batch 是否有至少一个 Item。
- archived Item 是否有 Source Snapshot；ingested Item 是否有 Document Revision 或明确的无文档结果。
- Lease 是否过期但仍被报告为 active。
- 未过期 Write Receipt 是否只指向 managed_content Target。
- succeeded ScanRun 是否仍有未决 Batch。
- `missing_pending` 是否超过 Grace Period 未处理。
- deleted Connection 是否仍在调度队列。
