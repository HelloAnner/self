# Self 项目指南

## 项目的灵魂

Self 不是另一个笔记软件，也不是“给 Obsidian 加一个聊天框”。它是面向 AI Agent 的个人知识操作系统：把一个人的全部资料持续摄入、理解、关联和重组，并针对具体主题生成有证据、有可信度、可持续更新的综合知识。

原始文档必须保留，但主要用于存证、追溯和重建。Self 真正操作的是将所有来源解析、切片、入库、向量化并构建图谱之后形成的统一知识底座。Markdown、HTML、图表和报告都是知识在特定问题下的可重建表达。

## 不可偏离的原则

1. **单目录**：一个 Self 实例的全部业务数据都在一个根目录内，可以整体移动、备份和恢复；Connection 可以只读外部 Target，但接纳的内容必须先归档回 Root。
2. **Local-first**：本地数据是权威数据；模型和云服务只是可替换的计算提供者。
3. **统一底座**：SQLite 是唯一结构化数据库，统一承载规范内容、FTS、向量、图谱和运行状态。
4. **全量摄入**：来源只有完成归档、解析、切片、索引、向量化和知识抽取后，才算真正进入 Self。
5. **证据优先**：任何重要结论都应能沿 `Claim → Chunk → Revision → Source` 回到原始证据。
6. **可信综合**：Topic 是一等对象，默认产物是跨来源、带可信度、冲突和未知项的综合报告。
7. **增量且可重建**：优先复用未变化内容；保留历史版本；增量结果必须能够收敛到全量重建结果。
8. **Agent-first**：CLI 首先是 Agent 的稳定协议，同时必须让人类能够理解和使用。
9. **安全修改**：高影响操作使用 Plan/Apply、版本检查、审计和可恢复删除。
10. **派生结果不是事实源**：未经确认的 AI 内容不能循环摄入并放大成事实。
11. **持续连接**：Connection 自动感知分散文件和目录的变化；watcher 只负责低延迟提示，定时扫描对账保证最终正确性。
12. **模型可换、空间不可偷换**：对话模型可按任务路由替换；Embedding 的 Model Revision、维度和输入规则构成不可变 VectorSpace，只能显式迁移、验证和切换。
13. **图谱必须有类型和证据**：文档链接、语义近邻、实体关系和 Claim 冲突必须分层保存；不能把知识图谱退化为没有来源的 `related_to` 边集合。

## 实现约束

- 采用模块化单体和领域边界，不因领域拆分而提前拆数据库或服务。
- 不允许业务数据、缓存或临时状态隐式写到 Self 根目录之外。
- 不允许 Agent 绕过领域规则直接修改 SQLite。
- 不静默覆盖人工笔记、原始资料、历史 Build 或旧 Revision。
- 新功能必须同时设计 CLI 契约、失败语义、增量路径、重建路径和真实测试。
- 关键功能使用真实 CLI 在一次性本地目录中做端到端测试，不能只依赖 mock 和单元测试。

## docs 文档索引

[`docs/README.md`](docs/README.md) 是文档总入口。开始工作前，先按任务类型读取对应文档，不要只依据代码猜测设计。

### 顶层设计文档

| 文档 | 内容 | 什么时候必须阅读 |
| --- | --- | --- |
| [`architecture.md`](docs/architecture.md) | 产品目标、单目录架构、核心数据流、对象模型和完整 CLI | 任何产品、架构、CLI 或跨领域变更 |
| [`design-conventions.md`](docs/design-conventions.md) | 规范术语、数据所有权、状态、ID、路径和文档同步矩阵 | 新增概念、状态、表、ID 或发现文档表述冲突 |
| [`technology-stack.md`](docs/technology-stack.md) | TypeScript、Bun、SQLite、AI、HTML 组件与版本 | 增加依赖、调整技术方案、构建或打包能力 |
| [`engineering-standards.md`](docs/engineering-standards.md) | 代码拆分、文件大小、实现红线、`self.toml`、运行和部署 | 编写或审查任何生产代码 |
| [`performance.md`](docs/performance.md) | 毫秒级交互、检索、HTML、后台任务和资源预算 | 修改查询、索引、Daemon、模型调用或 Artifact 性能 |
| [`model-selection.md`](docs/model-selection.md) | 对话模型路由、千问 Embedding、维度、向量空间和迁移 | 选择或更换模型、维度、指令和向量索引 |
| [`testing.md`](docs/testing.md) | 单目录真实 CLI 测试、故障恢复、性能和发布门禁 | 实现功能、修复数据缺陷或准备发布 |
| [`roadmap/README.md`](docs/roadmap/README.md) | 按日期和功能 Slug 版本化的 Roadmap 索引与执行规则 | 查找当前/历史计划或创建新迭代 Roadmap |
| [`2026-07-11-initial-implementation.md`](docs/roadmap/2026-07-11-initial-implementation.md) | 当前 Phase 0～11 的逐步实现、必读文档、检查和证据 | 开始代码实现、推进阶段或判断当日完成度 |
| [`domains/README.md`](docs/domains/README.md) | 领域地图、职责边界和数据所有权 | 任何涉及业务对象或 SQLite 表的变更 |

### 领域文档

| 领域 | 入口 | 负责内容 |
| --- | --- | --- |
| Workspace | [`domains/workspace/`](docs/domains/workspace/) | Self Root、配置、路径和能力发现 |
| Connection | [`domains/connection/`](docs/domains/connection/) | 外部文件/目录监控、扫描对账、变化批次和 Daemon |
| Source | [`domains/source/`](docs/domains/source/) | Blob、Snapshot 和证据归档 |
| Ingestion | [`domains/ingestion/`](docs/domains/ingestion/) | 解析、规范化、切片和摄入状态机 |
| Knowledge | [`domains/knowledge/`](docs/domains/knowledge/) | Document、Revision、Chunk、FTS 和向量 |
| Graph | [`domains/graph/`](docs/domains/graph/) | SQLite 图存储、文档链接、Entity、Relation、Claim、冲突和可信度 |
| Retrieval | [`domains/retrieval/`](docs/domains/retrieval/) | 混合检索、重排、证据上下文和引用 |
| Topic | [`domains/topic/`](docs/domains/topic/) | 跨来源综合、可信报告和增量刷新 |
| Artifact | [`domains/artifact/`](docs/domains/artifact/) | Page IR、Build、模板、HTML 和导出 |
| Model | [`domains/model/`](docs/domains/model/) | 模型注册、路由、调用和预算 |
| Automation | [`domains/automation/`](docs/domains/automation/) | CLI 协议、Plan/Apply、Job 和审计 |
| Operations | [`domains/operations/`](docs/domains/operations/) | Migration、验证、备份、恢复和 GC |

Connection 已有完整详细设计：

- [`model.md`](docs/domains/connection/model.md)：聚合、状态机和错误码
- [`schema.md`](docs/domains/connection/schema.md)：SQLite 表、索引、事务和保留策略
- [`workflows.md`](docs/domains/connection/workflows.md)：watcher、reconciliation、Daemon 和恢复流程
- [`commands.md`](docs/domains/connection/commands.md)：Connection/Daemon CLI 契约
- [`testing.md`](docs/domains/connection/testing.md)：真实文件系统、崩溃和平台测试矩阵

Graph 已有完整详细设计：

- [`model.md`](docs/domains/graph/model.md)：节点、关系层次、Predicate、Claim、Evidence 和状态
- [`schema.md`](docs/domains/graph/schema.md)：SQLite 邻接表、索引、SemanticNeighbor 和验证规则
- [`workflows.md`](docs/domains/graph/workflows.md)：文档链接、实体消歧、增量/全量重建和失效传播
- [`commands.md`](docs/domains/graph/commands.md)：Graph/Entity/Relation/Claim CLI 和错误语义
- [`testing.md`](docs/domains/graph/testing.md)：图不变量、证据、重建等价和性能测试

### 按任务阅读

- 修改 CLI：读 Architecture CLI、Automation、相关领域 commands 和 Testing。
- 修改数据库：读 Design Conventions、相关领域 schema、Engineering Standards 和 Migration 测试。
- 修改数据源或自动同步：读 Connection、Source、Ingestion 三个领域，不要把职责混在一起。
- 修改对话/Embedding/Reranker：先读 Model Selection，再读 Model、Knowledge、Retrieval、Performance 和 Testing。
- 修改图谱或可信度：读 Graph 全套详细设计、Model、Retrieval、Topic 及引用规则。
- 修改 HTML：读 Topic、Artifact、Technology Stack 和浏览器测试。
- 修改构建、配置或部署：读 Technology Stack、Engineering Standards 和 Operations。

### 文档同步规则

新增领域、命令、状态、表、配置或部署方式时，按 [`design-conventions.md`](docs/design-conventions.md) 的同步矩阵更新所有受影响文档。实现选择与现有原则冲突时，应先写清取舍并更新设计；禁止在代码中悄悄改变 Self 的核心方向。
