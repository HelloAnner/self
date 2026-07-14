# Knowledge 核心测试矩阵

> 状态：Phase 9 gate passed

- ready Chunk 全链路回溯到 Snapshot entry 和 Blob。
- 小段修改仅创建受影响 Chunk，未变化 Chunk ID 复用并记录 lineage。
- 格式变化产生新 Revision，但语义相同 Chunk 全部复用。
- 删除 entry tombstone 当前 Document/Chunk，历史 Revision 不删除。
- 增量多次修改后的规范 Document/Chunk Hash 与最终资料全量构建等价。
- Note create/update 保存文件、Snapshot、Revision 和版本；managed-content Connection 实际消费精确路径/Hash WriteReceipt，陈旧版本冲突不写文件。
- Schema 3 → 4 显式 Plan/Apply、Root-local backup 和完整性检查通过。
- Phase 4 必须覆盖 FTS shadow swap、VectorSpace fingerprint 隔离、build checkpoint、verify/activate/rollback、漂移降级和 Schema 4 → 5 Migration。
- Phase 5 覆盖 Knowledge 发布后的 Graph 增量 Generation、tombstoned Chunk Evidence stale 传播，以及 Graph 失败不回滚本地 Revision/FTS。
- Phase 9 覆盖 Note update 的 if-version/幂等 Operation、move Plan 的 Root 内路径与 Source locator 原子变更、文件+SQLite Undo 补偿、delete/restore 的相同 Note/Source/Document/Revision/Chunk ID，以及陈旧 Plan 不写文件也不写数据库。
