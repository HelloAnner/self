# Self 领域模型

领域拆分的目标不是建立多个服务，而是在一个本地 CLI 和一个 SQLite 数据库中形成清晰的职责边界。第一阶段采用模块化单体：领域之间通过应用服务和稳定事件协作，不直接修改其他领域拥有的数据。

## 领域关系

```text
Workspace
   │
   ▼
Connection ──→ Source ──→ Ingestion ──→ Knowledge ──┬──→ Retrieval ──→ Topic ──→ Artifact
                                                    │         ▲          ▲
                                                    └──→ Graph┘          │
                                                                         │
Model ────────────────── 为摄入、图谱、检索、Topic 提供模型能力 ──────────┘

Automation ───── 对外提供 CLI、Plan、Job 和审计协议
Operations ───── 为全部领域提供迁移、校验、备份与恢复
```

## 领域目录

| 领域 | 子目录 | 核心职责 |
| --- | --- | --- |
| Workspace | [`workspace/`](./workspace/) | 单目录实例、`self --init`、配置、组件自检、路径和能力发现 |
| Connection | [`connection/`](./connection/) | 外部文件/目录持续监控、扫描对账、变化批次和后台进程 |
| Source | [`source/`](./source/) | 外部来源、内部快照和同步生命周期 |
| Ingestion | [`ingestion/`](./ingestion/) | 解析、规范化、切片和摄入状态机 |
| Knowledge | [`knowledge/`](./knowledge/) | Document、Revision、Chunk、全文索引和向量空间 |
| Graph | [`graph/`](./graph/) | SQLite 图存储、文档链接、Entity、Relation、Claim、冲突和可信度 |
| Retrieval | [`retrieval/`](./retrieval/) | 混合召回、过滤、重排、证据链和问答上下文 |
| Topic | [`topic/`](./topic/) | 主题边界、跨来源综合、可信报告和增量刷新 |
| Artifact | [`artifact/`](./artifact/) | Page IR、Build、模板、渲染、HTML 和导出 |
| Model | [`model/`](./model/) | 模型注册、路由、调用策略、成本和可复现记录 |
| Automation | [`automation/`](./automation/) | CLI 协议、Plan/Apply、Job、Operation 和审计 |
| Operations | [`operations/`](./operations/) | 数据库迁移、验证、备份、恢复、GC 和诊断 |

## 领域协作规则

1. 每个聚合和数据库表只有一个领域拥有写权限。
2. 领域可以读取公开投影，不得直接依赖其他领域的内部表结构。
3. 跨领域写入由应用层编排，并记录 Operation 和领域事件。
4. 所有事件都携带稳定 ID、对象版本、时间和因果操作 ID。
5. 派生数据必须能从证据层和规范数据重建。
6. 删除使用 tombstone 和影响分析；永久清理由 Operations 统一执行。
7. 初期不拆业务服务、不拆数据库；CLI 和可选 Daemon 使用同一二进制与领域实现。只有明确的性能或隔离证据才能改变部署边界。

## 每个领域后续文档建议

领域进入详细设计时，可按需增加：

```text
README.md          # 领域概要和当前状态
model.md           # 聚合、实体、值对象和不变量
schema.md          # SQLite 表、索引和迁移
commands.md        # 命令、应用服务和错误语义
events.md          # 领域事件及订阅关系
workflows.md       # 关键状态机和时序
testing.md         # 单元、集成、Golden 和恢复测试
decisions/         # 本领域 ADR
```
