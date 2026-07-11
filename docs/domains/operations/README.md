# Operations 领域

> 状态：待详细设计

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

## 关键不变量

- 备份必须包含恢复所需的数据库和文件 Manifest。
- 恢复不得直接覆盖当前实例，必须先验证并生成 Plan。
- GC 只能删除已证明无引用或满足明确保留策略的数据。
- 迁移失败时必须保留原版本和可恢复路径。
- 校验和修复必须分离，`verify` 本身不修改数据。

## 不负责

- 普通业务对象删除
- Source 外部同步
- Topic 和 Artifact 内容生成
