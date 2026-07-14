# Topic 领域

> 状态：Phase 7 可信综合、Phase 8 增量 Artifact、Phase 9 安全生命周期与 Phase 10 durable Job 已实现

## 目标

Topic 把长期关注的主题维护成持续生长、跨来源、有证据和可信度的综合报告，而不是一次性搜索结果。Topic 读取 Retrieval 的证据上下文和 Graph 的 Claim 投影，但不取得它们的写入权。

## 已实现边界

- Topic 范围、别名、排除条件、对象版本和 stale 状态
- SynthesisRun、不可变 TopicSnapshot、数据水位和父版本
- 候选 Claim 聚类、局部图谱、来源谱系去重和转载折叠
- 多源共识、单一来源、用户观点、AI 推断、冲突和未知分类
- ReportOutline、ReportSection、Conclusion、Citation 和 KnowledgeGap
- 章节/报告可信度、覆盖度、健康状态及解释
- 首次完整 topic build、历史版本、指定 Snapshot 报告读取和 Section Trace
- Knowledge/Graph 变化后的 stale 与 Claim 审核后的 needs_review
- Source/Graph/Claim 变化的精确依赖失效，以及 Topic/绑定 Artifact 的 Plan delete/restore 和 Operation 审计
- Build/Refresh 通过 Schema 11 durable Job 提供 detach/wait、checkpoint、取消和 retry

## 详细设计

- [model.md](./model.md)：聚合、状态、结论类型、可信度和不变量
- [schema.md](./schema.md)：Schema 8 表、索引、不可变触发器和事务
- [workflows.md](./workflows.md)：首次 Build、版本构建、失效和恢复
- [commands.md](./commands.md)：Phase 7 CLI 契约与错误语义
- [testing.md](./testing.md)：单元、真实 CLI、真实 Vault 和性能 Gate

## 不负责

- HTML、CSS、Page IR 和 Artifact Build
- 底层检索算法与 Claim 所有权
- MCP/HTTP 等 Phase 11 外部 Agent 入口
