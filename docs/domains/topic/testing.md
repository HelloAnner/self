# Topic 测试规范

## 1. 确定性测试

- 两个独立 source_lineage_key 形成 consensus。
- 三份证据若其中两份 Blob 相同，只计两个独立来源。
- user_opinion、inference、conflict 和 unknown 永远保持显式类型。
- 无 Claim 生成 insufficient 报告和 KnowledgeGap，不伪造事实。
- 普通多值 Predicate 不判冲突；只有相同 conflict_scope 的互斥位置形成 ConflictSet。

## 2. 真实 CLI E2E

使用编译后的 self 和一次性 data/test-runs Root：

1. 导入多个真实 Markdown Source。
2. 使用显式 test-only Fixture Provider 建 Graph/Claim。
3. 创建带 Scope、Alias 和 Exclude 的 Topic。
4. Build 并断言六类章节、局部 Graph、可信度和 Gap。
5. Trace Section 并逐条验证 Citation Hash 与完整证据链。
6. 无变化再 Build，断言新 Snapshot、相同 Hash、parent_section_id 和 unchanged。
7. 读取旧 Snapshot，直接 UPDATE 必须被不可变触发器拒绝。
8. 修改 Source 后 Topic stale；审核已纳入 Claim 后 needs_review。
9. 执行 Schema 7 -> 8 Plan/Apply 迁移并在迁移后创建 Topic。

## 3. 真实 Vault/Hosted Suite

只读接入的 notes 内容和模型原始响应只允许保存在忽略提交的 data/。提交型证据只记录：处理 Chunk 数、部分失败数、Claim/Section/Citation/Gap 数、可信度和 Hash 校验计数。

真实结构化模型响应不合格必须成为 per-Chunk failed，不得写半条 Claim；credential/network 错误必须中止。测试结束恢复 models.offline=true，并扫描 Root 确认没有 API Key 落盘。

## 4. 性能和查询计划

- topic show p95 目标 80ms。
- trace section p95 目标 120ms。
- Topic Build 是 Tier 5 慢任务，不把 Provider 延迟混入 SQLite 指标。
- EXPLAIN QUERY PLAN 必须验证 Topic ID、latest Snapshot、Snapshot Sections 和 Conclusion Citations 使用索引。

## 5. Phase 7 Gate

- 单元、Lint、Typecheck、大小检查和 SQLite Spike 通过。
- 历史 Phase 2.5 到 Phase 7 编译后二进制 E2E 全部通过。
- 每个 supported Conclusion 至少一条 Citation，全部 Hash 可重放。
- 多版本不可变、stale/needs_review、来源独立性和 Schema 迁移通过。
- 真实 Vault 仅输出脱敏聚合证据。

## 6. Phase 9 安全生命周期 Gate

- Topic Delete Plan 精确列出绑定 Artifact；Apply 原子软删除两者，但不修改 TopicSnapshot、Section、Conclusion、Citation 或历史 Build。
- Topic Restore 和 Operation Undo 恢复相同 Topic/Artifact ID 与精确 before 状态，版本单调递增，原 Operation/AuditEvent 保留。
- Claim 审核或证据失效使 Topic 进入 needs_review，并继续向 Artifact 传播 stale；相同幂等键不重复递增版本。
