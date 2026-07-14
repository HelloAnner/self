# Self 设计文档

本目录保存 Self 的产品、架构、领域模型和实施路线。所有设计先明确领域边界和不变量，再进入数据库表、接口及代码实现。

## 文档入口

- [总体架构](./architecture.md)：产品理念、单目录架构、知识模型、CLI 和可靠性约束。
- [设计约定](./design-conventions.md)：跨文档术语、数据所有权、状态、ID 和同步规则。
- [技术选型](./technology-stack.md)：TypeScript、Bun、SQLite、AI、HTML 和工程配置基线。
- [工程规范](./engineering-standards.md)：代码实现、架构红线、运行配置、构建和部署规范。
- [性能边界](./performance.md)：毫秒级交互预算、后台任务边界、检索与 HTML 性能门禁。
- [模型选择](./model-selection.md)：对话模型职责、千问 Embedding、维度、VectorSpace 与安全迁移。
- [开源分发与初始化](./distribution.md)：npm 平台包、全新环境、`self --init`、升级、卸载和供应链安全。
- [Roadmap 索引](./roadmap/README.md)：按 `YYYY-MM-DD-<description>.md` 管理当前与历史实现计划。
- [当前实现路线图](./roadmap/2026-07-11-initial-implementation.md)：Phase 0～11 的逐步实现、阶段必读、检查命令和验收证据。
- [测试机制](./testing.md)：单目录真实 CLI 测试、测试框架、功能矩阵和发布门禁。
- [ADR 索引](./adr/README.md)：运行时、SQLite 分发、包命名、License 和版本契约决策。
- [跨领域契约](./contracts/identity-events-errors.md)：稳定 ID、事件 envelope、错误与退出码。
- [领域模型](./domains/README.md)：各领域的职责、数据所有权及依赖关系。

当前已经完成详细设计的领域：

- [Workspace Initialization](./domains/workspace/initialization.md)：交互式引导、系统/组件/模型自检、恢复与非交互 Spec。
- [Connection](./domains/connection/)：动态文件/目录连接、SQLite 表、扫描对账、Daemon、CLI 和测试矩阵。
- [Graph](./domains/graph/)：SQLite 图存储、节点/关系/Claim/Evidence、增量重建、CLI 和测试矩阵。
- [Model](./domains/model/)：Embedding/结构化 Chat Provider、Model/Invocation、凭证边界、漂移和测试。
- [Retrieval](./domains/retrieval/)：FTS/Vector/Graph、EvidenceContext、Ask/Related/Trace、引用门禁和失效。
- [Topic](./domains/topic/)：TopicSnapshot、可信综合、来源独立性、Section Trace 和增量 Refresh。
- [Artifact](./domains/artifact/)：Page IR v1、Build/Manifest、离线 HTML、History/Diff/Export 和安全渲染。
- [Automation](./domains/automation/)：Schema 10 Plan/Apply 与 Schema 11 durable Job、checkpoint、取消、重试和事件流。

当前实现基线：

- [Workspace Model](./domains/workspace/model.md) 与 [Schema](./domains/workspace/schema.md)。
- [Automation CLI Contract](./domains/automation/commands.md)。
- [SQLite/FTS5/sqlite-vec Spike](./domains/knowledge/sqlite-vector-spike.md)。
- [Workspace Initialization](./domains/workspace/initialization.md) 的 Phase 1 Root/Setup 切片。
- [Operations Migration](./domains/operations/migrations.md) 的数据库版本与兼容模式。
- [Source](./domains/source/) 的 Blob/Snapshot 证据归档、增量 Diff 和软删除生命周期。
- [Ingestion](./domains/ingestion/) 与 [Knowledge](./domains/knowledge/) 的 Parser、Revision/Chunk、FTS Generation、VectorSpace 和 Note。
- [Retrieval](./domains/retrieval/) 的 text/vector/hybrid Search Alpha 与真实 Vault 性能基线。
- [Graph](./domains/graph/) 的 Schema 6、Entity/Relation/Claim/Evidence/Conflict、Generation、可信度和真实 Vault 基线。
- [Retrieval](./domains/retrieval/) 的 Schema 7、带证据回答、引用回映、上下文重放和真实 Vault Hosted Ask 基线。
- [Topic](./domains/topic/) 的 Schema 8 可信综合、[Artifact](./domains/artifact/) 的 Schema 9 Page IR/离线 HTML、[Automation](./domains/automation/) 的 Schema 10 安全修改，以及 [Operations](./domains/operations/) 的 Schema 11 Job/Backup/Verify/GC。

## 文档约定

- 一个领域对应 `domains/` 下的一个子文件夹。
- 每个领域以 `README.md` 作为入口，后续详细设计继续放在同一子文件夹中。
- 跨领域决策写入总体架构或单独的 ADR，不在多个领域中复制不同版本。
- SQLite 可以是一个物理文件，但表、事务和业务规则必须有唯一的领域所有者。
- 文档中的命令、对象状态和 ID 前缀应与 CLI 契约保持一致。
