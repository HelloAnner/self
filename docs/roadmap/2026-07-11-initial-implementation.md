# Self 2026-07-11 初始实现路线图

> 日期：2026-07-11
> Slug：`initial-implementation`
> 状态：active
> Parent：无，首个实现 Roadmap
> 当日意图：按依赖顺序完成 Phase 0～11；只有存在验收证据的项目才能标记完成。
> 排序原则：先建立可信、可迁移的数据底座，再增加 AI 综合能力；每个阶段都必须形成可运行、可验证的纵向闭环。

## 如何执行今天的 Roadmap

每个阶段严格执行 `Read → Implement → Verify → Evidence → Gate`：

1. **Read**：阅读阶段表中列出的 Markdown，确认对象、状态、Schema、CLI 和红线。
2. **Implement**：只实现该阶段范围，代码遵守模块边界和文件大小限制。
3. **Verify**：运行单元、数据库集成、真实 CLI、恢复和性能检查。
4. **Evidence**：将命令、结果摘要、失败信息和性能数据保存到 `.test-runs/roadmap/2026-07-11/<phase>/`。
5. **Gate**：阶段验收标准全部满足后，才进入下一阶段。

状态更新规则：

```text
pending → in_progress → completed
                   └──→ blocked
```

- 今天计划完成全部阶段，但不允许因为日期结束而把未验证项标记为 completed。
- 未完成项进入下一份 `YYYY-MM-DD-<description>.md`，并保留本文件中的真实状态。
- 一个时间只实现一个最小纵向切片；后台测试可以并行，但不能同时改变多个未稳定领域的核心 Schema。

## 开始实现前必读

按顺序阅读：

1. [`AGENTS.md`](../../AGENTS.md)：项目灵魂、不可偏离原则和文档路由。
2. [`architecture.md`](../architecture.md)：产品边界、核心对象、数据流和完整 CLI。
3. [`design-conventions.md`](../design-conventions.md)：术语、数据所有权、状态、ID 和路径。
4. [`technology-stack.md`](../technology-stack.md)：TypeScript、Bun、SQLite 和依赖基线。
5. [`engineering-standards.md`](../engineering-standards.md)：代码拆分、配置、构建、部署和红线。
6. [`testing.md`](../testing.md)：真实 CLI、单目录、恢复和 Release 测试。
7. [`performance.md`](../performance.md)：交互延迟、后台任务和资源预算。

## 阶段阅读矩阵

| 阶段 | 实现前必须阅读 | 主要检查 |
| --- | --- | --- |
| Phase 0 | [`distribution.md`](../distribution.md)、Technology Stack、Engineering Standards、Design Conventions、Testing | License/npm Scope、Runtime/平台包、项目骨架、测试基座 |
| Phase 1 | Architecture CLI、[`workspace/`](../domains/workspace/)、[`initialization.md`](../domains/workspace/initialization.md)、[`automation/`](../domains/automation/)、[`operations/`](../domains/operations/) | `self --init`、Root、组件/模型自检、SQLite、JSON 契约 |
| Phase 2 | [`source/`](../domains/source/)、Workspace、Automation | Blob/Snapshot、来源模式、证据不可变 |
| Phase 2.5 | [`connection/README.md`](../domains/connection/README.md)、[`model.md`](../domains/connection/model.md)、[`schema.md`](../domains/connection/schema.md)、[`workflows.md`](../domains/connection/workflows.md)、[`commands.md`](../domains/connection/commands.md)、[`testing.md`](../domains/connection/testing.md) | Watch/Scan、Lease、ChangeBatch、崩溃恢复 |
| Phase 3 | [`ingestion/`](../domains/ingestion/)、[`knowledge/`](../domains/knowledge/)、Source、Testing | NormalizedDocument、Revision、Chunk、增量等价 |
| Phase 4 | [`model-selection.md`](../model-selection.md)、[`model/`](../domains/model/)、[`retrieval/`](../domains/retrieval/)、Knowledge、Performance | FTS、VectorSpace、迁移、Hybrid Search |
| Phase 5 | [`graph/README.md`](../domains/graph/README.md)、[`model.md`](../domains/graph/model.md)、[`schema.md`](../domains/graph/schema.md)、[`workflows.md`](../domains/graph/workflows.md)、[`commands.md`](../domains/graph/commands.md)、[`testing.md`](../domains/graph/testing.md) | 文档链接、Entity、Relation、Claim、GraphGeneration |
| Phase 6 | Retrieval、Graph、Model、Architecture Ask/Trace CLI | EvidenceContext、Citation、未知与冲突 |
| Phase 7 | [`topic/`](../domains/topic/)、Retrieval、Graph、Model | TopicSnapshot、可信综合、增量影响 |
| Phase 8 | [`artifact/`](../domains/artifact/)、Topic、Technology Stack、Performance、Testing | Page IR、HTML、归档、离线与增量 Render |
| Phase 9 | Automation、所有被修改对象的领域文档、Design Conventions | Plan/Apply、版本冲突、软删除、Undo |
| Phase 10 | Operations、Engineering Standards、Testing、Performance | Job、Backup、Restore、Migration、GC、Release |
| Phase 11 | Automation、Architecture、Technology Stack、Engineering Standards | MCP/HTTP/插件复用 Application Service |

## 今日执行看板

| Workstream | 当前状态 | Exit Gate | 验收证据目录 |
| --- | --- | --- | --- |
| W0 / Phase 0 | completed | 编译、类型、SQLite/FTS/vec Spike、MIT License 与本机 npm Package Spike 通过 | `phase-0/` |
| W1 / Phase 1 | completed | `init/status/config/doctor/version` 真实 CLI 通过 | `phase-1/` |
| W2 / Phase 2 | completed | Source → Blob → Snapshot 证据闭环 | `phase-2/` |
| W2.5 / Phase 2.5 | completed | 文件变化自动归档且 Daemon 可恢复 | `phase-2-5/` |
| W3 / Phase 3 | completed | Snapshot → Revision → Chunk 可增量重建 | `phase-3/` |
| W4 / Phase 4 | completed | FTS/Vector/Hybrid Search Alpha 通过 | `phase-4/` |
| W5 / Phase 5 | completed | Graph/Claim 证据和重建等价通过 | `phase-5/` |
| W6 / Phase 6 | completed | Ask 每个事实可 Trace | `phase-6/` |
| W7 / Phase 7 | completed | Topic 可信综合报告可版本化 | `phase-7/` |
| W8 / Phase 8 | completed | Page IR → HTML 离线/历史/增量通过，MVP Gate 完成 | `phase-8/` |
| W9 / Phase 9 | completed | Plan/Apply/Delete/Restore/Undo 安全通过 | `phase-9/` |
| W10 / Phase 10 | in_progress | 实现与本机 RC Gate 已通过；待 24h Soak、跨平台 CI 和外部发布确认 | `phase-10/` |
| W11 / Phase 11 | pending | CLI/MCP/HTTP 契约一致 | `phase-11/` |

## 可恢复执行检查点

> 最后更新：2026-07-14，Phase 10 实现、Schema 11、本机 v1.0.0 RC Gate 与真实 notes 备份恢复验收完成后。
>
> **恢复指针：不要重复 Phase 0～9，也不要重做 Phase 10 主体实现。当前停在 Phase 10 发布资格收口：代码、本机 Crash/Backup/Restore/Release Gate 和真实 notes 演练已通过；下一步须经用户确认后执行 24h Soak、GitHub 跨平台 Release Workflow，并在确认 npm Scope/Trusted Publisher 后决定是否公开发布 v1.0.0。上述资格项通过前不把 W10 标记 `completed`，也不进入 Phase 11。**

| 阶段 | 状态与已经交付的稳定边界 | 验证/恢复依据 | 后续不得误判为已完成的内容 |
| --- | --- | --- | --- |
| Phase 0 | `completed`：Bun/TypeScript/SQLite 基线、FTS5/sqlite-vec Spike、MIT、构建与本机分发骨架 | `.test-runs/roadmap/2026-07-11/phase-0/` | 跨平台 Release Suite 属于 Phase 10 |
| Phase 1 | `completed`：单目录 Root、Schema 1、Init/Resume/Rollback、配置、Doctor、迁移 Plan/Apply 骨架和稳定 CLI envelope | `.test-runs/roadmap/2026-07-11/phase-1/` | 通用 Job/Backup/GC 属于 Phase 10 |
| Phase 2 | `completed`：Schema 2、Source/Blob/Snapshot、Diff、证据去重、ChangeBatch Receipt、真实文件/目录/Obsidian/stdin/web 归档 | `.test-runs/roadmap/2026-07-11/phase-2/` | Parser/Revision/Chunk 属于 Phase 3 |
| Phase 2.5 | `completed`：Schema 3、Connection reconciliation、ChangeBatch 自动归档、watcher 提示、Daemon Lease、崩溃恢复和 Rebind | `.test-runs/roadmap/2026-07-11/phase-2-5/` | ChangeItem 已由 Phase 3 继续推进到 `ingested` |
| Phase 3 | `completed`：Schema 4、五类 Parser、NormalizedDocument、Document/Revision/Chunk、lineage、崩溃恢复、Note 版本和增量/全量等价 | `.test-runs/roadmap/2026-07-11/phase-3/`；合成运行根位于忽略提交的 `data/test-runs/phase-3-real-cli/` | FTS、Embedding 和 VectorSpace 属于 Phase 4 |
| Phase 4 | `completed`：Schema 5、trigram FTS Generation、Model/Invocation、VectorSpace/Embedding、Query Cache、text/vector/hybrid Search、迁移回滚和 Provider 降级 | `.test-runs/roadmap/2026-07-11/phase-4/`；合成/Live Root 均位于忽略提交的 `data/` | Graph/Claim 与 Graph fallback 属于 Phase 5；通用 Job 属于 Phase 10 |
| Phase 5 | `completed`：Schema 6、GraphGeneration、GraphNode/Predicate、Entity/Alias/Redirect、Relation/Claim/Evidence、Conflict/Confidence、显式链接、SemanticNeighbor、有界遍历和三种导出 | `.test-runs/roadmap/2026-07-11/phase-5/`；合成、真实 Vault 与 Live Model Root 均在忽略提交的 `data/` | Ask/related/trace 与回答引用校验属于 Phase 6；通用 Job 属于 Phase 10 |
| Phase 6 | `completed`：Schema 7、RetrievalPlan/Run、Graph Claim 扩展、最小 EvidenceContext、Answer/Statement/Citation、引用原文回映、标准未知/冲突、Ask/Related/Trace、失效与上下文重放 | `.test-runs/roadmap/2026-07-11/phase-6/`；合成与真实 `~/notes`/Hosted Model Root 均在忽略提交的 `data/` | Topic、TopicSnapshot、跨章节可信综合和增量报告属于 Phase 7；精确依赖失效可在保持正确性的前提下优化 |
| Phase 7 | `completed`：Schema 8、Topic/Scope/Alias、SynthesisRun、不可变 TopicSnapshot、Claim 聚类、来源谱系去重、局部 Graph、六类结论、Outline/Section/Conclusion/Citation、KnowledgeGap、可信度/覆盖度/健康状态、History、Section Trace 与 stale/needs_review | `.test-runs/roadmap/2026-07-11/phase-7/`；合成和真实 notes/Hosted Graph/Topic Root 均在忽略提交的 data/ | Page IR、Artifact Build、HTML、export/diff 和受影响章节增量 topic refresh 属于 Phase 8；通用 detached Job 属于 Phase 10 |
| Phase 8 | `completed`：Schema 9、Page IR v1、Template/Theme、Artifact/Build/Manifest、ready 不可变、完整归档、组件缓存、增量 Refresh、纯 Render、离线多/单文件 HTML、History/Diff/Open 与 HTML/Markdown/JSON Export；MVP 已达到 | `.test-runs/roadmap/2026-07-11/phase-8/`；合成浏览器 Root 与真实 `~/notes` Artifact Root 均在忽略提交的 `data/` | Topic/Artifact 安全删除、Restore、Undo 与依赖影响 Plan 属于 Phase 9；持久化 detached Job 属于 Phase 10 |
| Phase 9 | `completed`：Schema 10、不可变 Plan/Target/OperationChange/AuditEvent、幂等、版本冲突、逐项原子结果、Source/Connection/Note/Graph/Topic/Artifact 安全生命周期、精确恢复、Undo 与零引用 Purge | `.test-runs/roadmap/2026-07-11/phase-9/`；合成 Root 与真实 `~/notes` 只读 Plan/Scan 均位于忽略提交的 `data/` | 持久化 Job、Workspace Backup/Restore、深度 Verify、GC、Crash Matrix 和 Release Suite 属于 Phase 10；对象 Restore 不等同于 Workspace Restore |
| Phase 10 | `in_progress`：主体实现完成，CLI v1.0.0 / Schema 11 RC 已具备持久化 Job、Workspace Backup/Restore、Deep Verify、引用证明 GC、维护锁/WAL 恢复、迁移原子替换和 Release 产物 | `.test-runs/roadmap/2026-07-11/phase-10/`；合成 Crash Matrix、本机 darwin-arm64 Clean Machine Gate 与真实 `~/notes` 324 MB 备份恢复均通过 | 24h Soak、GitHub 五平台实际 CI、Trusted Publisher/npm Scope 确认和外部发布尚未执行；这四项完成前不称公开 v1.0，不进入 Phase 11 |

每次阶段 Gate 后必须同步本表、上方执行看板、对应阶段的“实现证据”小节和证据目录。若工作中断，以“恢复指针”和首个 `pending` 阶段为准，不根据未提交代码猜测进度。

## 每个阶段必须留下的证据

```text
.test-runs/roadmap/2026-07-11/<phase>/
├── summary.md             # 完成范围、结论、已知限制
├── commands.jsonl         # 实际执行命令、退出码和持续时间
├── tests/                 # JUnit/JSON 测试结果
├── fixtures.json          # Fixture 版本和 Hash
├── root-tree.txt          # 临时 Self Root 最终目录结构
├── verify.json            # self verify/doctor 结果
├── performance.json       # 适用阶段的 p50/p95/资源数据
└── failures/              # 失败场景和恢复证据；无失败则为空
```

这些目录包含测试数据，默认不提交私人内容。提交仓库的只应是脱敏摘要、Golden 和必要 Fixture。

## 1. 路线图目标

Self 的第一条完整价值链是：

```text
初始化单目录实例
  → 接入文件、目录、Obsidian 和网页
  → 保存内部证据快照
  → 解析、切片并写入 SQLite
  → 建立 FTS、向量和知识图谱
  → 带证据地检索和问答
  → 跨来源生成可信 Topic 报告
  → 渲染并归档 HTML
  → 新资料进入后增量更新
```

本文件是 2026-07-11 的执行计划。顺序由硬依赖决定；每个阶段只有满足验收标准后才能成为下一阶段的稳定基础。日期表达计划归档时间，不降低完成门槛。

## 2. 里程碑概览

| 阶段 | 里程碑 | 可交付能力 |
| --- | --- | --- |
| Phase 0 | 技术与契约基线 | 技术选型、ADR、领域边界和测试基座 |
| Phase 1 | Self 实例可运行 | 单目录、SQLite、配置、CLI 和 JSON 协议 |
| Phase 2 | 来源可归档 | 文件、目录、Vault、网页快照和同步状态 |
| Phase 2.5 | 动态连接可运行 | 外部目录/文件监控、后台扫描、变化批次和自动归档 |
| Phase 3 | 信息完整入库 | 解析、规范化、Chunk、Revision 和增量摄入 |
| Phase 4 | 本地检索可用 | FTS、sqlite-vec、混合搜索和证据回溯 |
| Phase 5 | 图谱与可信知识 | Entity、Relation、Claim、冲突和可信度 |
| Phase 6 | 带证据问答 | Ask、引用校验、检索解释和知识边界 |
| Phase 7 | Topic 综合报告 | 跨来源综合、未知项、冲突和报告版本 |
| Phase 8 | 增量 HTML | Page IR、模板、构建归档、Diff 和导出 |
| Phase 9 | 安全知识维护 | Plan/Apply、修改、删除、恢复和审计 |
| Phase 10 | 长期可靠运行 | Job、备份、恢复、迁移、校验和 GC |
| Phase 11 | Agent 生态入口 | MCP、HTTP API、Obsidian 插件和扩展机制 |

建议版本节点：

- **Developer Preview**：完成 Phase 3，可以可靠摄入并检查数据库。
- **Search Alpha**：完成 Phase 4，可以作为个人本地语义搜索工具使用。
- **Knowledge Alpha**：完成 Phase 6，可以进行带证据问答。
- **MVP**：完成 Phase 8，可以生成并增量维护可信 HTML 专题报告。
- **v1.0**：完成 Phase 10，具备安全修改和长期维护能力。

## 3. Phase 0：技术与契约基线

### 目标

在写业务实现前冻结最小但关键的技术边界，避免后续因为语言、SQLite 扩展或 ID 规则反复重做。

### 工作项

- 按 [`technology-stack.md`](../technology-stack.md) 落地 TypeScript 7、Bun 1.3.14 和模块化单体基线。
- 验证目标平台上的 SQLite、FTS5 和 sqlite-vec 集成方式。
- 决定 SQLite 扩展采用静态链接还是随实例分发。
- 定义稳定 ID 格式：`source:`、`chunk:`、`claim:`、`topic:` 等。
- 定义数据库格式版本、CLI 协议版本和 Page IR 版本策略。
- 明确时间、内容哈希、相对路径和字符编码规范。
- 建立 ADR 目录和决策模板。
- 建立单元测试、集成测试、Golden 测试和端到端测试框架。
- 为各领域确定代码模块位置，保持同一模块化单体二进制和单数据库，不拆业务服务。
- 决定 OSI License 和 npm Scope，建立 npm Meta/Platform Package 与 Clean Machine Spike。

### 必须产出的设计

- Workspace `model.md` 和 `schema.md`
- Automation `commands.md`
- Knowledge 的 SQLite/FTS/sqlite-vec 技术验证记录
- 跨领域 ID、事件和错误码规范

### 验收标准

- CI 能在主要目标平台构建空 CLI。
- SQLite 能创建 FTS 表并完成一次向量插入与近邻查询。
- `self version --json` 能返回 CLI、数据库和协议版本。
- 所有关键技术选择都有 ADR，不依赖口头约定。
- npm Meta Package 能在无 Bun 的干净环境定位并运行本机 Platform Binary。

## 4. Phase 1：单目录实例与 CLI 骨架

### 涉及领域

- Workspace
- Automation
- Operations（最小迁移能力）

### 工作项

- 实现 `self init <DIR>`、Init Journal、Resume 和 Rollback。
- 实现 `self --init` 交互式 System Preflight、Root、来源、模型、VectorSpace、首次索引和最终 Doctor。
- 创建标准目录、`self.toml` 和 `data/self.sqlite3`。
- 实现实例根目录向上发现和 `--root`。
- 建立迁移表、事务包装、WAL、外键和 `busy_timeout`。
- 实现命令注册、帮助、Shell completion 和机器可读命令 Schema。
- 实现统一 JSON envelope、错误码和退出码。
- 实现稳定 ID、Operation ID 和 Request ID。
- 实现 `self status`、`self system`、`self component`、`self capability`、`self config`、`self doctor` 和脱敏 Diagnostics 的最小版本。
- 确保程序不会向实例根目录外写入业务数据。

### 验收标准

- 整个实例目录复制到另一个路径后仍可打开。
- 初始化已有非空目录不会覆盖未知文件。
- 人类输出和 `--json` 输出都通过 Golden 测试。
- 不兼容数据库版本会进入只读诊断模式，而不是尝试写入。
- Offline 和 Hosted Setup 均能取消/恢复；模型测试失败不会破坏已完成 Workspace。

## 5. Phase 2：Source 与证据归档

### 涉及领域

- Source
- Workspace
- Automation

### 工作项

- 实现单文件、目录和 stdin 数据源。
- 实现 Markdown 目录和 Obsidian Vault 识别。
- 实现网页单页快照；站点递归抓取延后到本阶段末尾。
- 实现 `import`、`snapshot`、`mirror` 模式。
- 使用 SHA-256 建立 Blob 内容寻址存储和去重。
- 保存 Snapshot、SourceSpec、内容哈希和内部相对路径；持续扫描 Cursor 由 Connection 拥有。
- 实现 include/exclude、递归扫描和基础 ignore 规则。
- 实现 `source list/show/status/sync/retry/delete/restore`；持续监控暂停由 Connection 管理。
- 提供 Connection 接纳变化批次所需的 Source Workflow 和幂等接口。
- 为外部数据记录获取时间、原始 URL、MIME 和哈希。

### 验收标准

- 同一文件重复导入不会产生重复 Blob。
- 修改一个文件只产生新的 Snapshot，不修改旧 Snapshot。
- 外部原文件删除后，Self 内部证据仍然完整。
- mirror 模式的每次同步都能说明新增、修改和删除了什么。
- 网页内容可以在离线状态下查看内部快照。

## 6. Phase 2.5：Connection 动态监控与自动归档

### 涉及领域

- Connection
- Source
- Automation
- Operations（Daemon Lease 与诊断）

### 工作项

- 实现 DataConnection、Target、ScanPolicy 和 FilterPolicy。
- 建立 `data_connections`、Observation、ScanRun、ChangeBatch 和 ChangeItem 表。
- 支持监控单文件、本地目录、项目 docs 和 Obsidian Vault。
- 先实现手工 `connection scan` 和 polling reconciliation。
- 使用 metadata 快速比较与 SHA-256 完整 Hash 识别真实变化。
- 实现 created、modified、deleted、renamed 和 restored 分类。
- 实现防抖、写入稳定窗口、删除 Grace Period 和批次幂等。
- 实现原生 watcher，并明确它只提供低延迟提示。
- 实现 Root 内 Connection Daemon、文件锁、SQLite Lease 和心跳。
- 将可靠 ChangeBatch 交给 Source 归档并触发 Ingestion。
- 实现 `connection list/status/events/watch/scan/pause/resume/rebind`。
- 实现 `daemon run/start/status/stop/logs`。
- 对路径不可用、磁盘卸载和权限失败使用 degraded，不产生虚假删除。

### 验收标准

- 修改任意已连接项目中的 Markdown 后，无需手工 sync 即可自动归档和增量摄入。
- 原生 watcher 丢失事件后，定时 reconciliation 仍收敛到正确状态。
- 目录暂时消失不会导致批量删除知识。
- 相同变化重试不会产生重复 Snapshot、Chunk 或 ChangeItem。
- 同一个 Self Root 同时只有一个 active Daemon Leader。
- Daemon 崩溃后可以恢复未完成 Scan 和 Batch。
- Connection 读取外部路径，但全部归档、日志、锁和状态只写入 Self Root。

### 2026-07-11 实现证据

- Schema 3 已落地 Connection、Target、Observation、ScanRun、ChangeBatch/Item、EventHint、Failure、WriteReceipt 和 DaemonLease。
- 编译后的真实 CLI 已验证手工扫描、metadata/Hash 复用、created/modified/deleted/renamed/restored、删除宽限、原生 watcher、丢事件后的定时对账、目标暂时消失保护、Source 批次归档、Rebind Plan/Apply 和 `source add --watch`。
- Daemon 已验证单 Leader、文件锁、SQLite Lease/心跳、SIGKILL 后过期接管，以及 Batch 持久化后进程崩溃的幂等恢复。
- Phase 2.5 的“增量摄入”在当前依赖顺序中表示可靠交付到 Source Snapshot；Revision/Chunk 发布必须等 Phase 3 的 Ingestion/Knowledge 表和状态机落地，当前不伪造下游完成状态。
- 证据保存在 `.test-runs/roadmap/2026-07-11/phase-2-5/`；真实合成数据只保存在忽略提交的 `data/test-runs/phase-2-5-real-cli/`。

详细设计见 [`domains/connection/`](../domains/connection/)。

## 7. Phase 3：Ingestion 与 Knowledge 核心

### 涉及领域

- Ingestion
- Knowledge
- Source

### 工作项

- 定义格式无关的 `NormalizedDocument`。
- 优先实现 Markdown、纯文本和 HTML 解析器。
- 第二批实现 PDF；Office、图片 OCR 和媒体转写按插件能力逐步加入。
- 保留标题层级、链接、标签、Frontmatter、代码块和来源位置。
- 实现确定性 Chunker，并记录 Chunker 版本和配置。
- 建立 Document、Revision、Chunk 和 Snapshot 映射。
- 实现文件哈希、规范内容哈希和 Chunk 哈希。
- 实现新旧 Chunk 对齐和 tombstone。
- 实现 `queued → parsing → normalized → chunked → publishing → ready` IngestionRun 状态机；前置条件是 Source Snapshot 已归档。
- 实现阶段 checkpoint、失败详情和重试。
- 实现人工 Note 的最小写入与版本保存。

### 验收标准

- 任何 ready Chunk 都能回到 Revision、Snapshot 和原始文件位置。
- 同一输入、解析器版本和配置产生相同规范内容与 Chunk。
- 单文件少量修改只替换受影响 Chunk。
- 解析失败不会留下看似成功的半成品。
- 重启进程后能够继续或安全重试未完成的摄入任务。

### 2026-07-11 实现证据

- Schema 4 已落地 IngestionRun/entry checkpoint、Document、不可变 Revision、稳定 Chunk、Revision/Run 映射、Chunk lineage 和 managed Note。
- Markdown、纯文本、HTML、JSONL 和 PDF 使用真实 Parser；HTML 不执行来源脚本，PDF 仅做本地文本/页码提取，图片等未支持附件明确 skipped。
- 默认 `source add/sync` 已接通 Ingestion ready，`--no-build` 保留归档入口；Connection ChangeItem 在 Source 与 Knowledge 成功后推进到 `ingested` 并保存 Run/Revision 投影。
- 编译后真实 CLI 已验证小段修改只替换受影响 Chunk、未变化 Document/Chunk 复用、格式变化只新增 Revision、删除 tombstone、解析失败零半成品、发布后强制退出幂等恢复。
- 人工 Note 已验证 Root 内原子文件、Source Snapshot、Revision、`--if-version` 冲突，以及 managed-content Connection 对 create/update 两次 ManagedWriteReceipt 的真实扫描消费；陈旧更新不改变文件。
- 多次增量后的当前规范 Document/Chunk Hash 与使用最终输入在新实例全量构建完全等价；Schema 3 → 4 Plan/Apply 和 Root-local backup 通过。
- `bun run verify:phase3` 最终 Gate 已通过：24 tests / 211 assertions / 0 failures，Phase 2.5 回归与编译后二进制 Phase 3 E2E 均通过；证据库有 0 个未完成 Run、0 个 Revision/Chunk orphan，15 个 Blob 全部重新校验 Hash。
- 本机基线：`knowledge status` 30 次 p95 63.86ms（预算 80ms），未变化 `knowledge build` 10 次 p95 73.42ms（预算 5s）且没有新增 Run/Revision/Chunk；性能数据以证据目录内 `performance.json` 为准。
- 证据保存在 `.test-runs/roadmap/2026-07-11/phase-3/`；合成数据位于忽略提交的 `data/test-runs/phase-3-real-cli/`。本阶段未读取 `~/notes`，未调用模型。

## 8. Phase 4：全文、向量与混合检索

### 涉及领域

- Knowledge
- Retrieval
- Model（Embedding 最小实现）

### 工作项

- 建立 SQLite FTS5 索引和中文检索策略。
- 建立 Model、Provider 和 VectorSpace 最小模型。
- 按 [`model-selection.md`](../model-selection.md) 支持至少一个千问 Embedding 基线，并锁定 Model Revision、维度、Instruction、Normalize 和 Distance。
- 使用 sqlite-vec 保存和搜索 Chunk Embedding。
- 实现 Embedding 批处理、缓存、重试和模型版本记录。
- 实现 `vector-space create|build|verify|compare|activate|migrate|delete`、空间 Fingerprint、影子回填和原子切换。
- 实现 Hosted 浮动模型别名的 Sentinel Fingerprint 漂移检测。
- 实现 Provider 永久不可用时从本地 Chunk 创建新空间，并让 Search 明确降级为 FTS + Graph。
- 实现 text、vector 和 hybrid 三种搜索模式。
- 实现来源、时间、标签、项目和类型过滤。
- 实现多路召回融合、去重和基础重排。
- 实现 `search --explain` 和 Chunk 来源展示。
- 实现 `knowledge rebuild --layer fts|vectors` 的影子重建和原子切换。

### 验收标准

- 全文和向量搜索均能返回稳定 ID、片段和原始来源。
- 不同 Embedding 模型的向量不会混合查询。
- 维度相同但 Fingerprint 不同的向量也不会混合查询。
- 重新构建向量期间旧索引仍可服务。
- 新空间未通过覆盖率、质量和性能门禁时无法激活，并可回滚到保留的旧空间。
- 删除旧 Provider 凭证、断网和 Model Not Found 时仍可从本地 Chunk 启动另一厂商的重建任务。
- 搜索结果可以解释来自哪一路召回以及为何进入最终排序。
- Search Alpha 可以在真实 Obsidian Vault 上完成一次全量导入和增量更新。

### 2026-07-11 实现证据

- Schema 5 已落地 Model Provider/Registry/Invocation、FTS Generation、VectorSpace/Build/Embedding、active pointers、Query Cache 和 Evaluation；Schema 4 → 5 显式 Plan/Apply、Root-local backup 与迁移后查询通过。
- FTS 使用 trigram 和 shadow Generation；swap 前进程退出时旧 Generation 继续服务，恢复后新 Generation 校验并原子切换。Knowledge ready 后按 Source 增量刷新 active FTS。
- vec0 使用受校验的维度表和 `vector_space_id` partition key；同维不同 fingerprint、不同 Model/Revision/Instruction 不混查。Vector build 固定水位、按批 checkpoint，首批后退出可幂等继续。
- `vector-space create|activate|migrate|delete` 使用 Plan/Apply；未覆盖完整不能 activate，A→B 激活、B→A rollback、从本地 Chunk 重建与 inactive space 删除均通过。
- Search 已实现 text/vector/hybrid、Source/path/type/tag/time过滤、RRF 去重/基础重排、完整 Chunk→Revision→Snapshot→Blob 证据与 explain 分阶段耗时。Provider/circuit/coverage 不可用时 vector 明确失败，hybrid 返回 FTS 和 `vector_degraded`。
- Hosted floating Model 使用公共 Sentinel fingerprint；漂移会打开 Circuit 并停止该空间 Query/写入。`models.offline=true` 阻止网络，缺凭证和 Model 调用失败保持稳定错误；Invocation 不保存正文或 Key。
- 真实 `~/notes` 只读接入发现单批 500 上限缺陷并完成修复：5,261 个接纳 Markdown 拆为 11 个有界 ChangeBatch，形成 5,261 Document、8,613 active Chunk/FTS row；第二次扫描 Hash 复用 5,261、变化 0，未修改外部笔记。
- 真实 DashScope `text-embedding-v4@1024` 在 `data/test-runs/phase-4-live-model/` 完成 3 个合成 Chunk 的 build/verify/activate/hybrid；实际响应 Model ID 正确，首次远程 Query Embedding 约 243ms。Key 仅临时进程注入，未进入配置、数据库或证据。
- 最终 `bun run verify:phase4` 通过：28 tests / 248 assertions / 0 failures，Phase 2.5/3/4 编译后二进制 E2E 均通过；合成空间 516/516 覆盖，未完成 build 0，最大 Connection batch 500。
- 性能基线：合成 FTS p95 67.54ms（预算 100ms）、缓存 Hybrid p95 75.47ms（预算 250ms）、真实 Vault FTS p95 67.82ms（预算 100ms）；EXPLAIN 确认 Source→RevisionChunk 与 active Embedding 使用索引，FTS 使用虚表索引。以证据目录内 `performance.json` 为准。
- 证据保存在 `.test-runs/roadmap/2026-07-11/phase-4/`；原始合成、真实 Vault 归档和 Live Model Root 均在忽略提交的 `data/`，Roadmap 证据只保留聚合计数，不保存私人正文/路径。

## 9. Phase 5：Entity、Relation、Claim 与可信度

### 涉及领域

- Graph
- Model
- Knowledge

### 工作项

- 按 [`domains/graph/`](../domains/graph/) 实现 SQLite GraphNode 邻接表、组合索引和有界 Recursive CTE。
- 实现 Predicate Registry、Domain/Range、方向、逆关系、时间和 Evidence 约束。
- 从 Markdown/Wiki Link/Embed/Citation/Frontmatter 建立显式文档关系和 UnresolvedReference。
- 定义 Entity 类型、别名和消歧规则。
- 实现基于 Chunk 的 Entity、Relation 和 Claim 结构化抽取。
- 所有模型输出先经过 Schema 校验，再进入候选状态。
- 建立 EvidenceLink 和 Claim 到 Chunk 的回溯。
- 实现相似 Claim 聚类和重复来源识别。
- 实现 ConflictSet，允许互相冲突的 Claim 并存。
- 实现 source quality、directness、corroboration、freshness、extraction quality、consistency、user verification 七个可信度维度。
- 实现 Claim confirm、reject 和 Entity merge 的领域规则。
- 实现图谱局部查询、邻居和路径。
- 实现绑定 VectorSpace 的有限 SemanticNeighbor；相似度不能直接提升为事实边。
- 实现 GraphGeneration、分层 Shadow Rebuild、校验、Diff、原子激活和回滚。
- 实现 JSON、JSON-LD、GraphML 导出和 Cytoscape 局部子图展示。

### 验收标准

- 图中的每个机器事实都能回到至少一个 Chunk。
- 显式文档 Link、语义相似、实体 Relation 和 Claim Relation 不会混成一种 `related_to`。
- 同名不同实体不会被静默合并。
- 多个转载同一原始来源不能被误算为多个独立证据。
- 冲突 Claim 能同时展示，并说明各自证据。
- 可信度结果包含维度和解释，不只有单个分数。
- Graph 增量结果与同输入全量重建等价，重建期间旧 Generation 持续可查询。

### 2026-07-13 实现证据

- Schema 6 已落地 GraphGeneration/active pointer、稳定 GraphNode 与 Generation membership、Predicate Registry、Entity/Alias/Redirect、Relation/Claim/Evidence、ClaimRelation/Conflict、UnresolvedReference、SemanticNeighbor 和 ExtractionRun；Schema 5 → 6 使用显式 Plan/Apply、Root-local backup 和完整性检查。
- 结构投影保存 Source→Document→Revision→Chunk，Markdown/Wiki/Embed/Citation 按不同 Predicate 保存；missing/ambiguous 保留原始 target、位置和候选，不猜测目标。
- `graph-extract-v3` 支持 Fixture 与 OpenAI-compatible Chat Model。响应按 JSON Schema、枚举、局部 Entity 引用、精确原文摘录、受控 Predicate、Domain/Range 和 Evidence 完整性逐层校验；模型调用不在事务内，失败不发布半 Entity/Claim/Relation。
- Claim Evidence CLI 已完整返回 Chunk、Document、Revision、Snapshot、Blob 和 Source。转载内容可绑定多条 Evidence，但相同 lineage 只计一次 corroboration；七维 Confidence 同时保存分量、等级、内部 score 和解释，争议不会被高分隐藏。
- 互斥 Claim 同时保留并进入 ConflictSet/`contradicts`；用户 confirm/reject 改变 user verification 与状态但不删除历史。Entity create/merge、Relation create 和 Generation activate 使用 Plan/Apply，Merge 保留旧 ID Redirect。
- Graph neighbor/path 使用默认与硬上限的 Recursive CTE，关系 out/in 组合索引和 Evidence 索引进入 EXPLAIN Gate。`graph subgraph` 返回 Cytoscape elements；JSON/JSON-LD/GraphML 导出 Active Generation 全量成员。
- SemanticNeighbor 绑定精确 VectorSpace、双方内容 Hash、稳定 rank 和算法版本，每个 source 的 Top-K 硬上限为 8；不会自动提升为事实 Relation。
- 编译后二进制 Phase 5 E2E 覆盖 50+ 命令调用、Schema/证据失败、来源独立性、冲突并存、遍历上限、三种导出、shadow Diff/激活/回滚、切换前退出、向量近邻、增量 Graph 切换和 Schema 5→6。
- 真实 `~/notes` 只读数据在 `data/` 完成结构/链接图：5,261 Document、8,613 Chunk、19,136 Node、24,478 Relation；解析出 100 次已解析显式引用，6,719 个缺失目标和 363 个歧义目标（大量附件/未接入目标被保守保留），未修改外部 Vault。
- 真实 DashScope `qwen3.7-plus-2026-05-26` 在 `data/test-runs/phase-5-live-model-fixed/` 对 2 个合成 Chunk 完成结构化抽取，形成 4 个 Entity、2 个 Claim、2 条 Evidence；不合规中间响应全部被门禁拒绝。Key 仅临时进程注入，未进入配置、数据库、Invocation 或证据。
- 最终 `bun run verify:phase5` 通过：30 tests / 294 assertions / 0 failures，Phase 2.5/3/4/5 编译后二进制 E2E 全部通过；Phase 5 E2E 执行 68 条 CLI 命令。合成两跳 neighbor p95 70.58ms（预算 400ms），真实 Vault 一跳 p95 117.19ms（预算 150ms），真实全图构建约 46.95s；EXPLAIN 命中 relation out/in 与 Claim Evidence 覆盖索引。精确数值以证据目录文件为准，Roadmap 不保存私人正文/路径。

## 10. Phase 6：带证据问答与追溯

### 涉及领域

- Retrieval
- Graph
- Model
- Automation

### 工作项

- 实现 Query 解析和 RetrievalPlan。
- 沿实体和关系扩展语义召回结果。
- 实现上下文预算和最小 EvidenceContext。
- 实现 `self ask`、`self related` 和 `self trace`。
- 输出引用、结论类型和 Claim 可信度。
- 校验生成结论是否被引用内容真正支持。
- 默认禁止使用未标记的模型外部知识。
- 实现“资料不足”“存在冲突”和“无法判断”的标准结果。
- 记录 RetrievalTrace、模型版本和上下文对象 ID。

### 验收标准

- 每条事实型回答都有可点击或可查询的证据链。
- 删除或失效证据后，相关回答缓存被标记过期。
- 模型无法从证据回答时不会编造完整答案。
- `trace` 能从回答章节追溯到 Source Snapshot。
- 同一知识快照下的回答可以重现检索上下文。

### 实现证据（2026-07-13）

- Schema 7 新增 `retrieval_runs`、`retrieval_candidates`、`evidence_contexts/items`、`answer_runs/statements/citations`；Query 默认只保存 SHA-256，不保存原文。所有 Citation 由外键约束在同一个 Context Item，并保存精确 Chunk 范围与 Hash。
- `retrieval-plan-v1` 按 `shallow|normal|deep` 固化 FTS/Vector/Graph 水位、候选上限和 Context budget。Ask 从 Search seed 沿 `Chunk → mentions Entity → Claim → Claim Evidence` 有界扩展，去重后生成最小 EvidenceContext；`similar_to` 不会默认提升为事实。
- `answer-grounded-v1` 同时支持 Fixture 与 OpenAI-compatible Chat Model。直接事实、单一来源、用户观点和冲突必须引用局部 E-key；模型摘录经过 NFKC/空白/Markdown 标点的保守匹配后回映为 Chunk 中的精确原文，Inference 至少需要两条 Citation。未知 key、伪造摘录或无引用事实返回 `answer_citation_unsupported`，不发布 Answer。
- 标准结果 `answered|insufficient_evidence|conflicted|cannot_determine` 已进入持久协议。无证据默认不调用模型；只有显式 `--allow-model-knowledge` 才允许无 Citation 的 `model_knowledge` Statement。Claim 冲突和 `disputed` 可信度不会被回答覆盖。
- `self trace answer:...` 返回 RetrievalRun、EvidenceContext、模型/Prompt 版本和 `Statement → Citation/Claim → Chunk → Revision → Snapshot → Source/Blob` 链；每个 Context Item 可从不可变 Chunk 重放并验证 excerpt Hash。`self related` 支持 Resource ID 有界遍历和 Query seed 的 Claim Evidence 扩展。
- Knowledge 发布、Graph Generation 激活或 Claim moderation 会把活跃 Context/Answer cache 标记 `stale`，历史记录和证据链继续保留。Phase 6 先采用保守全失效保证正确性，后续只能在不漏失效的前提下优化为精确依赖失效。
- 编译后二进制 Phase 6 E2E 执行 20 条 CLI 命令，覆盖冲突、资料不足、无法判断、显式模型外部知识、伪 Citation 拒绝、Evidence 变更失效、Context 重放、Related/Trace 和 Schema 6→7 Plan/Apply 迁移；最终证据合并记录 33 条 Gate/Harness 命令。
- 真实 `~/notes` 只读归档继续位于 `data/`。DashScope `qwen3.7-plus-2026-05-26` 对真实问题完成 Hosted Ask：4 个 Context Item、13 条 Statement、13 条 Citation，所有 13 条链均回到 Revision/Snapshot/Source，重放 Hash 全部一致。Key 仅临时进程注入，`data/self.toml` 只保存环境变量名，验收后恢复 offline 模式。
- 最终 `bun run verify:phase6` 通过：32 tests / 314 assertions / 0 failures，Phase 2.5/3/4/5/6 编译后二进制 E2E 全部通过；60 次采样的 Trace 点查 p95 69.37ms（预算 120ms），Related 一跳 p95 68.57ms（预算 150ms）。精确数值以 `.test-runs/roadmap/2026-07-11/phase-6/` 为准，证据目录不保存私人正文或凭证。

## 11. Phase 7：Topic 与可信综合报告

### 涉及领域

- Topic
- Retrieval
- Graph
- Model

### 工作项

- 实现 Topic、TopicScope、别名和排除条件。
- 实现局部知识图谱和候选 Claim 聚类。
- 判断来源独立性，区分原始来源与转载。
- 识别共识、单一来源、用户观点、AI 推断、冲突和未知问题。
- 建立 ReportOutline、ReportSection 和 KnowledgeGap。
- 实现章节可信度、覆盖度和整份报告健康状态。
- 保存 TopicSnapshot、数据水位和综合运行记录。
- 实现首次 `topic build`。
- 实现资料或 Claim 变化后的 stale/needs_review 标记。

### 验收标准

- 一个 Topic 能从多类来源生成结构完整的综合报告。
- 报告不会把用户观点或 AI 推断伪装成外部事实。
- 报告明确展示争议、未知项和可信度解释。
- 每个关键结论都能追溯到 Claim 和 Chunk。
- 相同 Topic 可以保存多个不可变报告版本。

### 实现证据（2026-07-13）

- Phase 7 已完成，数据库格式提升到 Schema 8。Topic、Alias、可版本 Scope、SynthesisRun、不可变 TopicSnapshot、SnapshotClaim、局部 Graph、ReportOutline、ReportSection、Conclusion、Topic Citation 和 KnowledgeGap 均由 Topic 领域写入同一 SQLite；Snapshot/Section/Conclusion/Citation 的 UPDATE/DELETE 由触发器拒绝。
- topic create/list/show/update/build/report/history 和 trace section 已进入稳定 CLI/JSON Schema。Build 固化 RetrievalRun/EvidenceContext、FTS/Vector/Graph 水位、规则版本、输入 Hash 和父 Snapshot；相同输入的新版本收敛到相同 Snapshot Hash，章节保存 parent_section_id 与 added/modified/unchanged。
- 可信综合确定性区分 consensus、single_source、user_opinion、inference、conflict 和 unknown。共识至少需要两个不同 source_lineage_key；三份证据中相同 Blob 的转载只计一个谱系。每个 supported Conclusion 都保存到 Claim Evidence 和完整 Chunk 的 Citation，Section Trace 可继续回到 Revision、Source Snapshot、Source 与 Blob。
- Report/Section 同时保存 confidence_level、七维 Claim 可信解释、coverage 和 health_status；未解决冲突为 needs_review、无 Claim 为 insufficient、只有单一来源为 degraded。未知项形成 KnowledgeGap，不调用模型常识补齐。
- Knowledge/Graph 水位变化会将当前 Topic 标记 stale；Claim confirm/reject 只将 latest Snapshot 实际包含该 Claim 的 Topic 标记 needs_review。历史 Snapshot 永不改写，旧版本可由 topic report --snapshot 继续读取。
- 真实编译后 CLI Phase 7 E2E 执行 32 条命令，覆盖六类章节、显式排除、同 Blob 转载折叠、多版本、不可变触发器、Section Trace、stale/needs_review 和 Schema 7→8 Plan/Apply；最终证据合并记录 46 条 Gate/Harness 命令。
- 真实 notes Hosted Graph 验收使用 DashScope qwen3.7-plus-2026-05-26。10 个真实 Chunk 的最终批次证据为 2 个复用、1 个成功、7 个结构不合格并按 Chunk 隔离，成功产出 4 条 FAISS Claim；认证/网络错误仍中止批次。该测试同时修正了普通多值 Predicate 被误判冲突的问题：规则冲突现在要求双方显式相同 conflict_scope。
- 基于真实 Claim 的 FAISS Topic 生成 4 条单一来源结论、4 条 Citation 和 1 个 KnowledgeGap，报告为 medium/degraded；4 条 Citation Hash 与 4 条 Claim→Chunk→Revision→Snapshot→Source 链全部通过。模型 Key 仅临时进程注入，data/self.toml 已恢复 offline=true，提交证据不含正文、路径或凭证。
- 最终 bun run verify:phase7 通过：35 tests / 342 assertions / 0 failures，历史 Phase 2.5～7 编译后二进制 E2E 全部通过；60 次采样的 topic show p95 73.66ms（预算 80ms），Section Trace p95 75.47ms（预算 120ms）。精确数值以 .test-runs/roadmap/2026-07-11/phase-7/ 为准。
- 以上是 Phase 7 Gate 当时的边界；Page IR、Artifact Build、HTML、export/diff 和受影响组件增量 refresh 已在下方 Phase 8 完成，Phase 7 历史产物未被改写。

## 12. Phase 8：Page IR、增量构建与 HTML

### 涉及领域

- Artifact
- Topic
- Automation

### 工作项

- 定义 Page IR v1 和组件 Schema。
- 首批实现 Hero、结论卡、证据块、时间线、对比矩阵、知识图谱、冲突和资料目录组件。
- 实现知识图谱和数据图表的安全前端渲染。
- 建立 Template、Theme、Artifact、Build 和 BuildManifest。
- 每次构建归档 request、retrieval、knowledge snapshot、Page IR、confidence、citations 和 HTML。
- 实现 `topic export --format html|markdown|json`。
- 支持多文件 HTML 和单文件 HTML。
- 实现 Build history、Diff 和 `latest` 原子切换。
- 实现 `topic refresh`：只重新检索和综合变化内容。
- 模板或主题变化时仅重新 render，不重新综合知识。

### 验收标准

- HTML 中所有关键结论能打开可信度和证据。
- 旧 Build 永远可查看，新构建不会覆盖历史。
- 新增少量资料时，只重新处理受影响 Chunk、Claim 和报告章节。
- BuildManifest 足以判断缓存是否失效并重现构建输入。
- 整个 Self 目录迁移后，历史 HTML 和依赖资源仍能打开。

完成本阶段即达到 MVP。

### 实现证据（2026-07-13）

- Phase 8 已完成，数据库格式提升到 Schema 9，Page IR 固定为 `self.page-ir@1`。Template、Theme、Artifact、Build、Dependency、Component、File 和 Export 统一保存在同一 SQLite；ready Build 及其子记录由触发器拒绝 UPDATE/DELETE，历史目录不被后续 Build 覆盖。
- `knowledge-atlas@1.0.0` 使用 React 静态渲染生成多文件与单文件离线 HTML，包含 Hero、结论、证据、时间线、对比、局部图谱、冲突、未知项和资料目录。来源正文只作为 React 文本节点；恶意 `<script>` Fixture 未执行，Chromium 断网验收观察到 0 个 HTTP(S) 请求，可信度和证据抽屉可正常展开。
- MVP 对有限局部图谱和可信度图形采用无第三方运行时的原生 HTML/CSS/SVG，而没有静默声称已经引入 ECharts/Cytoscape。该选择减少归档体积和脚本攻击面；只有后续 Page IR 出现大规模交互图表需求并补齐历史/离线 Gate 后才引入这两个可选渲染器，技术栈和 Graph/Artifact 文档已同步。
- BuildManifest 固化 request、retrieval/knowledge 水位、Page IR、confidence、citation、Template/Theme、组件依赖和全部文件 Hash。完整移动 Self Root 后，CLI、Manifest 校验和历史 HTML 仍可使用；`latest` 只在 ready Build 完成后原子切换。
- `topic refresh` 在 active 且输入未失效时跳过检索并且不创建 Build；stale/needs_review 时生成新 TopicSnapshot，再按稳定内容/依赖 Hash 复用组件。合成 E2E 新增一份相关 Source 后复用 2 个、重建 7 个组件；随后的纯 `artifact render` 复用全部 9 个组件。
- `topic build/refresh/history/diff/open/export` 与 `artifact list/show/history/diff/open/render/export`、`template list` 已进入稳定 CLI/JSON Schema。Export 支持多文件 HTML、单文件 HTML、Markdown 和 JSON，目标已存在时拒绝静默覆盖；Render 不查询模型也不重新综合知识。
- 真实编译 CLI Phase 8 E2E 覆盖 Schema 8→9 Plan/Apply、不可变触发器、历史 Build、增量/幂等 Refresh、纯 Render、多格式 Export、目录碰撞、安全转义、Root 整体移动和 Playwright 离线交互；最终证据记录 72 条命令。历史 Phase 2.5～8 编译后二进制 E2E 全部通过。
- 忽略提交的 `data/` 真实 Workspace 已从 Schema 8 迁移到 9，并在 `models.offline=true` 下把已有真实 FAISS TopicSnapshot 编译为 1 个 ready Refresh Build：7 个组件、4 个 Page IR Citation、19 个依赖、11 个归档文件，Manifest 文件 Hash 全部有效。该阶段无需再次调用 Hosted Model；凭证、笔记正文和私有绝对路径均未写入提交证据。
- 最终 `bun run verify:phase8` 通过：36 tests / 359 assertions / 0 failures。60 次采样的 `topic open` p95 86.88ms（预算 100ms）、Page IR 读取 p95 0.08ms（预算 80ms）、React 静态渲染 p95 1.72ms（预算 200ms）、单文件渲染 p95 1.66ms（预算 500ms）。精确结果见 `.test-runs/roadmap/2026-07-11/phase-8/`。
- Phase 8 Exit Gate 与 Step 37 已完成，Self 达到本 Roadmap 定义的 MVP。安全修改/删除/恢复从 Phase 9 开始，持久化 Job、Backup/Restore 和 Release Gate 仍属于 Phase 10。

## 13. Phase 9：安全修改、删除与恢复

### 涉及领域

- Automation
- Source、Knowledge、Graph、Topic、Artifact

### 工作项

- 实现 Plan、Apply、Operation 和 AuditEvent。
- 为 Plan 加入对象版本、前置条件、影响范围和过期时间。
- 实现 Source detach、delete、purge 和 restore。
- 实现 Note update/move/delete、Entity merge、Claim confirm/reject。
- 实现依赖传播：Claim 变化导致 Topic 和 Artifact stale。
- 实现软删除、tombstone 和恢复。
- 为可逆 Operation 生成 Undo Plan。
- 实现 `--idempotency-key` 和 `--if-version`。
- 实现批量修改的逐项状态和原子性声明。

### 验收标准

- 没有 Plan 无法执行高风险修改。
- Plan 创建后对象发生变化会阻止 Apply。
- 删除 Source 前可以准确列出受影响知识和 Topic。
- 可恢复操作不会丢失历史 ID、Revision 和审计记录。
- Agent 重试相同命令不会产生重复业务效果。

### 实现证据（2026-07-14）

- Phase 9 已完成，数据库格式提升到 Schema 10。`automation_plans`/Target、IdempotencyRecord、OperationChange、AuditEvent 和 SourcePurgeReceipt 统一进入同一个 SQLite；Plan 核心、Target、逐对象变化和审计事件由 Trigger 保证不可变，Manifest 归档在 Root 内 `runtime/plans/`。
- `plan list/show/diff/cancel`、`operation list/show/undo --plan`、`history list/show/diff` 已进入机器可发现 CLI/JSON Schema。Plan 固化对象 version/state、before image、影响 Hash、15 分钟过期时间、可逆性和 `atomic|per_item` 声明；Apply 再校验全部前置条件，陈旧或取消 Plan 不产生业务修改。
- Source Delete Plan 精确列出 Connection、Document、Chunk、Graph Evidence、Claim/Relation、EvidenceContext、Answer、Topic 和 Artifact 影响；Apply 在一个事务中软删除/失效，保留 Snapshot、Blob、Revision 和稳定 ID，Restore 按 OperationChange 恢复精确 before 状态。Purge 只允许所有保留引用为零的已删除 Source，成功后不可 Undo 且只留 Hash-only Receipt。
- Connection detach/restore 与 Note update/move/delete/restore 已完成。Note move 不制造内容未变化的 Snapshot/Revision；Undo 同时补偿 `content/notes/` 文件路径与 SQLite，任何一侧失败都回滚另一侧。Note update、直接 Restore 和审核命令支持 `--if-version` 与 `--idempotency-key`。
- Entity merge 延续 Phase 5 的版本化 Plan/Redirect 语义；Phase 9 新增 Entity/Relation/Claim confirm/reject/delete/restore，并将 Answer、Topic 和 Artifact 的依赖失效纳入同一 Operation。Topic/Artifact Delete/Restore/Undo 保留不可变 TopicSnapshot、Build、Page IR、Manifest 和离线文件。
- 每个 Phase 9 Apply 返回逐对象 `succeeded|failed|skipped`；当前高风险命令均为单事务 `atomic`，没有伪装成已实现部分成功。相同 Plan 或相同幂等键+规范输入返回首次结果，不重复递增版本；同键不同输入返回冲突。
- 编译后二进制真实 CLI E2E 覆盖 Schema 9→10、Plan cancel/stale、幂等 Apply、Source 精确删除/恢复与阻断/成功 Purge、Connection、Note 文件 Undo、Graph 审核和生命周期、Topic/Artifact 恢复/Undo、History/Diff 和 Audit 不可变；合成结果为 17 个 Plan、61 个 Operation、100 个 AuditEvent，关键不变量全部通过。
- 忽略提交的 `data/` Workspace 已安全迁移到 Schema 10 并通过 Doctor；对 `~/notes` Connection 执行 dry-run 扫描 1 个连接、变化 0。随后只创建、查看、Diff 并取消 1 个真实 Artifact Delete Plan，未 Apply，Artifact 保持 `ready`；模型继续 offline，配置和证据中均无明文凭证或私人正文。
- 最终 `bun run verify:phase9` 通过：36 tests / 385 assertions / 0 failures，类型、Lint、源文件大小、SQLite 能力、编译构建和历史 Phase 2.5～9 编译后二进制 E2E 全部通过；证据记录 88 条命令。精确结果见 `.test-runs/roadmap/2026-07-11/phase-9/`。
- Phase 9 Exit Gate 于该检查点完成；当时留下的 Phase 10 待办现已按下节实现。保留本段作为阶段历史，当前恢复位置只以上方“可恢复执行检查点”和 Phase 10 当前 Gate 为准。

## 14. Phase 10：长期可靠性与 v1.0

### 涉及领域

- Operations
- Automation
- Workspace

### 工作项

- 实现持久化 Job、checkpoint、取消、重试和进度流。
- 实现 SQLite Online Backup 和完整文件 Manifest。
- 实现备份验证和非覆盖式恢复。
- 实现数据库、Blob、索引、向量和引用链深度校验。
- 实现迁移 Plan、格式升级和失败回滚。
- 实现引用证明驱动的 GC。
- 实现锁诊断、WAL checkpoint 和崩溃恢复。
- 实现脱敏日志、诊断包和错误分级。
- 完成凭证加密或环境注入策略。
- 进行真实大型 Vault 的性能、长稳和恢复测试。
- 建立 GitHub Release、npm Platform Package、Trusted Publishing、Provenance、SBOM 和 Clean Machine 回装。

### 验收标准

- 在进程强制退出、磁盘写入失败和模型超时后能够恢复一致状态。
- 备份在另一台机器和新路径中通过恢复演练。
- 迁移失败不会破坏原实例。
- 深度校验能发现缺失文件、孤立向量和断裂证据链。
- 大型 Vault 的首次构建和增量更新时间达到已定义性能预算。
- npm Upgrade/Uninstall 不破坏实例，独立 Release 不依赖 Node/Bun。

### 2026-07-14 实现证据与当前 Gate

- 数据库格式提升到 Schema 11：新增持久化 Job/JobEvent、Backup/BackupFile、VerificationRun/Issue、GcReceipt/Item 和 MaintenanceLease；SQLite 仍是唯一权威状态，不引入外部队列或数据库。
- `job list|show|logs|watch|cancel|retry` 已接管 Backup、Deep Verify、Graph、VectorSpace 和 Topic 等长任务的 detached/wait 编排。Job 保存 checkpoint、进度、worker lease、attempt 和脱敏不可变事件；进程被杀、lease 过期、取消及可重试模型超时均可恢复。
- `backup create|list|show|verify|restore` 已实现 SQLite 一致性快照、业务目录 allowlist、逐文件 SHA-256 Manifest、非覆盖 Restore Plan、staging 深度校验和原子发布。Restore 后清理来源 Root 的瞬态 worker/lock 状态，但保留业务证据。
- `verify --deep` 检查 SQLite/FK/迁移校验和、Blob、Revision/Chunk、FTS、Vector、Claim Evidence、Artifact 文件和配置秘密；`gc --plan` 只接受带引用证明的 Blob、旧 VectorSpace 派生向量和过期临时文件，并使用 staging + Receipt 收敛崩溃恢复。
- Schema 10→11 故障注入证明迁移副本在原子替换前失败不会改变源数据库；维护锁会回收 dead PID/expired lease，WAL 可查询并显式 checkpoint。Doctor/Diagnostics 只暴露脱敏维护状态。
- 构建产物包含独立二进制、checksums、CycloneDX SBOM、MIT/第三方许可证和 Build Manifest；npm Meta/Platform 包统一为 1.0.0。当前平台 Clean Machine Gate 已验证无 Node/Bun PATH 的独立二进制、npm install/同版本 upgrade/uninstall，以及 Workspace Root 不随 CLI 卸载而删除。
- 合成 Phase 10 E2E 共保留 5 个 Job、3 个 Backup、68 个 Operation，覆盖取消/重试、dead worker、模型 timeout、WAL-active Backup、恢复目标拒绝覆盖、Deep Verify 故障发现、引用证明 GC 和 stale lock。全量 Gate 为 36 tests / 402 assertions / 0 failures，类型、Lint、大小、SQLite、构建、发布回装和历史 Phase E2E 全部通过。
- 忽略提交的真实 `data/` Workspace（来源为 `~/notes`）通过 Schema 11 Doctor、1 个 Connection dry-run（变化 0）和 Deep Verify（问题 0，31.18 秒）；324,386,563 bytes / 3,241 files 的 Backup 通过 Hash 校验，并在新测试 Root 中恢复（33.17 秒），恢复后 text search 91.31 ms 返回证据。提交证据不含私人正文或明文凭证。
- `data/self.toml` 仅保存 DashScope OpenAI-compatible Base URL 和 `SELF_DASHSCOPE_API_KEY` 环境变量引用；当前进程未提供该变量，因此本次没有新增 Hosted 调用。既有对话/Embedding 实测证据仍保留，不能把“配置完成”误写成“本轮云端调用完成”。

当前结论是 **v1.0.0 Release Candidate 主体实现和本机 Gate 完成，Phase 10 仍为 `in_progress`**。尚需执行 24h Soak、在 GitHub 上实际跑完五平台 Release Matrix、确认 npm `@helloanner` Scope/Trusted Publisher，并取得用户对外部发布的明确授权。全部通过后才能把 W10 标记 `completed` 并公开发布 v1.0.0；此前不得进入 Phase 11。

## 15. Phase 11：Agent 生态与扩展入口

### 工作项

- 基于 CLI Schema 提供 MCP Server。
- 提供本地 HTTP API，但不复制领域实现。
- 构建 Obsidian 插件，用于状态、引用回跳和 Topic 打开。
- 定义 Parser、Model Provider、Template 和 Exporter 插件接口。
- 支持外部 Agent 查询 Job、读取 Plan 和执行授权操作。
- 建立兼容性测试套件和第三方扩展开发文档。

### 验收标准

- CLI、MCP 和 HTTP 对同一业务操作产生一致结果。
- 插件不能绕过 Plan/Apply、审计和领域不变量。
- 扩展崩溃不会破坏 Self 主数据库。
- 第三方扩展可以在不理解内部表结构的情况下工作。

## 16. 贯穿全部阶段的工程要求

### 测试层次

- **单元测试**：领域不变量、值对象、状态机和纯算法。
- **数据库集成测试**：事务、迁移、FTS、sqlite-vec 和约束。
- **Golden 测试**：CLI 人类输出、JSON envelope、解析结果和 Page IR。
- **端到端测试**：从 Source 到 HTML 的完整闭环。
- **恢复测试**：在每个写入阶段强制终止进程并验证一致性。
- **回归语料**：固定一组 Markdown、网页、PDF、冲突资料和多语言内容。
- **性能基准**：首次构建、单文件增量、向量查询和 Topic Refresh。

### Definition of Done

任何阶段或功能只有同时满足以下条件才算完成：

实现和发布还必须满足 [`engineering-standards.md`](../engineering-standards.md) 中的代码大小、依赖方向、Root 数据边界、构建和部署红线。

交互命令、检索、HTML Render 和后台任务还必须满足 [`performance.md`](../performance.md) 的延迟与资源边界。

对话模型、Embedding、Reranker、维度或 VectorSpace 的实现还必须满足 [`model-selection.md`](../model-selection.md) 的版本、评测、迁移和回滚边界。

1. 领域模型、不变量和错误语义已写入对应文档。
2. 数据库变更包含迁移、回滚或恢复说明。
3. CLI 同时具备人类帮助和机器可读 Schema。
4. 写操作具备幂等、审计和失败恢复路径。
5. 所有派生结论都能追溯到稳定对象 ID。
6. 有正常、边界、失败和重启恢复测试。
7. 不在 Self 根目录外产生未声明的业务数据。
8. 新功能不会破坏旧 Artifact 和历史证据链。

## 17. 实施顺序中的硬依赖

```text
Workspace
  ├─→ Source
  └─→ Connection ─→ Source
                     └─→ Ingestion
                          └─→ Knowledge
                               ├─→ Retrieval ─→ Ask
                               └─→ Graph ─────┘
                                       └─→ Topic
                                             └─→ Artifact / HTML

Automation 从 Phase 1 起贯穿全部阶段
Operations 从 Phase 1 提供迁移基础，在 Phase 10 完整化
Model 从 Phase 4 开始提供 Embedding，并在 Phase 5～8 扩展能力
```

不应跳过的依赖：

- 没有可靠 Snapshot，不开始复杂解析。
- 没有稳定 Chunk 和 Revision，不开始图谱抽取。
- 没有证据链和冲突模型，不开始“可信综合报告”。
- 没有 TopicSnapshot 和 Page IR，不实现增量 HTML。
- 没有影响分析，不开放永久删除和 Agent 自动修改。
- 没有备份恢复演练，不发布 v1.0。

## 18. 今天的逐步开发顺序

严格按以下顺序实现。每一步都应形成一次小提交或至少一个可独立验证的工作树状态：

1. 建立项目骨架、测试框架、ADR、License 决策和 npm Meta/Platform Package 骨架。
2. 完成 SQLite + FTS5 + sqlite-vec 技术验证。
3. 冻结稳定 ID、JSON envelope 和退出码。
4. 实现 `self init`、Init Journal/Resume/Rollback、根目录发现和配置加载。
5. 实现 `self --init` Wizard、System/Component/Model Doctor，并建立数据库迁移和最小 Operation 记录。
6. 实现 `source add` 的单 Markdown 文件快照。
7. 实现 DataConnection、Target、Observation 和手工 Scan。
8. 实现 polling Daemon、ChangeBatch 和单 Leader Lease。
9. 实现 Markdown → NormalizedDocument → Chunk。
10. 将 Document、Revision 和 Chunk 写入 SQLite。
11. 打通 Connection → Source Snapshot → Ingestion。
12. 实现 `self get` 和来源证据回溯。
13. 实现目录递归导入和 Chunk 级增量更新。
14. 加入原生 watcher，并用 reconciliation 验证最终一致性。
15. 实现 FTS 搜索。
16. 实现第一个千问 Embedding Provider、VectorSpace Fingerprint 和 sqlite-vec 搜索。
17. 实现 VectorSpace `create → build → verify → activate → rollback`。
18. 建立真实 Query/Evidence Golden Set，并验证 1024 维基线的质量、延迟和磁盘。
19. 实现 hybrid search 和 `search --explain`。
20. 使用真实 Obsidian Vault 和多个项目 docs 完成自动感知端到端验证。
21. 建立 GraphNode、Predicate、Entity、Relation、Claim、Evidence 和 Conflict SQLite 表。
22. 从 Markdown/Wiki Link/Embed/Citation 构建显式文档关系和 UnresolvedReference。
23. 实现 Entity Alias、Mention、消歧候选、Merge Plan 和永久 Redirect。
24. 实现 Relation/Claim 结构化抽取、Schema 校验、Evidence 和可信度维度。
25. 实现 Claim supports/contradicts/refines/supersedes、ConflictSet 和来源独立性。
26. 实现 GraphGeneration、分层 Shadow Rebuild、Diff、Verify、Activate 和回滚。
27. 实现有界 neighbors/path/subgraph、JSON-LD/GraphML 导出和 Graph Trace。
28. 实现 RetrievalPlan、EvidenceContext、Citation Hydration 和 `self ask` 流式输出。
29. 实现回答 Citation 校验、资料不足、存在冲突和知识库外常识隔离。
30. 使用真实问题集完成 Knowledge Alpha：每条事实回答都能回到 Snapshot。
31. 实现 Topic、TopicScope、TopicSnapshot、KnowledgeGap 和影响索引。
32. 实现 Topic 首次 Build：共识、单一来源、用户观点、AI 推断、冲突和未知项。
33. 实现 Topic Refresh、章节级 stale、增量检索、报告 Diff 和历史版本。
34. 定义 Page IR v1、组件 Schema、Template、Theme、BuildManifest 和 Citation Manifest。
35. 实现 Page IR → React 静态 HTML、多文件/单文件资源归档和原子 latest。
36. 实现局部图、证据抽屉、可信度和离线交互；MVP 以受限原生 SVG 完成，ECharts/Cytoscape 仅在后续确有大规模交互需求时按技术栈 Gate 引入。
37. 完成 Playwright、离线、视觉、可访问性、历史 Build 和增量 Render 测试，达到 MVP。
38. 实现通用 Plan/Apply、版本前置条件、Operation、Audit 和幂等协议。
39. 实现 Source/Note/Entity/Claim/Topic/Artifact 的软删除、恢复、Purge Plan 和 Undo Plan。
40. 实现持久化 Job、Checkpoint、取消、Retry、优先级、Backpressure 和 Daemon 协调。
41. 实现 SQLite Online Backup、Manifest、异地 Restore、Migration Plan、Deep Verify 和引用证明 GC。
42. 执行 Crash Matrix、24h Soak、Small/Medium/Large 性能、npm Clean Machine 和跨平台 Release Suite，达到 v1.0。
43. 从 CommandSpec 生成 MCP Server，并验证与 CLI 对同一 Application Service 的结果一致。
44. 增加本地 HTTP API、Obsidian 插件最小入口和扩展兼容测试，不复制业务逻辑。
45. 更新全部设计文档、命令 Schema、Migration、CHANGELOG 和当天验收摘要，将 Roadmap 状态据实收口。

### Step 1～5：工程基线检查

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
bun run package:local
bun run test:install -- --channel npm --clean-machine
./dist/self version --json
```

必须证明：编译产物可运行、npm Platform Package 能在无 Bun 环境启动、SQLite/FTS5/sqlite-vec Spike 通过、`version/help/doctor --system` 不创建 Root、没有 Root 外业务写入。

### Step 6～14：摄入闭环检查

```bash
./dist/self init .test-runs/roadmap/2026-07-11/phase-3/root
./dist/self --root .test-runs/roadmap/2026-07-11/phase-3/root source add ./test/fixtures/vault --mode snapshot
./dist/self --root .test-runs/roadmap/2026-07-11/phase-3/root knowledge status --json
./dist/self --root .test-runs/roadmap/2026-07-11/phase-3/root verify --deep --json
```

必须证明：任何 Chunk 可追溯到 Snapshot；重复输入幂等；修改一个文件只更新受影响 Chunk；崩溃后可恢复。

### Step 15～20：Search Alpha 检查

```bash
./dist/self --root <ROOT> search '子智能体上下文隔离' --mode text --explain --json
./dist/self --root <ROOT> search 'agent memory isolation' --mode vector --explain --json
./dist/self --root <ROOT> search 'GraphRAG' --mode hybrid --explain --json
./dist/self --root <ROOT> vector-space verify vector-space:vsp_123 --deep --json
./dist/self --root <ROOT> doctor --performance --json
```

必须证明：三种检索都有证据、VectorSpace 不混用、Provider 不可用时明确降级 FTS + Graph，并满足 Tier 2 性能预算。

### Step 21～30：Knowledge Alpha 检查

```bash
./dist/self --root <ROOT> graph verify --deep --json
./dist/self --root <ROOT> graph neighbors entity:ent_123 --depth 2 --json
./dist/self --root <ROOT> claim evidence claim:clm_123 --json
./dist/self --root <ROOT> ask '哪些资料对这个结论存在冲突？' --trace --json
```

必须证明：显式链接、语义近邻、事实 Relation 和 Claim 冲突分层正确；Graph 增量/全量重建等价；Ask 不伪造 Citation。

### Step 31～37：MVP 检查

```bash
./dist/self --root <ROOT> topic build topic:top_123 --wait --json
./dist/self --root <ROOT> topic refresh topic:top_123 --explain-changes --wait --json
./dist/self --root <ROOT> topic export topic:top_123 --format html --output .test-runs/roadmap/2026-07-11/mvp-html
bun run test:browser
```

必须证明：Topic 跨来源综合、冲突/未知项可见、旧 Build 保留、HTML 离线可开、仅受影响章节更新。

### Step 38～42：v1.0 检查

当前进度：Step 38～41 和 Step 42 的 Crash Matrix、真实 Large Vault 恢复、本机 Clean Machine 已通过；Step 42 的 24h Soak、五平台实际 CI 和外部发布资格仍待完成。因此本节未整体完成。

```bash
bun run verify:phase10
self --root <ROOT> backup create --wait --json
self --root <ROOT> verify --deep --wait --json
# 发布资格收口时再执行：24h Soak 与 GitHub 五平台 release workflow
```

必须证明：Plan/Apply、并发冲突、Backup/Restore、Migration、GC、崩溃恢复、性能和跨平台发布门禁全部通过。

### Step 43～45：扩展与收口检查

- 对同一 Fixture 分别调用 CLI、MCP 和 HTTP，比较规范化 JSON 结果。
- 验证扩展没有直接写领域表、不能绕过 Plan/Apply。
- 更新 `.test-runs/roadmap/2026-07-11/final/summary.md`，列出完成、未完成、阻塞、风险和下一 Roadmap。

完成 Step 20 获得 Search Alpha，Step 30 获得 Knowledge Alpha，Step 37 获得 MVP，Step 42 获得 v1.0。Step 45 完成后，本日期 Roadmap 才可以在索引中标记 `completed`。
