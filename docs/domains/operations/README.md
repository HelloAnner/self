# Operations 领域

> 状态：Phase 10 主体已实现，CLI v1.0.0 / Schema 11；外部发布资格仍待 24h Soak 和跨平台 CI

## 目标

Operations 保证单目录知识库能够长期运行、升级、校验、备份、恢复和安全清理。

## 负责范围

- SQLite Schema 迁移和兼容性检查
- Online Backup、一致性快照和恢复
- 数据库、文件、哈希和引用完整性验证
- WAL checkpoint、锁诊断和异常恢复
- 无引用 Blob、缓存和历史数据 GC
- 保留策略、软删除到永久清理
- 日志、诊断包和 `self doctor`
- 故障注入、恢复演练和格式升级

## 核心对象

- `Migration`：有序、可验证的格式迁移
- `Backup`：带 Manifest 的一致性备份
- `VerificationRun`：一次完整性检查及问题集合
- `RepairPlan`：可审查的修复计划
- `RetentionPolicy`：历史与缓存保留规则
- `GcPlan`：待清理对象及其引用证明
- `GcReceipt`：Apply 后的不可变清理证明和逐项结果
- `MaintenanceLease`：跨进程维护互斥、所有者和过期时间

## 关键不变量

- 备份必须包含恢复所需的数据库和文件 Manifest。
- 恢复不得直接覆盖当前实例，必须先验证并生成 Plan。
- GC 只能删除已证明无引用或满足明确保留策略的数据。
- 迁移失败时必须保留原版本和可恢复路径。
- 校验和修复必须分离，`verify` 本身不修改数据。
- Restore 目标必须不存在；复制到 staging、校验、运行 Deep Verify 后才能原子发布。
- Backup 只归档恢复业务状态所需的 allowlist，不复制 `backups/`、测试目录、日志、锁、临时文件和迁移备份。
- GC 文件先进入 Root-local staging；Receipt 成功后删除 staging，崩溃重启根据 Receipt 恢复或完成删除。

## Phase 10 已实现边界

- `backup create|list|show|verify|restore`：SQLite 一致性快照、文件 Manifest/Hash、显式 Restore Plan、非覆盖新 Root 恢复。
- `verify [--deep --wait|--detach]`：数据库、外键、迁移校验和、Blob、Revision/Chunk、FTS、Vector、证据链、Artifact 和配置秘密检查。
- `gc --plan --older-than <duration>`：仅列出有引用证明的候选，Apply 写入 Receipt 并审计逐项结果。
- `maintenance status|checkpoint`：维护锁、dead PID/expired lease 回收、WAL 状态和显式 checkpoint。
- Backup、Deep Verify 通过持久化 Job 运行；Migration 在副本上执行并在完整性检查后原子替换。
- `doctor --all` 增加外键、迁移历史、durable Job 和 maintenance lock 检查；Diagnostics 不包含正文、绝对私人路径或凭证。

当前限制：本机 darwin-arm64 RC Gate 已通过；GitHub 五平台工作流已定义但尚未在远端实际完成，24h Soak 也尚未执行。因此这里描述“实现完成”，不等同于“公开 v1.0 已发布”。

## 不负责

- 普通业务对象删除
- Source 外部同步
- Topic 和 Artifact 内容生成

## 详细文档

- [`migrations.md`](./migrations.md)：Schema 1～11 迁移清单、校验和、兼容模式与恢复边界。
