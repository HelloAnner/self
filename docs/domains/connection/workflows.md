# Connection 工作流：扫描、监听与后台进程

## 1. 总体运行模型

Connection 采用双通道：

```text
低延迟通道：原生 watcher → Event Hint → 防抖 → 局部扫描
正确性通道：定时 reconciliation → 完整枚举 → 清单对账
```

两条通道最终都进入同一个 Scan Workflow。原生 watcher 不拥有单独的归档逻辑。

## 2. 创建 Connection

```text
接收路径和策略
  → canonicalize 外部路径
  → 检查权限与文件类型
  → 拒绝 Self Root 自引用
  → 应用默认敏感文件规则
  → 计算 Target 指纹
  → 创建 draft Connection
  → 创建/绑定 Source
  → 进入 initializing
  → 执行 Initial Scan
  → Source 归档
  → 成功后变为 active
  → 确保 Root-local Daemon 正在运行（除非显式 --no-daemon）
```

Initial Scan 部分失败时：

- 已成功文件可以继续归档。
- Connection 状态为 degraded 或 error，不能伪装为 healthy。
- 输出失败路径和重试建议。

## 3. 原生 watcher 事件处理

### 3.1 事件接收

Watcher callback 只能做最少工作：

1. 规范化相对路径。
2. 验证路径仍在 Target 内。
3. 生成 dedupe key。
4. 写入内存 bounded queue 或持久 Event Hint。
5. 立即返回。

Callback 中禁止读取完整文件、计算 Hash、执行 Source 归档或打开长事务。

### 3.2 防抖与合并

常见编辑器保存行为：

```text
write temp → fsync → rename old → rename temp → final file
```

Connection 将同一目录、相近路径和防抖窗口内的事件合并为一次局部扫描。合并可以减少工作，但不能凭事件序列直接断定 rename。

### 3.3 Overflow

如果内存队列满、Watcher 报告 overflow 或事件语义不完整：

- 将 Connection 的 `reconcile_required` 标记为 true。
- 丢弃可安全重建的 Event Hint。
- 尽快调度一次完整 reconciliation。
- 不把 overflow 当作“没有变化”。

一次成功覆盖全部 active Target 的 reconciliation 才能将 `reconcile_required` 清为 false。

## 4. Scan Workflow

### 4.1 Phase A：验证 Target

- 路径存在且类型匹配。
- 具有最小读取权限。
- 根目录没有被替换为意外的符号链接。
- Path Fingerprint 没有显著不匹配。

如果根路径完全不可用，Scan 失败为 `target_unavailable`，保留全部 Observation，不生成 delete。

### 4.2 Phase B：枚举

- 递归遍历使用 bounded concurrency。
- 先应用路径级 exclude，避免进入 `node_modules` 等大目录。
- 默认不跟随 symlink。
- 检测 symlink loop 和跨 Target 跳转。
- 文件条目规范化为大小写感知的 path key。
- 每隔固定数量保存 Scan checkpoint。

### 4.3 Phase C：快速比较

先比较：

- normalized path
- entry kind
- file identity
- size
- mtime
- quick fingerprint

元数据完全未变的文件通常复用 content hash。以下情况必须重新 Hash：

- 新文件
- 大小或 mtime 改变
- quick fingerprint 改变
- 距离上次完整 Hash 超过策略时间
- 文件系统时间精度不足
- 用户执行 `scan --full-hash`

### 4.4 Phase D：稳定窗口

可能仍在写入的文件：

1. 记录 size、mtime 和 identity。
2. 等待 settle window。
3. 再次 stat。
4. 一致后读取和 Hash。
5. 不一致则有限重试。
6. 超过重试次数生成 `connection_file_unstable`，下次扫描继续。

禁止读取一半内容后归档为成功 Snapshot。

### 4.5 Phase E：变化分类

#### Created

新 path、没有对应 active Observation。

#### Modified

相同逻辑文件的 content hash 发生变化。只改变 mtime 而 content hash 相同，不产生业务变化。

#### Renamed

优先依据稳定 file identity，其次依据同批次内唯一 content hash。无法确定时记录 delete + create，不能强行猜测。

#### Deleted

旧 Observation 未出现在完整 Scan 中时先进入 `missing_pending`。只有满足以下条件才确认删除：

- Target 本身健康可用。
- 扫描成功覆盖相应父目录。
- 超过 delete grace period。
- 没有识别为 rename。

#### Restored

之前 tombstone 的路径重新出现，内容或身份与历史匹配。

### 4.6 Phase F：Batch

- 对 ChangeItem 稳定排序。
- 计算 Batch Idempotency Key。
- 在短事务内检查 Observation Version。
- 写入 ChangeBatch/Item 和新的 Observation 状态。
- 提交后发布 `ChangeBatchDetected`。

版本冲突时放弃该 Batch 并重新扫描受影响路径。

## 5. Source 归档 Workflow

```text
ChangeBatchDetected
  → SourceWorkflow.claim(batch)
  → 对 created/modified/renamed 读取稳定文件
  → 复制到 Root 内部临时区
  → 计算 SHA-256 和 Blob 去重
  → 发布 Source Snapshot
  → 处理 delete tombstone
  → 发布 SnapshotCreated / SourceChangeAccepted
  → Connection 事件处理器更新 ChangeItem archived 投影
  → 触发 Ingestion
```

关键要求：

- Source 再次验证文件状态，防止 Scan 后到归档前发生变化。
- 如果文件变化，当前 Item 返回 version conflict，重新进入 Scan。
- Batch 可以 partial，但每个 Item 状态必须清晰。
- Cursor 只在 Batch 持久化且 Source 已接受后推进。
- Source 和 Ingestion 不直接写 Connection 表；它们发布事件，由 Connection 拥有的投影处理器更新 Item 进度。

### 5.1 Managed Content 的内部写入回执

当 `self note update` 等正式 Workflow 写入 `content/notes/`：

```text
计算将写入的最终内容 Hash
  → 向 Connection 注册 ManagedWriteReceipt
  → 原子写入文件
  → 提交 Note/Revision Operation
  → watcher/scan 观察文件
  → path + hash 完全匹配 Receipt
  → 消费 Receipt 并更新 Observation
  → 不重复创建 Snapshot/Revision
```

若用户在写入后立刻再次修改文件，最终 Hash 与 Receipt 不同，Connection 必须按普通 modified 变化归档，不能因为 path 相同而抑制。

## 6. 周期调度

Daemon 使用最小堆或按 `next_scan_at` 查询 active Connection：

```sql
SELECT id
FROM data_connections
WHERE state IN ('active', 'degraded')
  AND next_scan_at <= ?
ORDER BY next_scan_at
LIMIT ?;
```

调度规则：

- 同一个 Connection 默认不并发运行两个 Scan。
- 多个 Connection 可以受限并发扫描。
- 失败使用有上限指数退避并加 jitter。
- 权限错误和 rebind_required 不无限高频重试。
- 用户手工 Scan 优先于普通 schedule，但不能破坏正在提交的 Batch。
- 机器休眠恢复后合并过期 schedule，只执行一次 reconciliation。

## 7. Daemon 生命周期

### 7.1 启动

```text
发现 Root
  → 加载 self.toml
  → 获取 daemon 文件锁
  → 获取 SQLite Lease
  → 恢复未完成 Scan/Batch
  → 加载 active Connections
  → 建立原生 watchers
  → 启动 schedule loop
  → 周期 heartbeat
```

### 7.2 Leadership

- Lease 未过期时第二个 Daemon 必须退出并返回 conflict。
- Lease 过期不代表旧进程一定死亡，接管前还要验证文件锁。
- 失去 Lease 的进程立即停止新调度、取消 watcher，并优雅退出。
- 普通前台 `connection scan` 通过相同 Job 协议协调，不绕过 Daemon。
- 普通 CLI 发现 active Daemon 的 Protocol Version 不兼容时拒绝协调写操作，并提示执行 `self daemon restart`；不能让不同版本同时修改调度状态。
- Daemon 文件锁和 Lease 只保护调度 Leadership，不长期占用 Workspace 全局写锁；CLI 与 Daemon 依靠短事务、对象版本和 Job Claim 协调数据库写入。

### 7.3 退出

```text
停止接收 Event Hint
  → 停止创建新 Scan
  → checkpoint 当前枚举
  → 等待短事务完成
  → 关闭 watchers
  → 释放 Lease 和文件锁
  → flush 日志
```

## 8. 崩溃恢复

Daemon 启动时扫描：

- running 但无有效 Job Lease 的 ScanRun
- detected/accepted/processing Batch
- retrying ChangeItem
- missing_pending Observation
- 过期 DaemonLease

恢复策略：

- 枚举中断：从 checkpoint 继续或重新 Scan。
- Hash 中断：重做未持久化 Hash。
- Batch 已持久化：按 Idempotency Key 继续 Source Workflow。
- Source Snapshot 已发布但 Item 未更新：通过 Snapshot ID 和内容哈希进行对账。
- `latest` Cursor 不确定：重新 reconciliation，不能猜测推进。

## 9. 路径不可用与可移动磁盘

以下情况属于 unavailable，不是删除：

- 外接磁盘未挂载
- 网络盘离线
- 父目录暂时无权限
- 项目目录被临时移动
- 操作系统休眠导致 watcher 失效

处理：

- Connection 进入 degraded。
- 保留所有 Observation 和知识。
- 定期低频重试 Target 验证。
- 恢复后先做完整 reconciliation。
- 路径明显变成另一个目录时要求 rebind 确认。

## 10. 资源控制

每个 Connection 可设置：

- 最大扫描并发
- 最大 Hash 并发
- 单文件最大字节数
- 每批最大变化数
- 每分钟最大归档字节数
- CPU/IO 优先级
- 安静时段

Daemon 的全局限制来自 `self.toml [connections]`，单连接策略只能收紧，不能绕过安全上限。

## 11. 配置默认值

```toml
[connections]
enabled = true
max_concurrent_scans = 2
max_concurrent_hashes = 4
reconcile_interval = "5m"
full_hash_interval = "24h"
event_debounce = "750ms"
write_settle_window = "1500ms"
delete_grace_period = "30s"
max_batch_size = 500
daemon_heartbeat = "15s"
daemon_lease = "45s"
```

具体 Connection 的 Target、Filter 和 Schedule 存在 SQLite，不把动态连接列表重复写入 TOML。
