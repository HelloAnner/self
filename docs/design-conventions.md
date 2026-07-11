# Self 设计约定与一致性规则

> 本文件是跨文档术语、数据所有权和设计同步的权威索引。它不替代领域详细设计，而是确保不同文档描述的是同一个系统。

## 1. 文档权威范围

| 文档 | 权威范围 |
| --- | --- |
| `architecture.md` | 产品目标、系统边界、核心对象、总体数据流和公开 CLI 轮廓 |
| `technology-stack.md` | 语言、Runtime、组件、版本和技术配置 |
| `engineering-standards.md` | 实现、依赖方向、红线、运行配置、构建和部署规范 |
| `performance.md` | 交互延迟、后台吞吐、资源预算和性能门禁 |
| `model-selection.md` | 对话模型职责、模型路由、Embedding 兼容性、维度和 VectorSpace 迁移 |
| `distribution.md` | npm/独立二进制分发、安装、首次初始化、升级、卸载和供应链安全 |
| `domains/<domain>/` | 该领域的聚合、状态、Schema、命令和内部工作流 |
| `testing.md` | 全局测试策略、测试环境和发布门禁 |
| `roadmap/README.md` 与日期 Roadmap | 计划索引、实施顺序、依赖、当日步骤和阶段验收，不重新定义业务语义 |
| `AGENTS.md` | 项目灵魂、不可偏离原则和文档阅读路由 |

发生冲突时，不简单以“更具体的文件”为准，而应根据上表确定主题所有者并同步修改所有受影响文档。

## 2. 规范术语

| 术语 | 唯一定义 | 所有领域 |
| --- | --- | --- |
| Workspace | 一个由 `self.toml` 标识的完整 Self Root | Workspace |
| SetupSession | 一次可取消、可恢复的 `self --init` 交互式配置会话 | Workspace |
| Connection | 对外部文件/目录的持续监控关系、策略和健康状态 | Connection |
| Target | Connection 实际读取的一个外部文件或目录 | Connection |
| Observation | Connection 对外部文件当前状态的持久认知 | Connection |
| ScanRun | 一次枚举、比较、Hash 和变化分类运行 | Connection |
| ChangeBatch | 一次提交给 Source 的可靠文件变化批次 | Connection |
| Source | 一个信息来源的逻辑身份和证据归档边界 | Source |
| Blob | Root 内按内容哈希保存的原始二进制对象 | Source |
| Snapshot | Source 在某时刻保存的不可变原始证据快照 | Source |
| IngestionRun | 将 Snapshot 转成规范知识材料的一次运行 | Ingestion |
| Document | 一份逻辑文档的长期身份 | Knowledge |
| Revision | Document 的不可变内容版本 | Knowledge |
| Chunk | Revision 中最小可引用、检索和向量化片段 | Knowledge |
| VectorSpace | 由 Embedding Model Revision、维度、输入版本、Normalize 和 Distance 定义的不可变向量空间 | Knowledge |
| Entity | 人物、概念、项目、组织或事件 | Graph |
| Relation | 带来源、时间和可信度的实体关系 | Graph |
| Claim | 可以被证据支持、反驳或确认的信息主张 | Graph |
| Topic | 长期维护的主题范围、知识快照和综合结论 | Topic |
| Artifact | HTML、Markdown、图表等长期产物身份 | Artifact |
| Build | Artifact 的一次不可变构建 | Artifact |
| Page IR | Topic/知识表达与 HTML 渲染之间的中间表示 | Artifact |
| Plan | 尚未执行、带前置条件和影响范围的修改计划 | Automation |
| Operation | 一次已经提交的可审计业务操作 | Automation |
| Job | 可 checkpoint、取消和恢复的长任务 | Automation |

禁止混用：

- Snapshot 不是 Revision：前者是原始证据，后者是规范 Document 版本。
- Observation 不是 Snapshot：前者只用于变化判断，后者保存可追溯证据。
- 检索分数不是 Claim 可信度。
- Artifact 不是事实来源。
- Connection detach 不是 Source delete。
- Source ready 不等于整个摄入链 ready；必须说明具体阶段或 Composite Operation 状态。

## 3. 权威数据流

```text
External Target
  → Connection Observation
  → ScanRun / ChangeBatch
  → Source Snapshot / Blob
  → IngestionRun
  → Document Revision / Chunk / Embedding
  → Entity / Relation / Claim
  → Retrieval EvidenceContext
  → Topic Snapshot / Report Section
  → Page IR
  → Artifact Build / HTML
```

每一步都保留上游稳定 ID。任何下游产物必须能沿数据流回到 Snapshot 和 Source。

## 4. 数据所有权

| 数据 | 唯一写入者 | 其他领域如何获知 |
| --- | --- | --- |
| Workspace、WorkspaceConfig、SetupSession、Capability | Workspace | Workspace Read Model / Event |
| Connection、Target、Observation、Scan、Change | Connection | Read Model / Domain Event |
| Source、Blob、Snapshot | Source | SnapshotCreated 等事件 |
| Ingestion 状态和规范化草稿 | Ingestion | IngestionPublished 等事件 |
| Document、Revision、Chunk、Embedding | Knowledge | Repository / KnowledgeChanged |
| GraphNode、Entity、Predicate、Relation、Claim、Evidence、Conflict、GraphGeneration | Graph | Graph Read Model / Event |
| RetrievalPlan、Trace、Citation | Retrieval | Query Result |
| Topic、TopicSnapshot、ReportSection | Topic | Topic Read Model / Event |
| Artifact、Build、Page IR、Manifest | Artifact | Artifact Read Model / Event |
| Provider、Model、ModelRoute、Invocation、PromptSpec | Model | Model Gateway / Invocation Event |
| Plan、Operation、Job、Audit | Automation | 公共 Automation API |
| Migration、Backup、Verification、Diagnostic、GC | Operations | 运维报告和事件 |

跨领域流程由 Application 编排。一个领域不得直接修改另一个领域拥有的表；需要进度投影时，由数据所有者订阅事件后写自己的表。

## 5. 状态命名规则

- 状态使用小写 snake_case 或单个英文单词，数据库和 JSON 保持一致。
- `ready` 只能表示某个明确对象的阶段完成，不能笼统表示“整个系统都成功”。
- `partial` 必须视为非完整成功，并提供失败项目。
- `degraded` 表示仍可部分工作但需要关注。
- `unavailable` 用于 Target 等外部资源状态；Connection 聚合对应 `degraded`。
- `deleted` 表示软删除；物理删除使用 `purged` 事件或 GC 记录，不把对象改回不存在。
- `stale` 表示下游依赖已变化，需要刷新，不表示数据错误。
- `needs_review` 表示需要用户或规则复核，不等同于 failed。

每个领域详细状态机由领域文档拥有；跨文档引用必须使用相同拼写。

## 6. ID 规则

公开 ID 采用：

```text
<resource>:<type-prefix>_<uuidv7-or-ulid>
```

示例：

```text
workspace:ws_...
setup:stp_...
connection:con_...
target:ct_...
observation:obs_...
source:src_...
snapshot:snp_...
ingestion:ing_...
revision:rev_...
chunk:chk_...
vector-space:vsp_...
note:note_...
claim:clm_...
relation:rel_...
graph-node:gn_...
evidence:evd_...
reference:gref_...
conflict:cfs_...
generation:ggen_...
extraction:gex_...
diagnostics:diag_...
topic:top_...
section:sec_...
artifact:art_...
build:bld_...
```

规则：

- ID 一经发布永久稳定。
- rename、rebind 和实体 merge 不改变原 ID；merge 使用重定向。
- 数据库、CLI、日志、事件和 Manifest 使用相同完整 ID。
- 用户可读 slug 不是 ID，修改操作不能只依赖模糊 slug。
- 文档示例允许用 `_123` 简写，但 resource 和 type-prefix 必须正确。

完整注册表见 `architecture.md` 的 CLI 设计章节。

## 7. 路径规则

- Self 业务路径保存为 Workspace Root 相对路径。
- Connection Target 通常是明确允许的 ExternalInputPath，可以是绝对 URI 但只能读取；Root 内仅 `content/notes/` 和 `content/inbox/` 可以作为 `managed_content` Target。
- 用户显式 ExportPath 可以位于 Root 外，必须由命令参数指定。
- systemd/launchd 安装是显式系统写入，必须通过 Plan。
- 所有其他临时、日志、锁、缓存、PID 和 Job 文件必须位于 Root。
- 路径必须 canonicalize，并防止 `..`、符号链接和大小写绕过。

## 8. 时间、哈希和版本

- 对外时间使用 UTC RFC 3339/ISO 8601。
- 高精度文件 mtime 是观察值，不能替代内容 Hash。
- 内容身份默认使用 SHA-256。
- 文件变化先用 metadata/quick fingerprint 筛选，最终证据用完整内容 Hash。
- CLI、Config、Database、Page IR、Parser、Chunker、Prompt 和 Template 分别版本化。
- 模型调用记录 Provider、Model ID、关键参数和 Schema/Prompt 版本。

## 9. CLI 语义

- 规范形式为 `self <resource> <action> [id] [options]`。
- 高频快捷命令必须明确映射到规范命令，不创建第二套业务语义。
- 只读命令立即执行；长任务可以 `--wait` 或 `--detach`。
- 高影响操作先 `--plan`，统一由 `self apply <PLAN_ID>` 执行。
- `--json` 输出单个 envelope；`--jsonl` 每行一个事件。
- stdout 只放结果，stderr 放诊断和进度。
- 公开命令、错误码、退出码和 JSON 字段都属于兼容契约。

## 10. 配置归属

- `bunfig.toml`：开发仓库中的 Bun 工具配置。
- `self.toml`：Self 实例 Root 中唯一的用户运行配置。
- 动态 Connection 列表存在 SQLite；`self.toml [connections]` 只存全局默认和资源上限。
- 密钥使用环境变量或加密 Secret 引用，不写明文 TOML。
- CLI 临时参数只覆盖当前命令，不静默修改 `self.toml`。

## 11. 文档同步矩阵

| 变更类型 | 必须同步检查 |
| --- | --- |
| 产品边界或核心流程 | architecture、相关 domain、AGENTS |
| 新领域或领域边界 | domains/README、architecture、roadmap、testing |
| CLI 命令 | architecture CLI、domain commands、automation、testing |
| SQLite Schema | domain schema、roadmap、migration/testing、engineering standards |
| 配置字段 | technology stack、engineering standards、domain workflow、testing |
| 依赖或版本 | technology stack、build config、release tests |
| 安装、npm 包、Init 或 Onboarding | distribution、workspace initialization、architecture、technology stack、engineering standards、testing、roadmap |
| 模型、维度、Instruction 或 VectorSpace | model selection、model/knowledge/retrieval domain、performance、testing、roadmap |
| 后台进程/部署 | engineering standards、domain workflow、testing、AGENTS 原则 |
| 性能预算或索引策略 | performance、technology stack、testing、相关 domain |
| 新状态或错误码 | domain model、schema、commands、contract tests |
| Artifact/Page IR | architecture、artifact domain、technology stack、browser tests |

## 12. 一致性检查门禁

文档修改至少执行：

- 相对链接目标检查
- Markdown 代码围栏成对检查
- 领域目录与 `domains/README.md` 索引对照
- CLI 示例中的 ID 前缀检查
- 状态值与领域 Schema 对照
- `self.toml` 字段在技术、工程和领域文档中的对照
- Roadmap 阶段与领域硬依赖对照
- AGENTS 文档路由更新

文档可以处于草案状态，但同一概念不能在不同草案中拥有互相冲突的定义。
