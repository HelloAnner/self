# Connection 测试设计

> Connection 的正确性不能只靠 mock watcher。必须在一次性本地目录中运行真实编译后 CLI 和后台进程，真实创建、修改、重命名和删除文件，再检查 SQLite、Source Snapshot、Ingestion 和事件流。

## 1. Test Run 布局

```text
.test-runs/<run-id>/
├── external/
│   ├── project-a/docs/
│   ├── project-b/README.md
│   └── vault/
├── instance/
│   ├── self.toml
│   ├── data/self.sqlite3
│   ├── content/
│   ├── runtime/
│   └── artifacts/
├── expected/
├── actual/
└── logs/
```

Connection 可以读取 `external/`，但除测试主动模拟的文件变化外，不得写入其中。全部 Self 业务写入必须位于 `instance/`。

## 2. 测试层次

### 2.1 Domain 单元测试

- Connection 状态转换
- ScanPolicy 和 FilterPolicy 校验
- Health 计算
- Change 分类
- Delete Grace Period
- Rename 候选选择
- Batch Idempotency Key
- Daemon Lease CAS
- Rebind 指纹判断

### 2.2 SQLite 集成测试

- 所有外键和 CHECK 约束
- active Connection 调度查询
- Observation path 唯一性
- Batch idempotency 唯一约束
- Observation Version 冲突
- Lease 获取、续约、过期和抢占
- ScanRun/Batch 崩溃恢复查询
- GC 引用保护

### 2.3 CLI 契约测试

- 每条 `connection` 和 `daemon` 命令的 help
- human、JSON 和 JSONL 输出
- 错误码和退出码
- Path、Duration、Size 和 Glob 参数校验
- Plan/Apply、幂等和 `--if-version`
- `source add --watch` 的组合返回值

### 2.4 真实 E2E

启动真实 Daemon，使用真实文件系统事件和定时 reconciliation，验证完整链路。

## 3. 必须覆盖的 E2E 场景

### 3.1 Initial Scan

1. 创建包含 20 个 Markdown 的外部 docs 目录。
2. `connection add`。
3. 等待 Initial Scan 和 Source 归档。
4. 验证 Connection active、Observation 数量、Snapshot、Chunk 和向量。
5. 验证 ignored 文件没有进入 Source。

### 3.2 单文件修改

1. 修改一个 Markdown 中的一个段落。
2. 等待 Daemon 自动发现。
3. 验证只产生一个 modified ChangeItem。
4. 验证只更新受影响 Revision/Chunk/Embedding。
5. 验证未变化文件的 Observation 和知识对象被复用。

### 3.3 高频连续保存

在 2 秒内对同一文件执行多次临时写入和 rename：

- watcher 可以产生多个 Event Hint。
- 最终只能归档稳定后的最终内容。
- 不允许归档中间半文件。
- Batch 数量符合防抖策略。

### 3.4 新建和删除

- 创建新文件后自动归档。
- 删除文件先进入 missing_pending。
- Grace Period 前不生成 confirmed delete。
- 完整健康 Scan 后确认 delete。
- 历史 Source Snapshot、Document Revision 和 Artifact 仍可打开。

### 3.5 Rename

- 编辑器原子保存识别为 modify，不误报长期 delete/create。
- 同文件系统 rename 优先用 file identity 识别。
- identity 不可用但 hash 唯一时识别 rename。
- 无法确定时安全退化为 delete + create。

### 3.6 目录暂时消失

1. 将整个 Target 目录临时改名或卸载。
2. 触发 Scan。
3. Connection 进入 degraded。
4. 所有 Observation 保留，不能批量 delete。
5. 恢复目录后执行完整 reconciliation 并回到 healthy。

### 3.7 权限变化

- 移除目录读取权限。
- 验证 permission_denied、退避和诊断。
- 恢复权限后自动 Recovery Scan。
- 不产生虚假删除。

### 3.8 Include/Exclude

- 默认排除 `.git`、node_modules、dist、临时和敏感文件。
- 动态增加 include/exclude 后触发完整 reconciliation。
- `connection explain --path` 正确说明命中规则。
- 符号链接默认不跟随。

### 3.9 Self Root 反馈回路

- 尝试连接 Self Root、`artifacts/`、`runtime/logs/`。
- 命令必须拒绝并返回 `connection_self_reference`。
- 通过符号链接间接指向 Root 也必须拒绝。
- `content/notes/` 和 `content/inbox/` 以 `managed-content` scope 可以连接并正常感知人工修改。

### 3.10 Daemon 单 Leader

- 同时启动两个 Daemon。
- 只有一个获取文件锁和 SQLite Lease。
- 第二个返回稳定冲突，不处理 Connection。
- Leader 崩溃且 Lease 过期后，新进程安全接管。

### 3.11 休眠和 Event Overflow

- 模拟 watcher 丢事件或队列 overflow。
- Connection 将 `reconcile_required` 标记为 true。
- 定时完整扫描最终发现全部变化。
- 不能依赖 Event Hint 数量判断业务变化。

### 3.12 Daemon 崩溃点

在以下阶段强制终止：

```text
after_event_hint
during_enumeration
during_hash
after_batch_commit
during_source_copy
after_snapshot_publish
before_observation_update
during_lease_heartbeat
```

重启后验证：

- 无重复 Snapshot 和 ChangeItem。
- Batch 按 Idempotency Key 恢复。
- 已发布 Snapshot 能和未完成 Item 对账。
- 最终状态与无崩溃运行一致。

### 3.13 Rebind

- 整体移动外部项目并执行 rebind。
- 指纹匹配时保留 Connection 和 Observation 历史。
- 指向完全不同目录时默认拒绝。
- Rebind Plan 准确展示匹配率和潜在变化。

### 3.14 多 Connection

- 同时监控多个项目 docs 和单文件。
- 验证每个 Connection 独立健康状态。
- 资源限制生效，不形成无限并发 Hash。
- 一个 Connection 失败不阻塞其他连接。
- 重复添加同一 Target 幂等返回现有 Connection。
- 父目录和子目录重叠默认拒绝；显式允许时不会把重复资料误算为独立证据。

### 3.15 CLI/Daemon 版本兼容

- 用旧版本 Daemon 持有 Lease，再运行新版本 CLI。
- 协议兼容时可以读取状态并完成允许的协调。
- 协议不兼容时拒绝写操作，并明确要求 restart。
- restart 后未完成 Scan/Batch 仍能恢复，不因二进制升级重复归档。

### 3.16 Managed Content 自写入抑制

- 使用 `self note update` 写入 `content/notes/`，验证 watcher 不重复生成相同 Snapshot/Revision。
- Receipt 的 path 与 hash 完全匹配后被消费。
- Receipt 创建后由用户写入不同内容，验证真实修改不会被抑制。
- Daemon 未收到原生事件时，reconciliation 仍能正确消费或绕过 Receipt。
- 过期 Receipt 不会永久隐藏后续修改。

## 4. 属性测试

关键属性：

- 无变化重复 Scan 不产生 ChangeBatch。
- 相同最终文件树通过任意事件顺序都收敛到相同 Observation。
- watcher 丢失任意事件后，完整 reconciliation 仍收敛。
- metadata 改变但 content hash 相同不产生 modified Revision。
- Target 不可用绝不产生批量 delete。
- 同 Batch 重试不重复创建 Snapshot。
- 任意 archived ChangeItem 都能找到 Source Snapshot；任意 ingested ChangeItem 都能找到 Document Revision 或明确的无文档结果。
- 任意 active Observation 都属于 active Target。
- 失去 Lease 的 Daemon 不再提交新 Batch。

## 5. 平台矩阵

必须测试：

- macOS APFS 大小写不敏感
- macOS 大小写敏感卷（可用时）
- Linux ext4
- Windows NTFS
- Linux/macOS 符号链接
- 网络盘或可移动盘使用可控集成环境验证 unavailable/recovery

不能只在一个平台验证 watcher 语义。

## 6. 性能指标

Small、Medium、Large 目录分别记录：

- Daemon 空闲 CPU 和内存
- Initial Scan 文件/秒
- 无变化 reconciliation 耗时
- 单文件变化发现延迟
- Hash 吞吐和读取字节
- Event Hint 合并率
- Batch 到 Snapshot、Ingestion 的端到端延迟
- SQLite Observation 表增长
- 24 小时重复修改后的稳定性

原生 watcher 的目标是降低延迟，不得以牺牲 reconciliation 正确性换取 Benchmark。

## 7. 安全测试

- `../` Path Traversal
- Target 内符号链接逃逸
- Self Root 间接引用
- FIFO、socket、设备文件
- 超大文件和稀疏文件
- 恶意文件名和无效 Unicode
- 敏感文件默认拒绝
- 目录树极深和 symlink loop
- 扫描期间路径被攻击者替换
- Daemon 日志不泄漏文件内容和密钥

## 8. 发布门禁

Connection 功能进入默认开启前必须满足：

- foreground scan E2E 全部通过。
- polling daemon 通过 24 小时长稳。
- 原生 watcher 在目标平台全部通过。
- 丢事件后 reconciliation 等价性通过。
- 目录不可用零误删通过。
- 单 Leader 和崩溃恢复通过。
- Source/Ingestion 端到端幂等通过。
- Root 外除显式 external 读取外无业务写入。
- CPU、内存、IO 和扫描延迟有真实基线。
