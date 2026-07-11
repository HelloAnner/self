# Connection 领域模型

## 1. 聚合边界

`DataConnection` 是聚合根。v1 中一个 Connection 只绑定一个 Target；Target 仍独立建表，以支持生命周期、rebind 和未来经过 ADR 后扩展为多 Target 策略组。

```text
DataConnection
├── ConnectionId
├── Name
├── State
├── WatchMode
├── ScanPolicy
├── FilterPolicy
├── ResourcePolicy
├── Target[]
├── Health
├── ConfigVersion
└── AggregateRevision
```

ScanRun、Observation、ChangeBatch 和 DaemonLease 是独立聚合，通过 ConnectionId 关联，避免一个长期连接聚合无限增长。

`ManagedWriteReceipt` 是短期协调对象：Self 的 Note/File Workflow 在写入 managed content 前登记预期 path、content hash、operation ID 和过期时间；Connection 观察到完全匹配的结果后消费回执。

## 2. DataConnection

### 字段

| 字段 | 含义 |
| --- | --- |
| `id` | `connection:con_<uuidv7>`，遵循全局稳定 ID 规范 |
| `name` | 人类可读名称 |
| `kind` | `file`、`directory`、`project`、`obsidian` |
| `state` | 当前生命周期状态 |
| `watch_mode` | `poll`、`native`、`watch-and-reconcile` |
| `scan_policy` | 扫描间隔、防抖、稳定窗口等 |
| `filter_policy` | include、exclude、隐藏文件和敏感文件规则 |
| `resource_policy` | 并发、批量、吞吐和文件大小限制 |
| `source_id` | 绑定的 Source |
| `config_version` | 策略版本 |
| `reconcile_required` | 是否必须尽快执行一次权威完整对账 |
| `revision` | 乐观并发版本 |

### 状态

```text
draft
  → initializing
  → active
  ↔ paused
  → degraded
  → error
  → detached
  → deleted
deleted --restore→ paused --scan→ active/degraded
```

| 状态 | 含义 |
| --- | --- |
| `draft` | 已创建但尚未验证 Target |
| `initializing` | 正在做首次清单和 Snapshot |
| `active` | 可以监听和定期扫描 |
| `paused` | 保留配置和清单，但不主动扫描 |
| `degraded` | 暂时不可用，如路径消失或权限不足 |
| `error` | 配置或持续错误，需要干预 |
| `detached` | 停止监控，保留全部历史 |
| `deleted` | 软删除，不参与调度 |

`degraded` 不是 `deleted`，也不能触发全量文件删除。

## 3. ConnectionTarget

一个 Target 表示一个被监控的文件或目录。

| 字段 | 含义 |
| --- | --- |
| `id` | Target 稳定 ID |
| `connection_id` | 所属 Connection |
| `uri` | 规范化外部 URI，如 `file:///Users/me/project/docs` |
| `target_kind` | `file` 或 `directory` |
| `location_scope` | `external` 或受控的 `managed_content` |
| `canonical_path` | 当前机器上的规范路径 |
| `target_identity_key` | 由 scope、卷和规范路径形成的全局去重键 |
| `path_fingerprint` | 卷、inode/file-id、首层清单等组合指纹 |
| `recursive` | 是否递归 |
| `follow_symlinks` | 默认 false |
| `case_sensitivity` | 文件系统大小写策略 |
| `status` | active、unavailable、permission_denied、rebind_required、deleted |
| `last_verified_at` | 最近验证时间 |

路径指纹用于辅助 rebind，不能单独作为安全认证。

`managed_content` 只允许指向 Root 内的 `content/notes/` 或 `content/inbox/`，不支持 rebind；Root 中其他系统目录一律拒绝。

创建 Target 时必须检查与现有 active Target 的精确重复和父子目录重叠。精确重复按幂等请求返回已有 Connection；范围重叠默认拒绝，只有经过显示影响范围的 Plan 才能允许。

## 4. ScanPolicy

```ts
type ScanPolicy = {
  mode: "poll" | "native" | "watch-and-reconcile";
  reconcileIntervalMs: number;
  fullHashIntervalMs: number;
  eventDebounceMs: number;
  writeSettleWindowMs: number;
  deleteGracePeriodMs: number;
  maxSettleRetries: number;
};
```

限制：

- `native` 仍必须设置最大 reconciliation 间隔。
- 防抖只减少重复工作，不能成为持久 Cursor。
- Interval 为 0 只能表示手工模式，不能造成忙循环。

## 5. FilterPolicy

| 字段 | 含义 |
| --- | --- |
| `include_globs` | 至少匹配一条才进入候选 |
| `exclude_globs` | 命中任一条即排除 |
| `include_hidden` | 默认 false |
| `sensitive_file_mode` | `deny`、`confirm`、`allow` |
| `max_file_bytes` | 超限文件记录 ignored 原因 |
| `allowed_mime_types` | 可选 MIME 白名单 |

规则顺序：安全拒绝 → exclude → include → 文件类型/大小 → 稳定性检查。

## 6. FileObservation

Observation 是 Connection 对外部文件当前状态的持久认知。

| 字段 | 含义 |
| --- | --- |
| `connection_id` | Connection |
| `target_id` | Target |
| `relative_path` | 相对 Target 的规范路径 |
| `file_identity` | inode/file-id 等平台身份，可为空 |
| `kind` | file、directory、symlink |
| `size` | 字节数 |
| `mtime_ns` | 高精度修改时间 |
| `quick_fingerprint` | 元数据与局部内容指纹 |
| `content_hash` | 完整 SHA-256，可延迟计算 |
| `snapshot_id` | 最近成功归档的 Source Snapshot |
| `seen_in_scan_id` | 最近出现的 ScanRun |
| `state` | active、missing_pending、ignored、deleted |
| `version` | Observation 乐观版本 |

Observation 不是 Source Snapshot，只用于变化判断。

## 7. ScanRun

```text
queued → enumerating → comparing → hashing → batching → succeeded
                                └──────────────→ partial
                                └──────────────→ failed
                                └──────────────→ cancelled
```

ScanRun 记录：

- 触发原因：initial、schedule、native_event、manual、recovery
- 开始和结束 Cursor
- 发现文件数、读取文件数、Hash 数、Ignored 数
- 新增、修改、删除、重命名数量
- 错误和未决路径
- 耗时与资源用量

## 8. ChangeBatch 与 ChangeItem

ChangeBatch 是交给 Source 的原子业务批次。

```ts
type ChangeKind = "created" | "modified" | "deleted" | "renamed" | "restored";

type ChangeItem = {
  id: ChangeItemId;
  kind: ChangeKind;
  relativePath: string;
  previousPath?: string;
  previousHash?: string;
  currentHash?: string;
  observationVersion: number;
};
```

ChangeItem 状态：

```text
detected → stabilized → accepted → archived → ingested
                 └→ ignored
                 └→ failed → retrying
```

含义：

- `detected`：扫描或事件发现候选变化。
- `stabilized`：文件在 settle window 内保持稳定。
- `accepted`：ChangeBatch 已持久化并由 Source Workflow 接收。
- `archived`：Source 已生成内部 Snapshot。
- `ingested`：Ingestion 已发布知识变化。

Connection 只拥有到 `accepted` 的规则；后续状态通过订阅 Source/Ingestion 事件更新只读进度。

## 9. ConnectionHealth

Health 不是简单 boolean：

```ts
type ConnectionHealth = {
  level: "healthy" | "degraded" | "error" | "stale";
  lastEventAt?: string;
  lastScanAt?: string;
  lastSuccessfulScanAt?: string;
  nextScanAt?: string;
  pendingChanges: number;
  failedChanges: number;
  consecutiveFailures: number;
  lagMs?: number;
  reasons: HealthReason[];
};
```

`stale` 表示超过预期时间没有成功 reconciliation，不能把“没有事件”直接解释为“没有变化”。

## 10. DaemonLease

一个 Self Root 同一时间只能有一个 Connection Daemon Leader：

| 字段 | 含义 |
| --- | --- |
| `instance_id` | Daemon 运行实例 |
| `pid` | 仅用于诊断，不作为唯一锁依据 |
| `host_id` | 当前机器身份 |
| `cli_version` | Daemon 使用的 Self CLI 版本 |
| `protocol_version` | Daemon/CLI 协调协议版本 |
| `started_at` | 启动时间 |
| `heartbeat_at` | 心跳时间 |
| `lease_expires_at` | 租约过期时间 |
| `version` | CAS 更新版本 |

Daemon 必须同时使用文件锁和 SQLite Lease。PID 文件单独存在不足以保证正确性。

## 11. 领域事件

- `ConnectionCreated`
- `ConnectionActivated`
- `ConnectionPaused`
- `ConnectionDegraded`
- `ConnectionRecovered`
- `ConnectionDetached`
- `TargetRebound`
- `ScanStarted`
- `ScanCompleted`
- `ScanFailed`
- `ChangeBatchDetected`
- `ChangeBatchAccepted`
- `ConnectionLagExceeded`
- `DaemonLeadershipAcquired`
- `DaemonLeadershipLost`
- `ManagedWriteReceiptConsumed`

所有事件携带 `connection_id`、`operation_id`、对象版本和 UTC 时间。

## 12. 稳定错误码

| 错误码 | 含义 |
| --- | --- |
| `connection_not_found` | Connection 不存在 |
| `connection_target_unavailable` | 外部路径暂时不可访问 |
| `connection_permission_denied` | 无读取权限 |
| `connection_self_reference` | 目标指向整个 Self Root 或禁止监控的系统生成目录 |
| `connection_rebind_mismatch` | 新路径与原 Target 指纹明显不匹配 |
| `connection_scan_in_progress` | 已有不允许并发的扫描 |
| `connection_daemon_not_running` | 后台进程未运行 |
| `connection_daemon_conflict` | 另一个 Leader 持有有效租约 |
| `connection_file_unstable` | 文件持续变化，未达到稳定窗口 |
| `connection_batch_conflict` | Observation 版本在提交前改变 |
