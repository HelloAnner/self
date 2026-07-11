# Knowledge 核心测试矩阵

> 状态：Phase 3 gate passed

- ready Chunk 全链路回溯到 Snapshot entry 和 Blob。
- 小段修改仅创建受影响 Chunk，未变化 Chunk ID 复用并记录 lineage。
- 格式变化产生新 Revision，但语义相同 Chunk 全部复用。
- 删除 entry tombstone 当前 Document/Chunk，历史 Revision 不删除。
- 增量多次修改后的规范 Document/Chunk Hash 与最终资料全量构建等价。
- Note create/update 保存文件、Snapshot、Revision 和版本；managed-content Connection 实际消费精确路径/Hash WriteReceipt，陈旧版本冲突不写文件。
- Schema 3 → 4 显式 Plan/Apply、Root-local backup 和完整性检查通过。
