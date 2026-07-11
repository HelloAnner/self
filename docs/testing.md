# Self 测试机制与测试框架

> 状态：初始测试设计
> 核心原则：使用真实 Self CLI，在一次性的本地单目录环境中反复执行完整工作流；不仅验证函数返回值，还验证文件、SQLite、向量、图谱、证据链、HTML 和故障恢复后的真实状态。

## 1. 测试目标

Self 的测试不能只覆盖若干内部函数。它最重要的产品承诺是：

1. 一个 Self 实例的全部业务数据都在单个目录中。
2. 所有来源都会被完整归档、解析、切片、入库和向量化。
3. 增量处理与从头重建得到等价知识结果。
4. 搜索、图谱、问答和报告能够追溯到真实证据。
5. Topic 可以跨来源生成带可信度、冲突和未知项的综合报告。
6. HTML、构建历史和依赖资源能够长期保存并重新打开。
7. 修改、删除、崩溃、迁移和恢复不会破坏知识库一致性。
8. Agent 可以通过稳定 JSON、退出码、幂等和 Plan/Apply 安全调用 CLI。

测试框架必须围绕这些承诺构建，而不是只追求代码行覆盖率。

## 2. 测试的硬性原则

### 2.1 黑盒优先

关键功能必须通过编译后的真实 `self` CLI 进程测试：

```text
准备本地测试目录
  → 执行真实 self 命令
  → 检查 stdout、stderr 和退出码
  → 检查实例目录中的真实文件
  → 查询真实 SQLite 数据库
  → 运行下一条命令验证状态变化
```

单元测试可以直接调用内部代码，但它不能替代 CLI 端到端测试。

### 2.2 每次测试使用独立目录

每个场景创建一个全新的 Test Run 目录。测试不得读取或修改用户真实的 Obsidian Vault、真实 Self 实例或默认用户目录。

Self 实例目录和测试辅助数据都位于该 Test Run 目录下。测试结束后，整个目录就是完整的复现包。

### 2.3 真实依赖分层测试

- SQLite、FTS5、sqlite-vec、文件系统和 CLI 子进程必须使用真实实现。
- 解析器、Chunker、迁移和渲染器必须使用真实实现。
- 模型和公网等不稳定边界可以在快速测试中使用确定性 Provider，但必须另设真实模型和真实网络测试通道。
- E2E 不允许 mock 掉 Self 内部领域模块，否则无法证明完整链路真实可用。

### 2.4 验证最终状态，不只验证命令成功

退出码为 `0` 只说明命令声称成功。测试还必须检查：

- 文件是否落在正确目录
- SQLite 是否满足领域不变量
- Source 是否生成 Snapshot，以及对应 IngestionRun/Knowledge Index 是否达到各自预期状态
- Chunk、向量、Claim 和引用是否存在
- 未变化内容是否真正被复用
- HTML 是否能打开且没有缺失资源
- 删除和恢复是否影响了正确对象
- 是否出现目录外写入

### 2.5 失败目录默认保留

成功场景可以自动清理；失败场景必须保留完整 Test Run，包括命令、输入、日志、数据库、Artifact、环境摘要和随机种子，确保一条命令可以复现。

## 3. 单目录测试环境

### 3.1 Test Run 目录布局

```text
.test-runs/
└── 20260711T120000Z_ingest-markdown_a1b2c3/
    ├── run.json                 # 场景、种子、版本、平台和结果
    ├── commands.jsonl           # 执行过的命令和退出码，敏感值脱敏
    ├── input/                   # 本次测试的外部输入副本
    │   ├── vault/
    │   ├── files/
    │   └── web-root/
    ├── instance/                # 真正的 Self 根目录
    │   ├── self.toml
    │   ├── content/
    │   ├── data/
    │   ├── artifacts/
    │   ├── templates/
    │   ├── runtime/
    │   └── backups/
    ├── home/                    # 隔离后的 HOME
    ├── tmp/                     # 隔离后的 TMPDIR
    ├── cache/                   # 隔离后的 XDG_CACHE_HOME 等
    ├── expected/                # Golden、Schema 和预期不变量
    ├── actual/                  # 导出的实际结果、DOM 和数据库快照
    └── logs/                    # CLI、模型、本地 HTTP 和写入审计日志
```

这里有两个边界：

- `instance/` 是被测试的真实 Self 单目录实例。
- 整个 Test Run 是测试信封，容纳输入、隔离环境和诊断信息。

所有测试期间产生的可写数据必须位于 Test Run 中。

### 3.2 环境隔离

测试运行时显式重定向可能产生隐式写入的位置：

```bash
RUN="$PWD/.test-runs/<run-id>"

env \
  HOME="$RUN/home" \
  TMPDIR="$RUN/tmp" \
  XDG_CACHE_HOME="$RUN/cache/xdg" \
  XDG_CONFIG_HOME="$RUN/home/.config" \
  XDG_DATA_HOME="$RUN/home/.local/share" \
  SELF_ROOT="$RUN/instance" \
  self status --json
```

如果 Self 本身不支持 `SELF_ROOT`，Harness 必须为每条命令显式传入 `--root "$RUN/instance"`。

测试不得依赖开发者机器上已有的全局 Self 配置、模型缓存或认证状态。需要使用云模型时，通过测试进程环境临时注入密钥，并在 `commands.jsonl` 和日志中脱敏。

### 3.3 目录外写入审计

“所有数据都在单目录”必须成为自动化断言：

1. CI 中将仓库和系统目录设为只读，只允许 Test Run 可写。
2. 对 macOS 使用 `fs_usage` 等文件系统跟踪手段，对 Linux 使用 `strace` 或等效能力记录写操作。
3. Harness 汇总所有 `open/create/rename/unlink` 写入路径。
4. 除 CLI 二进制加载、系统只读库和显式网络连接外，任何 Test Run 外的写入都使测试失败。
5. 进程退出后检查真正的用户 HOME、系统临时目录和项目根目录没有新增 Self 业务文件。

目录外写入审计至少在标准 CI、Nightly 和 Release Suite 中执行。

## 4. 测试框架结构

### 4.1 两层测试入口

建议提供一个仓库内部测试执行器 `self-test`，它不是面向最终用户的 Self CLI：

```bash
self-test suite fast
self-test suite standard
self-test suite full
self-test suite live
self-test scenario ingest-markdown --keep
self-test replay .test-runs/<run-id>
self-test clean --passed --older-than 7d
```

底层仍然调用语言原生测试框架：

- 原生测试框架负责单元测试、模块集成和并发测试。
- `self-test` 负责目录准备、真实 CLI 编排、故障注入、断言、复现包和测试矩阵。
- Shell 只作为方便开发者使用的入口，不应承载复杂断言和 JSON 解析。

### 4.2 Scenario 定义

每个端到端场景采用声明式描述：

```yaml
name: ingest-markdown-incrementally
fixture: vault-small
mode: deterministic
steps:
  - run: [self, init, "${INSTANCE}"]
  - run: [self, --root, "${INSTANCE}", source, add, "${INPUT}/vault", --kind, obsidian, --mode, mirror]
  - assert: source_ready
  - mutate: update_one_markdown_file
  - run: [self, --root, "${INSTANCE}", source, sync, "${SOURCE_ID}"]
  - assert: only_changed_chunks_rebuilt
  - assert: no_writes_outside_run
```

Scenario 文件描述意图和步骤，具体断言由有类型的测试代码实现，避免在 YAML 中创建另一门脚本语言。

### 4.3 每次运行的记录

`run.json` 至少记录：

- Scenario 名称和版本
- Self CLI 版本、Git commit 和构建模式
- 数据库、CLI 协议和 Page IR 版本
- 操作系统、架构和文件系统信息
- SQLite、FTS5 和 sqlite-vec 版本
- Parser、Chunker、模型和模板版本
- 测试随机种子和时区
- 网络模式和 Provider
- 开始时间、结束时间和阶段耗时
- 最终状态和失败断言

敏感凭证、完整私人内容和未经脱敏的模型请求不得进入测试报告。

## 5. 测试分层

### 5.1 单元测试

适合验证：

- ID、哈希、时间和路径值对象
- 领域不变量
- 状态机
- Chunk 边界算法
- 可信度维度计算
- Plan 前置条件
- Page IR 转换和缓存失效判断

单元测试应快速、无网络、无真实时钟依赖，并可并行执行。

### 5.2 领域集成测试

每个测试创建真实临时 SQLite 和目录，验证：

- 表约束、外键和事务
- FTS5 Tokenizer 和排名
- sqlite-vec 插入、删除和近邻搜索
- WAL、锁和并发读取
- 迁移和回滚
- 文件落盘与数据库提交的一致性
- 领域事件和跨领域投影

不允许使用与生产不同的内存数据库替代 SQLite 文件。

### 5.3 CLI 契约测试

对 `self commands --json` 返回的每条公开命令验证：

- `--help` 可用
- 参数 Schema 与实现一致
- 人类输出没有崩溃或泄漏内部堆栈
- `--json` 始终符合统一 envelope
- stdout、stderr 和退出码符合约定
- 错误码稳定且可机器判断
- stdin、JSONL 和大内容路径正常
- `--idempotency-key` 与 `--if-version` 生效
- `self --init` 只在 TTY 启动交互流程；非 TTY/JSON 冲突返回稳定错误并建议 Setup Spec

CLI 命令清单应自动生成覆盖矩阵，避免增加新命令却没有任何测试场景。

### 5.4 端到端测试

端到端测试从输入资料开始，使用真实 CLI，直到查询、Topic 和 HTML。它是判断产品功能是否真的可用的主要依据。

端到端测试不得直接向内部表写入准备数据；所有业务数据必须通过公开命令进入。

### 5.5 恢复与迁移测试

在每个关键写入点注入进程退出、磁盘错误和 Provider 失败，然后重新运行 CLI，验证：

- 数据库可以打开
- 没有已发布的半成品
- 临时文件可以识别和清理
- Job 可以继续或明确失败
- 旧索引仍能服务
- `latest` 没有指向失败 Build
- 重试不会重复创建业务对象

每个数据库格式版本都需要测试：

- 上一受支持版本 → 当前版本
- 当前版本备份 → 新目录恢复
- 迁移中断 → 原版本保持可恢复
- 新版本数据库被旧 CLI 打开 → 拒绝写入

### 5.6 性能与长稳测试

具体交互延迟、后台吞吐、HTML Render 和资源预算以 [`performance.md`](./performance.md) 为准；本节定义测试方式，不重复创造另一套阈值。

至少建立三种规模：

| 数据集 | 用途 |
| --- | --- |
| Small | 1,000 Document / 10,000 Chunk；PR 快速回归与开发循环 |
| Medium | 20,000 Document / 200,000 Chunk；Nightly 与主要交互性能门禁 |
| Large | 100,000 Document / 1,000,000 Chunk；Release 容量、长稳与平稳退化验证 |

持续记录：

- 首次摄入耗时和峰值内存
- 单文件修改后的增量耗时
- 每秒 Embedding 吞吐
- FTS、向量和混合查询延迟
- Topic 首次 Build 和 Refresh 耗时
- SQLite、Blob 和 Artifact 空间增长
- 24 小时循环同步与查询的稳定性

上述规模及完整 Entity、原始资料边界以 `performance.md` 为唯一规范。性能预算必须由固定环境的真实基线持续验证和校准；调整阈值需要记录原因，不能用抬高阈值掩盖回归。

### 5.7 开源安装与 Onboarding 测试

发布、Clean Machine 和 `self --init` 的完整规范见 [`distribution.md`](./distribution.md) 与 [`domains/workspace/initialization.md`](./domains/workspace/initialization.md)。至少验证：

- 从公共 npm Registry 安装 Meta Package 和正确的平台 Optional Dependency，不使用本地 Link/Cache 假装发布成功。
- 无 Bun 的新用户环境可以运行 Self Binary；独立 Release 不要求 Node/Bun。
- `self version/help/doctor --system` 不创建 Root、不联网、不扫描 Home。
- `self --init` 覆盖空目录、非空目录、已有 Self、未完成 Init、Offline 和 Hosted Profile。
- System Preflight 的 pass/warning/blocking 与真实组件状态一致。
- 模型 Discovery/Test 使用内置非私人 Fixture，Secret 不进入日志和 Setup Session。
- Source、Model、VectorSpace、首次 Job、Daemon 选择和最终 Doctor 可取消、Resume、Rollback。
- 非 TTY 使用 Setup Spec 产生与交互选择相同的规范 Plan/Operation。
- npm Upgrade 不静默 Migration；npm Uninstall 不删除 Root。
- Package Tarball、Checksum、SBOM、License、Provenance 和 Git Commit 一致。

## 6. 测试数据体系

### 6.1 三类数据

1. **合成 Fixture**：规模小、结论完全已知，用于精确断言。
2. **脱敏真实 Fixture**：从真实 Obsidian、网页、PDF 和项目中抽取，保留真实复杂度。
3. **生成式规模数据**：用于压力和长稳测试，不用于判断知识正确性。

### 6.2 Small Fixture 必须包含

- 带 Frontmatter、标签、Wiki Link 和附件的 Markdown
- 同名不同实体
- 同一实体的多个别名
- 两份相互支持的独立来源
- 多篇转载同一原始来源的材料
- 明确互相冲突的 Claim
- 过期资料和带时间范围的事实
- 用户观点与外部事实混合内容
- 中英文和代码块
- 损坏文件、空文件和不支持格式
- 带提示注入文本的网页
- 图片、表格和引用定位

Fixture 必须有人工编写的 truth manifest，声明预期实体、关系、Claim、冲突、来源独立性和关键引用。

### 6.3 真实 Vault 的保护

- 永远不直接在用户真实 Vault 上运行写测试。
- 每次运行将选定资料复制到 Test Run 的 `input/`。
- 私人内容进入仓库前必须脱敏或替换。
- 含真实私人数据的失败目录不得自动上传 CI Artifact。
- 测试删除、移动和冲突合并时只操作副本。

## 7. 模型与网络测试策略

模型职责、千问 Embedding 基线、VectorSpace 兼容字段和迁移门禁以 [`model-selection.md`](./model-selection.md) 为准。

### 7.1 Deterministic Suite

用于 PR 和高频终端循环：

- 使用符合真实协议的确定性 Model Provider。
- Embedding 返回固定、可计算的向量。
- 结构化抽取返回版本化 Fixture。
- 本地 HTTP Server 提供网页和错误响应。
- 可以精确断言 ID、状态、排序和 Page IR。

确定性 Provider 只能证明 Self 对模型协议和返回值的处理正确，不能证明真实模型效果。

### 7.2 Recorded Suite

保存经过脱敏的真实 Provider 请求与响应，用于重放：

- 保留 HTTP 状态、结构化输出、Token 用量和延迟范围。
- Fixture 绑定 Provider、模型版本和 Schema 版本。
- 模型升级后旧录制仍用于兼容测试，新录制用于当前效果测试。
- 录制内容不能包含密钥或完整私人知识。

### 7.3 Live Model Suite

定期调用真实模型，验证完整功能：

- 真实 Embedding 的维度、批处理和近邻质量
- 真实结构化抽取的 Schema 合规率
- 真实 Claim、关系和冲突识别
- 真实 Topic 综合与引用支持度
- Provider 超时、限流、断流和重试
- Active Embedding Provider 永久不可用后，FTS + Graph 降级仍可查询，并能从本地 Chunk 启动另一厂商 VectorSpace 重建

Live 测试不对整篇自然语言做逐字 Golden 对比，而是验证结构、证据、关键事实、引用支持度、禁止项和人工评分指标。

所有 Live Suite 必须设置调用预算、最大并发和明确标签，默认不在每个 PR 中运行。

### 7.4 VectorSpace 兼容与迁移测试

- 同为 1024 维但 Model ID 不同的 Query/Chunk 向量必须被拒绝跨空间比较。
- Model、Revision、维度、Instruction、Normalize、Distance 或输入版本变化会产生不同 `space_fingerprint`。
- Hosted 浮动别名的 Sentinel Fingerprint 漂移会暂停写入并告警。
- 新空间 Backfill 支持 checkpoint、崩溃恢复和幂等重试。
- Build 期间旧 Active Space 始终可以查询。
- Coverage、有限值、Normalize、质量和性能未达标时禁止 activate。
- Active ID 原子切换；切换失败或质量回归后可以立即回滚旧空间。
- A/B Shadow Query 只比较指标，不把两个空间的分数直接混合。
- 保留期结束前不能 purge 旧空间，删除必须经过 Plan/Apply。

至少使用千问基线完成一次 Live 迁移演练，并保存 Model、维度、Fixture Hash、质量、延迟和磁盘对比。

### 7.5 网页测试

- 功能回归使用 Test Run 内的本地 HTTP Server。
- Server 提供重定向、编码、ETag、缓存、404、429、500、慢响应和断流场景。
- same-origin 抓取验证边界、循环链接、重复 URL 和最大页数。
- 公网 Live Smoke 只验证少量稳定页面，不把公网内容作为精确 Golden。

## 8. 必须覆盖的真实功能场景

### 8.1 实例与可迁移性

1. 初始化一个实例。
2. 摄入资料并完成查询。
3. 关闭所有进程。
4. 将整个 `instance/` 移动到新路径。
5. 再次运行查询、打开 HTML 和执行增量同步。
6. 断言数据库中没有失效绝对路径，历史引用仍然有效。

### 8.2 单文件与目录摄入

- 添加单个 Markdown。
- 添加包含嵌套目录的 Markdown 集合。
- 添加 Obsidian Vault。
- 添加 PDF、网页、stdin 和项目目录。
- 验证每个 Source 已生成 Snapshot，且对应 IngestionRun 达到 `ready`；不使用含义不明的“Source ready”。
- 验证每个可语义检索内容都有 Chunk 和 Embedding。
- 验证每个 Chunk 都能回到 Snapshot 和原位置。

### 8.3 增量同步

建立初始数据后分别执行：

- 新增一个文件
- 修改一个段落
- 仅修改格式或空白
- 重命名文件
- 移动目录
- 删除文件
- 修改附件
- 重复执行无变化 sync

断言：

- 未变化 Chunk ID、向量和抽取结果被复用。
- 只有受影响对象产生新版本。
- 无变化 sync 不产生新的业务数据。
- 删除使用 tombstone，不破坏历史 Build。
- 受影响 Topic 被标记 stale，未关联 Topic 不受影响。

### 8.4 Connection 后台自动感知

- 使用真实编译后 CLI 创建多个文件和目录 Connection。
- 启动真实 Daemon，并验证文件锁和 SQLite Lease 只允许一个 Leader。
- 修改外部项目 docs 后，无需手工 sync 即可产生 ChangeBatch 和 Source Snapshot；Phase 3 落地后同一批次继续产生 Ingestion Run。
- 高频连续保存只能归档稳定后的最终内容。
- 原生 watcher 丢事件或 overflow 后，定时 reconciliation 最终发现全部变化。
- Target 根目录暂时消失或磁盘卸载时，Target 进入 `unavailable`、所属 Connection 进入 `degraded`，绝不产生全量 delete。
- Daemon 在 Scan、Hash、Batch、Source Copy 等阶段崩溃后可以幂等恢复。
- 外部 Target 只被读取，业务数据、PID、锁、日志和 checkpoint 仍只写入实例 Root。

完整矩阵见 [`domains/connection/testing.md`](./domains/connection/testing.md)。

### 8.5 全量重建与增量等价性

这是 Self 最重要的属性测试之一：

```text
路径 A：初始摄入 → 多次增量修改 → sync
路径 B：使用最终原始资料 → 新实例全量 build
                         │
                         ▼
               比较规范化的知识结果
```

比较时忽略运行 ID、时间戳和物理行号，但必须等价：

- 当前 Document 和 Revision 内容
- 活跃 Chunk 及内容哈希
- FTS 可检索结果
- 向量数量、空间和对应 Chunk
- Entity、Relation、Claim 和冲突组
- Topic 当前知识快照
- 证据链完整性

任何增量路径无法收敛到全量重建结果，都属于高优先级缺陷。

### 8.6 检索与问答

- 精确术语由 FTS 找到。
- 同义表达由向量找到。
- 图谱扩展能找到相关实体和 Claim。
- 时间、来源、项目和可信度过滤正确。
- `search --explain` 能说明召回与重排。
- Ask 的事实结论都有引用。
- 资料不足时返回未知，不使用未标记的模型常识。
- 冲突问题同时呈现双方证据。
- `trace` 能回到 Source Snapshot。

### 8.7 图谱与可信度

完整 Graph Schema、显式链接、Entity 消歧、Claim/Conflict、Generation 重建和性能矩阵见 [`domains/graph/testing.md`](./domains/graph/testing.md)。

- 同名不同实体不会错误合并。
- 别名可以指向同一实体。
- 转载资料不会增加独立来源数量。
- 用户确认、否定和过期状态会影响可信度。
- 删除证据后 Claim 和 Report 进入正确状态。
- Entity merge Plan 能列出重定向和影响对象。
- 可信度页面展示维度和解释，而不是只有一个分数。

### 8.8 Topic 综合报告

- 从多个 Source 创建 Topic。
- 报告区分事实、单一来源、用户观点和 AI 推断。
- 报告列出冲突与 Knowledge Gap。
- 章节的关键 Claim 有引用和可信度。
- 增加新证据后，只更新受影响章节。
- 证据失效后，旧 Build 保留，新 Build 明确变化。
- Topic refresh 重复运行具有幂等性。

### 8.9 HTML 与 Artifact

- Page IR 通过 Schema 校验。
- HTML 中的所有内部链接和资源存在。
- 页面在离线模式下可以打开。
- 单文件 HTML 不依赖丢失的外部文件。
- 关键结论能展开证据和可信度。
- 旧 Build、最新 Build 和 Diff 可以同时查看。
- 模板变化只触发 render，不触发知识重新综合。
- HTML 内容经过转义，不执行来源中的恶意脚本。

### 8.10 修改、删除与恢复

- 没有 Plan 的高风险操作返回退出码 `10`。
- Plan 包含文件、数据库和下游影响。
- 对象版本变化后旧 Plan 无法 Apply。
- 相同幂等键不会重复写入。
- Source detach、delete 和 purge 具有不同结果。
- Note、Entity、Claim 和 Topic 的软删除可以恢复。
- purge 后无孤立向量、Blob 或引用。
- Undo Plan 只恢复被原 Operation 改变的内容。

### 8.11 备份与恢复

- 在 WAL 有活动写入时创建一致性备份。
- 将备份恢复到另一个新目录。
- 恢复后执行 verify、search、trace 和 open Artifact。
- 模拟缺失 Blob、损坏数据库页和断裂引用。
- `verify` 只报告，不静默修改。
- Repair Plan 明确列出可修复和不可修复问题。

## 9. HTML 的自动化验证

HTML 不能只检查文件是否存在。建议分四层验证：

1. **结构验证**：Page IR 和 Build Manifest 通过 Schema。
2. **DOM 验证**：标题、章节、Citation、可信度和冲突组件存在。
3. **浏览器验证**：使用真实无头浏览器加载页面，检查控制台错误、资源 404、交互和响应式布局。
4. **视觉回归**：对稳定 Fixture 截图，在允许的小范围像素差内比较。

浏览器运行目录、缓存和截图也必须位于 Test Run 中。默认禁用外网，确保 HTML 可以真正离线工作。

自然语言正文不做全量快照比较；优先比较 Page IR、结构、引用、关键事实和 DOM 语义，避免措辞变化造成大量无意义失败。

## 10. 故障注入

测试构建应提供明确故障点，例如：

```text
after_blob_write
after_revision_insert
after_chunk_publish
during_embedding_batch
before_vector_index_swap
after_build_files_written
before_latest_pointer_swap
during_backup
during_migration
```

每个故障点执行：

1. 启动真实命令。
2. 在指定阶段返回错误或强制终止进程。
3. 重新打开实例并执行 `self verify`。
4. 重试原命令。
5. 与无故障运行的最终规范状态比较。

还需要覆盖：磁盘空间不足、只读文件、SQLite busy、锁遗留、模型超时、HTTP 429、无效 JSON、进程 SIGTERM 和强制 kill。

## 11. 属性测试与不变量

除了固定案例，还应使用属性测试不断生成输入组合。关键属性包括：

- 相同内容重复摄入不会增加活跃知识数量。
- 无变化 sync 是幂等的。
- 输入文件遍历顺序不改变最终规范知识。
- 实例根目录改变不影响对象关系和查询结果。
- 增量更新最终收敛到全量重建结果。
- 任意活跃 Claim 都至少有证据或明确的 `user_asserted` 标记。
- 任意 Embedding 都属于存在的 Chunk 和 VectorSpace。
- 任意 Query Embedding 与目标 Chunk Embedding 的 `space_fingerprint` 相同。
- Active VectorSpace 在任意已提交状态下都是完整且通过校验的 ready 空间。
- 任意 Artifact Citation 都指向存在或历史保留的证据。
- `latest` 永远指向完整成功的 Build。
- 软删除后历史 Build 仍可解释。
- 永久清理后不存在悬空引用。
- 相同幂等键和相同请求只产生一个 Operation。

这些不变量应既存在于领域单元测试中，也存在于端到端数据库检查器中。

## 12. 终端开发循环

### 12.1 快速循环

开发时保持一个简单、稳定的反馈循环：

```bash
# 第一次运行或修改核心代码后
self-test suite fast

# 针对失败场景反复运行并保留目录
self-test scenario topic-refresh-incremental --keep

# 修复后重放原失败环境
self-test replay .test-runs/<failed-run-id>

# 提交前运行标准套件
self-test suite standard
```

可以使用文件监听工具触发 Fast Suite，但每轮仍创建全新的 Test Run，不能依赖上轮残留状态。

### 12.2 故障分析循环

```text
运行场景
  → 保留失败目录
  → 查看 commands.jsonl 和首个失败断言
  → 使用 self verify / get / trace 检查真实状态
  → 修复实现
  → replay 同一失败场景
  → 新目录重新运行该场景
  → 运行所属领域测试
  → 运行 Standard Suite
```

Replay 用于复现，Fresh Run 用于证明修复不依赖旧目录中的偶然状态，两者缺一不可。

### 12.3 手工真实验收

自动化测试之外，每个 MVP 和 Release 候选需要执行一次人工终端验收：

1. 用新目录初始化 Self。
2. 导入一份脱敏但真实的 Vault 副本。
3. 添加真实网页和 PDF。
4. 检查摄入失败和来源回溯。
5. 执行若干已知答案和未知答案查询。
6. 创建一个真实 Topic 并检查综合报告。
7. 打开 HTML，逐条抽查引用和可信度。
8. 修改输入资料并执行 refresh。
9. 测试 Plan/Apply 删除和恢复。
10. 备份、移动实例目录并恢复验证。

人工验收必须记录命令和发现的问题，不能只给出“看起来正常”的结论。

## 13. 测试套件与执行频率

| Suite | 内容 | 建议频率 |
| --- | --- | --- |
| `fast` | 单元、关键领域、CLI 契约、小型确定性 E2E | 本地循环、每次提交 |
| `standard` | 全部领域集成、小型完整 E2E、迁移、目录外写入 | 每个 PR |
| `full` | Medium 数据、故障注入、浏览器、性能回归 | Nightly |
| `live` | 真实模型、真实公网、质量评估和成本统计 | Nightly 或按需 |
| `soak` | 大型 Vault、并发、24 小时同步查询循环 | 定期 |
| `release` | Full + Live + Soak 摘要 + 备份恢复 + 迁移矩阵 | 发布前 |

Fast Suite 应尽量控制在几分钟内。若测试变慢，应移动到合适 Suite，而不是直接删除真实测试。

## 14. 发布质量门禁

### Search Alpha

- 单目录迁移通过。
- Markdown、目录、Vault 和网页摄入通过。
- FTS、向量和 hybrid search 通过。
- 千问 Embedding 基线及 `create → build → verify → activate → migrate/rollback` 迁移通过。
- 增量与全量重建等价性通过。
- 没有目录外业务写入。

### Knowledge Alpha

- Entity、Relation、Claim 和冲突 Fixture 通过。
- 可信度维度和来源独立性通过。
- Ask、引用校验、资料不足和 trace 通过。
- 至少一个真实模型 Suite 达标。

### MVP

- Topic 综合报告的结构和证据通过。
- 增量 Refresh 只影响相关章节。
- HTML 离线、浏览器、Citation 和视觉回归通过。
- Artifact 历史、Diff 和迁移后打开通过。

### v1.0

- Plan/Apply、幂等、并发冲突和恢复通过。
- Crash Matrix 无一致性缺陷。
- Backup Restore 在新路径和另一环境验证通过。
- Large 数据性能预算通过。
- Release Suite 无未解释的高优先级失败。

## 15. 测试覆盖度的衡量

不只统计代码覆盖率，还要维护：

- CLI 命令覆盖率
- 领域状态转换覆盖率
- 数据源类型覆盖率
- SQLite 迁移版本对覆盖率
- 故障注入点覆盖率
- Source → Chunk → Claim → Topic → Artifact 证据链覆盖率
- 增量变更类型覆盖率
- 删除影响类型覆盖率
- 模型 Provider 和结构化 Schema 覆盖率
- 操作系统与架构覆盖率

建议维护机器可读 `coverage-manifest`，将每条公开 CLI 命令和关键状态转换映射到至少一个测试场景。代码覆盖率可以发现未执行分支，但不能替代这些产品能力覆盖指标。

## 16. 测试期间的注意事项

### 数据安全

- 不在真实 Vault 上运行写操作。
- 不将私人失败目录上传到公共 CI。
- 日志默认脱敏 API Key、Token、Cookie、邮箱和本地用户名。
- 测试网页视为不可信内容，验证其不能注入 Agent 指令。

### 可重复性

- 固定时区、Locale 和随机种子。
- 使用可控时钟测试 freshness 和时间范围。
- 固定 Parser、Chunker、模型、模板和 Schema 版本。
- 不使用文件系统遍历顺序作为业务顺序。
- 不对非确定性模型正文做逐字断言。

### 清理

- 只自动删除明确标记为 passed 的 Test Run。
- 清理命令必须验证目标位于 `.test-runs/` 下。
- 不允许使用未经路径检查的递归删除。
- Live 模型下载和浏览器缓存必须纳入 Test Run 或明确的只读测试依赖。

### 成本和网络

- Live Suite 设置 Token、金额、并发和最长时间预算。
- 网络错误与产品缺陷分开记录，但不能静默忽略。
- 真实 Provider 的失败必须保留请求 ID 和脱敏错误。
- 公网内容变化时更新语义断言，不保存侵权的完整内容副本。

### 失败判断

- 首个不变量破坏应成为主要错误，后续连锁错误作为附加信息。
- `partial` 不能当作成功。
- Flaky 测试必须被标记、跟踪和修复，不能无限自动重试掩盖。
- 真实模型质量下降应进入趋势报告，而不是只依赖一次通过或失败。

## 17. 测试框架的实施顺序

1. 建立 Test Run 目录和环境隔离器。
2. 实现真实 CLI 子进程执行、JSON envelope 和退出码断言。
3. 实现失败目录保留、run.json 和 replay。
4. 建立 Small Fixture 和 truth manifest。
5. 实现 SQLite 不变量检查器。
6. 实现命令覆盖矩阵和 `self commands --json` 对照。
7. 建立 Source → Chunk 的第一个 E2E。
8. 加入目录外写入审计。
9. 加入增量与全量重建等价性检查器。
10. 加入确定性 Model Provider 和本地 HTTP Server。
11. 加入 Graph、Ask、Topic 和 Artifact 场景。
12. 加入真实浏览器 HTML 测试和视觉回归。
13. 加入故障注入、迁移和备份恢复矩阵。
14. 加入 Live Model、Medium/Large 数据和长稳测试。

测试框架应与产品同步生长。每实现一个新的 CLI 命令、领域状态或数据源类型，就同时扩展命令覆盖矩阵、真实场景和失败恢复测试；不能等功能全部完成后再补一套只验证表面的测试。
