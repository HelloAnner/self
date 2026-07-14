# Topic SQLite Schema

> 实现版本：Schema 8，迁移文件 drizzle/0008_topic_synthesis.sql

## 1. 表所有权

| 表 | 用途 |
| --- | --- |
| topics | Topic 聚合、版本、状态和 latest 指针 |
| topic_aliases | 规范化别名 |
| topic_synthesis_runs | 构建输入、水位、规则、状态和耗时 |
| topic_snapshots | 不可变知识/报告快照 |
| topic_snapshot_claims | Claim 聚类、角色、来源独立性和可信解释 |
| topic_snapshot_nodes / topic_snapshot_relations | 本次报告的局部 Graph |
| topic_report_outlines | 稳定章节大纲 |
| topic_report_sections | 章节、父章节、Hash 和 change_kind |
| topic_report_conclusions | 原子结论类型与支持状态 |
| topic_report_citations | Conclusion 到 Claim/Chunk/Revision/Snapshot/Source 的映射 |
| topic_knowledge_gaps | 明确未知问题及关联 Claim |

这些表只有 Topic 领域写入。Retrieval Context 和 Graph Claim 仍由各自领域拥有；Topic 只保存稳定 ID 和不可变投影。

## 2. 关键约束

- Topic name 在未删除对象中规范化唯一。
- Topic version 必须为正；Scope/Alias 变更递增 version。
- 一个 Topic 的 Snapshot sequence 唯一且单调递增。
- Snapshot、Section 和 Citation Hash 均为 64 位 SHA-256 十六进制。
- 所有 JSON 列使用 json_valid CHECK。
- ConclusionType、Confidence、Health、Role 和 ChangeKind 使用有限 CHECK 集合。
- TopicSnapshot、SnapshotClaim、Section、Conclusion 和 Citation 配置 UPDATE/DELETE 拒绝触发器。
- Citation 同时外键到 Claim、Chunk、Revision、Source、SourceSnapshot 和 Blob。

## 3. 热点索引

- topics(status, updated_at DESC)
- topics(latest_snapshot_id)
- topic_snapshots(topic_id, sequence DESC)
- topic_synthesis_runs(topic_id, created_at DESC)
- topic_snapshot_claims(claim_id, topic_snapshot_id)
- topic_snapshot_claims(topic_snapshot_id, cluster_key, conclusion_type)
- topic_report_sections(topic_snapshot_id, ordinal)
- topic_report_citations(conclusion_id, claim_id)
- topic_report_citations(chunk_id, conclusion_id)

topic show、latest report、Section Trace 和 Claim 影响传播必须使用点查/索引，不能加载所有 Topic。

## 4. 写事务

完整 Build 分为两段：Retrieval 先原子发布 RetrievalRun/EvidenceContext；Topic 再创建 running SynthesisRun，并在一个短事务中写 Snapshot、Claim 投影、局部 Graph、Report、Gap，完成 SynthesisRun，最后切换 latest。

若 Topic version 在综合期间变化，事务返回 topic_version_conflict，不切换 latest。失败 SynthesisRun 保存安全错误码；已有 Snapshot 继续服务。

## 5. 迁移

Schema 7 到 8 必须通过 migration plan/apply；Apply 前在 Root/runtime/migrations/backups 创建数据库备份。迁移只新增 Topic 表和触发器，不修改历史 Retrieval/Graph 数据。
