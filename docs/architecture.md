# Self：面向 AI 时代的个人知识操作系统

> 状态：总体设计草案
> 目标形态：Local-first、单目录、自包含、Agent-first 的 CLI 知识引擎

相关文档：

- [设计约定与一致性规则](./design-conventions.md)
- [领域模型索引](./domains/README.md)
- [TypeScript + Bun 技术选型](./technology-stack.md)
- [工程实现、构建与部署规范](./engineering-standards.md)
- [性能边界与响应时间预算](./performance.md)
- [模型选择、向量空间与迁移规范](./model-selection.md)
- [开源分发、安装与首次初始化](./distribution.md)
- [Roadmap 索引](./roadmap/README.md)
- [当前实现路线图](./roadmap/2026-07-11-initial-implementation.md)
- [测试机制与测试框架](./testing.md)

## 1. 产品定义

Self 不是“给 Obsidian 加一个聊天框”，也不是另一个以 Markdown 页面为中心的笔记软件。

Self 是一个由 CLI 驱动的个人知识操作系统。它持续接收来自 Obsidian、网页、PDF、对话、项目文件、图片及其他来源的信息，将每个来源完整摄入、拆分和重组到统一的数据库与向量知识底座中，再将其转化为可追溯、可检索、可关联、可增量维护的知识，并根据当前任务生成 Markdown、图谱、图表或精美的交互式 HTML 页面。

传统笔记以“人维护目录和页面”为中心；Self 以“知识对象、来源证据和关系”为中心。页面只是知识在某个时间、面向某个问题的一次编译结果。

```text
Obsidian / 网页 / PDF / 对话 / 项目文件 / 图片
                         │
                         ▼
                  统一采集与版本记录
                         │
                         ▼
        知识对象 + 来源证据 + 关系图谱 + 向量索引
                         │
                         ▼
          搜索 / 关联 / 汇总 / 推理 / 冲突检测
                         │
                         ▼
       Markdown / HTML / 图谱 / 时间线 / 专题报告
```

一句话概括：

> Self 将个人知识从一组静态页面，转变为一个有来源、可计算、可组合、可由 AI Agent 安全操作的长期知识系统。

## 2. 核心设计原则

### 2.1 单目录就是一个完整的 Self 实例

一个 Self 知识库的全部运行数据必须位于同一个根目录中，包括：

- 原始文档和导入快照
- Obsidian 笔记和附件
- SQLite 主数据库
- 全文索引、向量数据和知识图谱
- 模板、主题及页面组件
- AI 生成的中间结果和最终 HTML
- 历史版本、构建记录、日志和备份
- 可选的本地模型、模型缓存及 SQLite 扩展

Self 不应偷偷向用户目录、系统缓存目录或其他隐藏位置写入业务数据。移动、复制或备份这个根目录，应当能够完整迁移知识库。

CLI 程序本身可以安装在系统路径中，但知识库的数据、状态和历史不得依赖全局目录。所有命令都应支持显式指定根目录：

```bash
self --root /path/to/my-self <command>
```

在知识库内部执行时，CLI 也可以向上查找 `self.toml`，自动识别实例根目录。

### 2.2 Local-first，而不是云服务的本地缓存

- 本地数据是权威数据。
- 没有网络时，浏览、全文搜索、历史查询和已有页面查看仍然可用。
- 云端对话模型、Embedding 模型和重排模型都是可替换的计算提供者。
- 用户可以切换到本地模型，而不改变知识对象和存储格式。
- 默认不上传完整知识库；每次模型调用只发送完成任务所需的最小上下文。

### 2.3 原始资料负责存证，统一知识底座负责运行

原始文档必须保存在 Self 根目录中，但它们的主要作用是存证、追溯、重新解析和灾难恢复。Self 不能在查询时临时翻找一堆原始文件，也不能只在数据库中保存文件路径或摘要。

任何信息来源只有完成下列过程后，才算真正进入 Self：

```text
原始来源
  → 内部归档
  → 文本提取 / OCR / 语音转写 / 结构解析
  → 规范化
  → 语义切片
  → 写入 SQLite
  → 全文索引与向量化
  → 实体、关系、Claim 和上下文关联
  → 可查询的统一知识底座
```

系统数据分为三层：

1. **证据层**：用户笔记、导入文件、网页快照、附件、对话等不可变或可版本化的原始资料。
2. **知识底座层**：来源、文档版本、规范化内容、片段、向量、实体、关系、Claim、时间和项目上下文。这是 Self 日常检索、组合与推理直接操作的主体。
3. **表达层**：AI 摘要、Markdown、图谱、图表和 HTML 专题页等面向具体问题生成的视图。

原始资料不是系统的主要查询模型，而是知识底座中每个对象的证据锚点。向量也不是脱离原文的另一份知识；它是规范化 Chunk 在特定 Embedding 模型下的检索表示。

默认情况下，搜索、问答、整理和页面构建只面向统一知识底座运行，不直接扫描原始文件。原始资料发生变化时，由增量摄入管线更新知识底座，再使受影响的页面和结论进入待更新状态。

这种设计同时满足两个目标：知识已经被充分“打碎并揉进”数据库，可以被 AI 高效操作；任何结论仍然能够沿着 `Claim → Chunk → Revision → Source` 回到原始证据。

### 2.4 全量摄入，而不是按需读取

Self 对所有已接纳来源执行完整摄入，不能只处理用户当前提问命中的少量内容。不同模态最终都要形成可查询的内部表示：

- Markdown、网页和代码：保留结构并切分为语义 Chunk。
- PDF 和 Office 文档：提取正文、标题层级、表格、图片说明和页码定位。
- 图片：保存原图，并按需生成 OCR、视觉描述和可检索标签。
- 音频和视频：保存媒体文件，并生成带时间戳的转写片段。
- 对话：保留会话、角色、时间和上下文边界，而不是合并成无结构文本。
- 项目目录：提取文件、符号、依赖和项目语义，但避免把构建产物及无意义缓存摄入。

“完整摄入”不意味着所有字节都生成向量。二进制文件、元数据和关系写入 SQLite；能够承载语义的信息被转换成 Chunk 并向量化；精确名称和代码符号进入全文或结构化索引。所有表示共同组成统一知识底座。

完整摄入链必须按领域分别记录状态：Source Snapshot 是否已归档，IngestionRun 是否完成解析和发布，Knowledge 的 FTS/Vector 是否可用，Graph enrichment 是否完成。默认查询只使用已经发布的 Revision/Chunk，并明确标注索引或 enrichment 尚未完成的部分；任何 partial/failed 必须可见、可重试，不能用一个含义模糊的全局 `ready` 掩盖。

### 2.5 所有 AI 结论都要能回到证据

Self 生成的每个重要结论，应尽可能记录：

- 来源文档和具体片段
- 原始内容版本
- 生成时间
- 使用的模型及配置
- 置信度
- 它是原文事实、用户观点，还是 AI 推断

任何专题页都应允许用户从页面中的结论追溯到原始笔记或资料。

### 2.6 增量优先，版本化而不是原地覆盖

重复导入同一资料时不重复存储；文档只修改一部分时，只重新处理受影响的片段；专题页再次生成时，优先复用上次检索和整理结果，并把新增、变化和失效内容合并进去。

更新后的页面产生一个新版本，旧版本继续保留。系统通过 `latest` 指针标记当前版本，而不是覆盖历史产物。

### 2.7 CLI 首先服务于 Agent，同时兼顾人类

Self CLI 是知识引擎的稳定协议面，而不仅是一个终端界面。命令必须具备：

- 稳定的 JSON 输入输出
- stdin/stdout 管道能力
- 明确的退出码和错误类型
- 幂等写入
- 稳定的对象 ID
- `--plan`、`--dry-run` 和独立的 `self apply <PLAN_ID>`
- 可审计、可恢复的修改记录
- 长任务的任务 ID、进度查询和取消能力
- 对话模型、Embedding 模型和重排模型可插拔

未来的 MCP、HTTP API、桌面端和 Obsidian 插件都应建立在同一个核心引擎上。

## 3. 单目录布局

建议的默认目录结构如下：

```text
my-self/
├── self.toml                     # 实例配置和格式版本
├── content/
│   ├── notes/                    # 人工笔记，可直接作为 Obsidian Vault
│   ├── inbox/                    # 等待整理的临时输入
│   ├── sources/                  # 网页、PDF、对话等原始资料快照
│   └── assets/                   # 图片、音频及其他附件
├── data/
│   ├── self.sqlite3              # 唯一主数据库
│   ├── self.sqlite3-wal          # SQLite WAL，运行时可能存在
│   └── self.sqlite3-shm          # SQLite 共享内存文件，运行时可能存在
├── artifacts/
│   ├── topics/                   # 专题页面及其历史版本
│   ├── reports/                  # 报告、摘要等派生产物
│   └── exports/                  # 用户显式导出的文件
├── templates/
│   ├── pages/                    # 页面结构模板
│   ├── components/               # 时间线、关系图、证据卡等组件
│   └── themes/                   # CSS、字体和主题资源
├── models/
│   ├── local/                    # 可选的本地模型
│   └── cache/                    # 显式启用的模型缓存
├── runtime/
│   ├── extensions/               # sqlite-vec 等平台相关扩展
│   ├── jobs/                     # 长任务状态
│   ├── locks/                    # 进程锁
│   ├── tmp/                      # 可安全清理的临时文件
│   └── logs/                     # 结构化日志
└── backups/                      # 数据库快照和可选的完整备份
```

目录设计规则：

- `content/` 中的内容面向人类，并尽可能使用长期可读的开放格式。
- `data/self.sqlite3` 是结构化状态的唯一数据库，避免多个数据库之间的一致性问题。
- `artifacts/` 中的每个产物都必须具有构建清单和来源快照。
- `runtime/tmp/` 可以删除；其他目录不能在没有明确命令的情况下自动清理。
- 外部文件默认导入或快照到 `content/sources/`，不能只保存一个随时会失效的绝对路径。
- 可以配置外部只读数据源，但 Self 必须保留足以重现结果的内部快照。严格自包含模式下不允许依赖外部路径。

## 4. 存储架构

### 4.1 SQLite 作为唯一结构化数据库

Self 使用文件型 SQLite 保存：

- 数据源和导入记录
- Connection、监控目标、文件 Observation、扫描和变化批次
- 文档、版本及内容片段
- 实体、关系和知识主张
- 标签、集合和项目
- 全文搜索索引
- Embedding 向量
- 模型与模板版本
- 构建任务、页面版本和依赖关系
- 操作审计、迁移状态及软删除记录

推荐启用：

- WAL 模式
- 外键约束
- `busy_timeout`
- 数据库格式版本和自动迁移
- 定期 checkpoint
- 写事务和进程级写锁

SQLite 数据库、WAL 和 SHM 文件都位于 `data/` 中，不产生散落的服务进程数据。

### 4.2 向量检索使用 SQLite 向量扩展

向量不单独部署服务型数据库。优先使用 `sqlite-vec` 或兼容的 SQLite 向量扩展，将 Embedding 与文档片段保存在同一个 SQLite 文件中。

每条向量记录至少关联：

- `chunk_id`
- `vector_space_id` 和 `space_fingerprint`
- Embedding Provider、模型 ID、实际 Revision 和 Tokenizer 版本
- 向量维度、dtype、Normalize 和 Distance
- Query/Document Instruction 与输入算法版本
- 内容哈希
- 生成时间
- 是否已经失效

当用户切换 Embedding 模型时，新旧向量可以在迁移期间并存。检索请求必须明确使用一个 ready/active 向量空间；即使维度相同，只要 Fingerprint 不同也禁止混合比较。安全迁移、千问基线和维度选择见 [`model-selection.md`](./model-selection.md)。

为了保证单目录可迁移性，SQLite 扩展可以静态编译进 Self，或者按平台放入 `runtime/extensions/`。不能假定目标机器已经全局安装了扩展。

### 4.3 全文、向量和图谱混合检索

向量搜索只负责寻找语义相似内容，不能独立承担全部检索。推荐的查询流程是：

```text
用户问题
   ├── SQLite FTS：精确术语和关键词
   ├── Vector：语义相似内容
   ├── Graph：相关实体、关系和相邻主张
   └── 时间、项目、来源、可信度等结构化过滤
                         │
                         ▼
                    合并与去重
                         │
                         ▼
                       重排
                         │
                         ▼
              带来源的上下文和答案
```

知识图谱直接保存在同一个 SQLite 的邻接表、Entity、Relation、Claim 和 Evidence 表中；邻居查询使用组合索引，有界路径使用 Recursive CTE。语义 Top-K 单独保存为绑定 VectorSpace 的可重建投影，不能冒充事实边。JSON-LD/GraphML 只是导出格式，Cytoscape.js 只是展示层。只有真实 Benchmark 证明超过 SQLite 能力后，才允许增加可删除、可重建的专用图索引。完整设计见 [`domains/graph/`](./domains/graph/)。

### 4.4 大文件采用内容寻址存储

PDF、网页快照、图片、音频等大文件保存在文件系统中，数据库只记录元数据、内容哈希和相对路径。

可以使用 SHA-256 内容哈希进行去重：相同内容只保存一次，不同来源引用同一个对象。所有路径必须相对于 Self 根目录，避免迁移后失效。

## 5. 核心知识模型

Self 不应把目录结构当作知识结构。目录只能表达一种层级，而知识天然是多关系网络。

建议的核心对象如下：

| 对象 | 含义 |
| --- | --- |
| `Connection` | 对外部文件或目录的持续监控关系、扫描策略和健康状态 |
| `Source` | 网页、文件、对话、终端输入等信息来源 |
| `Document` | 一份逻辑上的完整内容 |
| `Revision` | 文档在某个时间点的不可变版本 |
| `Chunk` | 可检索、可引用、可向量化的内容片段 |
| `Entity` | 人物、项目、概念、工具、组织等实体 |
| `Relation` | 实体之间带类型、来源和置信度的关系 |
| `Claim` | 带证据、时间和可信度的信息主张 |
| `Note` | 用户主动维护或确认的内容 |
| `Collection` | 专题、项目或知识空间 |
| `Topic` | 围绕一个明确主题持续维护的知识视图、边界和综合结论 |
| `Artifact` | AI 生成的 HTML、报告、图表等产物 |
| `Build` | 某个 Artifact 的一次可重现构建 |

`Claim` 是系统从“能搜索的笔记库”走向“能维护的知识系统”的关键。它使 Self 能够识别来源、比较观点、标记冲突，并在资料变化时定位受到影响的结论。

AI 提取出的实体、关系和主张必须标记为机器生成。经过用户确认后可以提升可信级别，但不能抹掉最初的生成记录。

### 5.1 图谱是综合知识的组织骨架

知识图谱不能只保存 `A related_to B` 这类模糊关系。每条边至少应该包含：

- 主体、关系类型和客体
- 支撑该关系的 Claim 与 Chunk
- 关系适用的时间范围
- 来源、提取方式和模型版本
- 可信度及用户确认状态
- 与其他关系的冲突或替代关系

图谱的作用是把已经进入统一知识底座的碎片重新组织起来，使 Self 能够沿着概念、人物、项目、事件、时间和因果关系发现相关知识。图谱本身不替代证据，图中的每个可陈述事实都必须回到 Claim 和原始来源。

AI 自动抽取的关系先进入候选状态。重复来源需要合并，别名需要消歧，互相矛盾的关系需要同时保留并形成冲突组，而不是让最后写入的一条覆盖其他观点。

### 5.2 Topic 是持续生长的综合报告

任何值得长期关注的结构化主题，都应在 Self 中成为一个 `Topic`，而不是一次性的搜索关键词或 HTML 文件。例如“子智能体”“长期记忆”“个人知识管理”都可以是 Topic。

一个 Topic 至少保存：

- 主题定义、范围、别名和排除条件
- 核心实体及其局部知识图谱
- 已纳入的 Claim、来源和证据版本
- 共识、分歧、冲突和未知问题
- 当前报告结构和 Page IR
- 每个结论及章节的可信度
- 上次综合时间、数据水位和增量游标
- 历次构建及它们之间的变化

Topic 的默认呈现形式是一份跨来源的综合报告。它不是简单罗列相似片段，而是将来自笔记、网页、文档、对话和项目的知识去重、对齐、比较和归纳后，形成一篇结构完整、证据透明、能够表达不确定性的报告。

### 5.3 综合报告生成流程

```text
定义 Topic 范围
    → 混合检索候选 Chunk 与 Claim
    → 沿知识图谱扩展相关实体和关系
    → 语义去重、实体消歧和 Claim 聚类
    → 判断来源是否独立
    → 识别共识、冲突、时间变化和信息缺口
    → 建立报告结构
    → 分章节综合
    → 校验引用是否真正支持结论
    → 计算并解释可信度
    → 生成 Page IR 和 HTML
```

报告至少应区分：

- **有充分证据的结论**：存在直接证据，且有多个独立来源相互支持。
- **单一来源陈述**：有明确来源，但尚未获得独立印证。
- **用户观点**：来自用户自己的判断，不伪装成外部事实。
- **AI 推断**：由多个事实推导而来，但来源中没有直接陈述。
- **争议内容**：不同来源给出不兼容的说法。
- **未知问题**：当前知识底座不足以作出判断。

Self 不应为了让报告显得完整而填补未知内容。能够诚实表达“不确定”“存在冲突”和“资料不足”，是可信综合报告的核心能力。

### 5.4 可解释的可信度模型

可信度不是模型随手生成的一个百分比，也不能仅以来源数量计算。Self 应保存构成可信度的多个维度：

| 维度 | 说明 |
| --- | --- |
| `source_quality` | 来源本身的权威性、原始性和用户设定的信任级别 |
| `directness` | 来源是直接陈述、原始数据，还是二手转述 |
| `corroboration` | 是否有相互独立的来源提供一致证据 |
| `freshness` | 资料时间是否适合当前问题，是否可能已经过期 |
| `extraction_quality` | OCR、解析、实体识别和 Claim 抽取是否可靠 |
| `consistency` | 是否存在尚未解决的反证或冲突 |
| `user_verification` | 用户是否亲自确认、修正或否定过该结论 |

每个 Claim 保存各维度、综合等级和生成理由。页面可以使用“高 / 中 / 低 / 有争议 / 未知”等清晰标签，同时允许展开查看评分依据。若展示数值，它只能表示系统内部评估，不得包装成客观概率。

章节可信度应由其关键 Claim 决定；整份报告则同时展示证据强度、资料覆盖度和未解决冲突，不能简单计算所有 Claim 的平均分。报告必须让用户看见“为什么可信”以及“哪里还不可信”。

## 6. 数据采集与增量索引

### 6.1 导入流程

```text
接收输入
  → 保存或定位原始资料
  → 计算内容哈希
  → 判断新增、未变化或已修改
  → 解析为规范文档
  → 切分 Chunk
  → 增量更新 FTS
  → 仅为变化的 Chunk 计算向量
  → 提取实体、关系和 Claim
  → 建立来源及版本关系
  → 提交一个原子事务
```

### 6.2 增量识别

系统至少维护三层哈希：

- 文件哈希：快速判断整个文件是否变化。
- 规范内容哈希：忽略无意义的格式差异。
- Chunk 哈希：只重新处理真正变化的片段。

文档更新时：

- 未变化的 Chunk 继续复用原向量和知识提取结果。
- 新增 Chunk 进入索引和知识抽取。
- 修改 Chunk 产生新版本，并使旧向量失效。
- 删除 Chunk 使用 tombstone 标记，不立即破坏历史构建。
- 依赖旧 Chunk 的 Claim 和 Artifact 被标记为“需要复核”或“可以增量更新”。

### 6.3 防止 AI 知识回音室

AI 生成的 Artifact 不应默认作为新的事实来源再次进入知识库，否则容易出现“模型生成内容引用模型生成内容”的循环放大。

派生内容可以被搜索，但检索时必须区分：

- 原始资料
- 用户原创内容
- 用户确认的 AI 内容
- 未确认的 AI 派生内容

只有用户明确确认，或者命令显式指定时，派生内容才可以晋升为新的知识来源。

## 7. HTML 专题页与增量构建

### 7.1 页面是可版本化的编译产物

模型不应每次自由生成一整份不可维护的 HTML。Self 先生成稳定的页面中间表示（Page IR），再由模板和组件渲染器编译为 HTML。

Page IR 可以表达：

- 概念卡片
- 摘要和核心结论
- 可信度总览和资料覆盖度
- 引用与证据块
- 时间线
- 对比矩阵
- 关系图谱
- 数据图表
- 图片画廊
- 问题、争议和冲突观点
- AI 推断与未知问题
- 学习路线
- 原始资料目录

示意：

```json
{
  "title": "子智能体知识地图",
  "sections": [
    { "type": "hero", "summary": "..." },
    { "type": "concept-map", "entity_ids": ["..."] },
    { "type": "comparison", "claim_ids": ["..."] },
    { "type": "timeline", "event_ids": ["..."] },
    { "type": "evidence-list", "claim_ids": ["..."] }
  ]
}
```

### 7.2 每次构建都完整归档

每次生成 HTML，都为该版本保存一个独立目录：

```text
artifacts/topics/subagents/
├── topic.json
├── latest.json
└── builds/
    └── 2026-07-11T083000Z_ab12cd/
        ├── manifest.json          # 构建 ID、父版本、状态和依赖哈希
        ├── request.md             # 用户目标和明确的生成要求
        ├── query-plan.json        # 检索计划
        ├── retrieval.json         # 实际采用的来源、Chunk 和版本
        ├── knowledge-snapshot.json# 本次使用的 Claim、实体和关系快照
        ├── page.ir.json           # 可继续增量修改的页面中间表示
        ├── confidence.json        # Claim、章节和整份报告的可信度依据
        ├── changes.json           # 相对父版本的新增、修改、删除和失效项
        ├── index.html             # 最终页面
        ├── assets/                # 本次构建所需的图片、CSS、JS 等
        └── citations.json         # 页面内容到原始证据的映射
```

归档保存的是可复现输入、结构化中间结果和最终产物。可以按配置保存经过脱敏的模型请求与响应，但不保存或伪造模型内部推理过程。

### 7.3 基于旧版本增量扩展

当用户再次请求同一主题时，Self 不从零开始，而是：

1. 定位该专题的 `latest` 构建。
2. 读取上次的查询、知识快照、Page IR 和依赖清单。
3. 根据上次构建时间和依赖哈希，只检索新增或变化的数据。
4. 将候选知识分类为：未变化、新增、修改、失效、存在冲突。
5. 判断哪些页面组件受到影响。
6. 复用没有变化的组件数据，只重新整理受影响部分。
7. 创建一个以旧构建为父版本的新构建。
8. 输出页面差异，并更新 `latest.json`。

```text
上次 Page IR + 上次知识快照
             │
             ├── 未变化内容 ──────────────┐
             │                            │
新资料 ──→ 增量检索 ──→ 变化与冲突检测 ──→ 局部更新 Page IR
                                          │
                                          ▼
                                  新版本 HTML + 差异记录
```

这里真正需要增量化的是昂贵的检索、Embedding、知识抽取和内容综合。HTML 编译本身通常很快，必要时可以完整重编译，以确保最终页面内部一致。

### 7.4 构建清单与缓存失效

`manifest.json` 至少记录：

- 构建 ID 和父构建 ID
- 用户请求哈希
- 查询计划版本
- 引用的 Document、Revision、Chunk、Claim 和 Entity ID
- 所有依赖的内容哈希
- 对话模型、Embedding 模型和重排模型版本
- 模板、组件、主题和 Page IR 版本
- 构建时间、耗时和结果状态

以下变化会使相关缓存失效：

- 来源内容或 Chunk 哈希发生变化
- 用户改变专题目标或过滤条件
- 模型或关键提示模板发生变化
- Page IR、组件或主题出现不兼容升级
- 引用的 Claim 被撤销、冲突或重新确认

仅 CSS 等纯展示变化时，可以复用 Page IR 和知识快照，直接重新渲染页面。

## 8. Obsidian 的定位与同步边界

`content/notes/` 可以直接作为一个标准 Obsidian Vault。Self 应保留 Markdown、Wiki Link、标签、Frontmatter、附件和块引用等常见语义。

推荐边界：

- Obsidian 负责人工阅读和编辑 Markdown。
- Self 负责采集、索引、关联、综合、生成和审计。
- 人工笔记默认优先于未经确认的 AI 内容。
- AI 写回原始笔记前必须先生成计划和差异。
- 文件重命名、删除、冲突合并均记录操作日志。
- Self 生成的大型专题页面放在 `artifacts/`，不强行塞进 Vault 的人工目录结构。

对于用户已有的外部 Vault，首次使用可以提供两种明确模式：

1. **迁入模式（推荐）**：将 Vault 复制或移动到 `content/notes/`，得到完全自包含实例。
2. **镜像模式**：外部 Vault 作为只读源，Self 在根目录中保存版本快照；该模式不是完全自包含，应持续提示迁入。

### 8.1 Connection：持续感知分散资料的变化

用户散落在不同项目和目录中的资料由独立 Connection 领域持续监控。Connection 持久记录监控目标、过滤规则、扫描策略、最近文件清单、变化批次和后台进程健康状态。

```text
外部文件/目录
  → 原生 watcher 低延迟提示
  → 定时 reconciliation 权威对账
  → created/modified/deleted/renamed ChangeBatch
  → Source 内部归档
  → Ingestion 增量处理
  → Knowledge / Graph / Topic 失效传播
```

关键边界：

- 原生文件事件可能丢失或重复，只作为提示；完整扫描对账负责最终正确性。
- 外部目录暂时不可用时 Connection 进入 `degraded`，不能把所有已知文件误判为删除。
- Connection 只读外部路径；被接纳内容必须先形成 Self Root 内部 Snapshot。
- Connection Daemon 的 PID、锁、Lease、日志和 Job 全部位于 Self Root。
- 同一个实例只允许一个 active Daemon Leader。
- Connection 停止监控不等于删除已经归档的 Source 和知识。

详细设计见 [`domains/connection/`](./domains/connection/)。

## 9. CLI 命令设计

### 9.1 命令设计原则

Self CLI 的主要调用者是 Agent，但人类必须能够通过 `self help` 理解和直接使用。命令采用稳定的“资源 + 动作”结构：

```text
self [全局参数] <资源> <动作> [对象] [参数]
```

例如：

```bash
self source add ~/notes --kind markdown
self knowledge rebuild --layer vectors
self knowledge rebuild --layer vectors --vector-space vector-space:vsp_123
self topic refresh topic:top_123
self artifact export artifact:art_123 --format html
```

稳定 ID 统一采用 `<resource>:<typed-id>`，typed-id 由类型缩写和 UUID v7/ULID 组成。文档示例简写为 `_123`：

| 资源 | 示例 |
| --- | --- |
| Workspace / Setup Session / Diagnostic | `workspace:ws_123`、`setup:stp_123`、`diagnostics:diag_123` |
| Connection / Target / Observation | `connection:con_123`、`target:ct_123`、`observation:obs_123` |
| Source / Snapshot | `source:src_123`、`snapshot:snp_123` |
| Ingestion / Document / Revision / Chunk | `ingestion:ing_123`、`document:doc_123`、`revision:rev_123`、`chunk:chk_123` |
| Vector Space | `vector-space:vsp_123` |
| Graph Node / Entity / Relation | `graph-node:gn_123`、`entity:ent_123`、`relation:rel_123` |
| Claim / Evidence / Reference | `claim:clm_123`、`evidence:evd_123`、`reference:gref_123` |
| Conflict / Graph Generation / Extraction | `conflict:cfs_123`、`generation:ggen_123`、`extraction:gex_123` |
| Note / Topic / Report Section | `note:note_123`、`topic:top_123`、`section:sec_123` |
| Artifact / Build | `artifact:art_123`、`build:bld_123` |
| Scan / Change | `scan:scan_123`、`change-batch:cb_123`、`change-item:ci_123` |
| Model / Job | `model:mdl_123`、`job:job_123` |
| Plan / Operation / Backup | `plan:plan_123`、`operation:op_123`、`backup:bkp_123` |

命令输出、数据库、日志和 Artifact Manifest 必须使用同一个完整 ID；不得在不同领域为同一对象重新生成别名 ID。

人类和 Agent 都必须能够在运行时发现能力：

```bash
self help
self source --help
self source add --help
self completion zsh
self commands --json            # 机器可读的命令、参数和版本
self schema command source.add  # 单条命令的 JSON Schema
self version
```

命令设计遵循以下约束：

- 资源名称使用单数：`source`、`topic`、`claim`、`entity`。
- 动词保持稳定：`list`、`show`、`add`、`update`、`delete`、`restore`、`build`、`rebuild`、`export`。
- 查询可以接受名称，人为修改必须使用稳定 ID 或无歧义选择器。
- 只读命令立即执行；危险修改先生成 Plan，再由 `self apply` 执行。
- 人类默认获得易读输出，Agent 使用 `--json` 或 `--jsonl`。
- 所有路径和数据库状态都相对于一个明确的 Self 根目录。
- 耗时命令既支持前台等待，也支持异步 Job。

### 9.2 全局参数

所有命令共享以下基础参数：

```text
--root <DIR>                 指定 Self 实例，默认向上查找 self.toml
--init                       启动人类交互式首次设置，映射到 setup --interactive
--version                    输出 CLI、数据库格式和协议版本
--json                       输出一个稳定的 JSON envelope
--jsonl                      流式输出 JSON Lines，适合批量结果和进度
--quiet                      只输出最终结果
--no-color                   禁用颜色和终端样式
--wait                       等待长任务结束
--detach                     立即返回 job_id，在后台继续
--timeout <DURATION>         设置等待超时，不取消后台任务
--idempotency-key <KEY>      防止 Agent 重试造成重复写入
--model <MODEL_ID>           临时指定对话或抽取模型
--vector-space <SPACE_ID>    临时选择一个 ready 的 VectorSpace
--embedding-model <MODEL_ID> 选择与模型完全匹配的 ready VectorSpace；不存在则报错
--reranker <MODEL_ID>        临时指定重排模型
--trace                      返回本次操作的阶段、依赖和耗时
```

模型参数只覆盖当前命令，不修改实例默认配置。所有写操作都返回 `operation_id`，所有长任务都返回 `job_id`。

### 9.3 实例与配置

```bash
# 初始化一个完整的单目录实例
self --init
self --init --root ./my-self
self init ./my-self
self init ./my-self --with-vault ~/Documents/Obsidian --mode import

# 可恢复 Setup 和 Agent 非交互入口
self setup status
self setup resume
self setup plan --spec ./setup.toml --json

# 查看实例状态
self status
self status --verbose
self system info
self doctor
self doctor --system
self doctor --components
self doctor --models
self doctor --all
self doctor --plan-fixes

# 组件、能力和诊断
self component list
self component verify --all
self capability list
self model doctor --configured
self diagnostics collect --redact

# 配置
self config list
self config get models.embedding_defaults.model
self config set models.embedding_defaults.model model:mdl_123
self config unset network.proxy
self config validate
```

`self --init` 是人类友好的交互式入口，负责 System Preflight、Root 选择、Init Plan、来源、模型真实测试、VectorSpace、首次索引和最终 Doctor；完整状态机见 [`domains/workspace/initialization.md`](./domains/workspace/initialization.md)。`self init <DIR>` 是底层明确目录命令。两者创建相同规范 Workspace，初始化已有目录时不得覆盖文件，除非用户显式批准生成的 Plan。

`models.embedding_defaults` 只影响以后创建 VectorSpace 时的默认参数，不改变当前 Active Space，也不触发隐式重建。动态 Model、Route、VectorSpace 和 Active ID 存在 SQLite。

### 9.4 数据源管理

`source` 是所有外部信息进入 Self 的统一入口。一个数据源可以是：

- 单个 Markdown 或普通文本文件
- 本地目录
- Obsidian Vault
- PDF、Office 文档、图片、音频或视频
- 网页 URL
- Git 仓库或项目目录
- stdin 输入或一段 JSON/JSONL 数据

#### 添加数据源

```bash
# 单个文件
self source add ./article.md
self source add ./paper.pdf --name 'Agent Memory Paper'

# 目录或 Obsidian Vault
self source add ~/notes --kind markdown --recursive
self source add ~/ObsidianVault --kind obsidian --mode import
self source add ~/projects/agent-demo --kind project \
  --exclude node_modules --exclude dist --exclude .git

# 网页
self source add https://example.com/article --kind web
self source add https://example.com/docs --kind web --crawl same-origin --max-pages 100

# stdin
printf '%s' '一条临时知识' | self source add - --kind text --name 'terminal-note'
some-command | self source add - --kind jsonl
```

主要参数：

```text
--kind auto|markdown|directory|obsidian|web|pdf|image|media|project|text|jsonl
--name <NAME>               设置人类可读名称
--mode import|snapshot|mirror
--recursive                 递归扫描目录
--include <GLOB>            只接收匹配文件，可重复
--exclude <GLOB>            忽略匹配文件，可重复
--watch                     持续监听本地变化
--crawl none|page|same-origin
--max-pages <N>             限制网页抓取规模
--tag <TAG>                 给来源添加标签，可重复
--collection <ID>           将来源加入指定集合
--project <ID>              关联到项目上下文
--language <LANG>           显式指定语言，默认自动检测
--no-build                  只注册和归档，暂不构建知识底座
```

三种来源模式：

| 模式 | 行为 |
| --- | --- |
| `import` | 将内容复制到 Self 根目录并由 Self 管理，适合迁入 Vault |
| `snapshot` | 保存当前内容快照，不持续依赖原位置；普通文件和网页的默认模式 |
| `mirror` | 由 Connection 持续跟踪外部位置，每次变化仍由 Source 在 Self 内保存可追溯快照 |

默认情况下，`source add` 会完成“注册 → 内部归档 → 解析 → 切片 → 入库 → 索引 → 向量化 → 图谱与 Claim 抽取”。命令的 Composite Operation 只有在 Source Snapshot 已归档且 Ingestion 达到 `ready` 后才算完整成功，而不是只记录了路径；Source 与 Ingestion 各自保留独立状态。

#### 查看、同步和修改数据源

```bash
self source list
self source list --status failed
self source show source:src_123
self source status source:src_123
self source files source:src_123

self source sync source:src_123
self source sync --all --changed-only
self source retry source:src_123

self source update source:src_123 --set name='New Name'
self source update source:src_123 --add-tag research
```

如果 Source 绑定了 Connection，`source sync` 是 `connection scan` 的兼容快捷入口；持续监控的暂停、过滤和路径重绑统一由 `connection` 命令管理。

#### 删除数据源

停止动态监控使用 `connection detach`；Source 删除分成软删除和永久清理，避免“停止监控”和“销毁知识”混为一谈：

```bash
# 软删除来源，并标记仅由它支撑的 Chunk、Claim 和关系失效
self source delete source:src_123 --plan

# 永久删除原始快照及无其他引用的派生数据
self source purge source:src_123 --plan

# 执行计划或恢复软删除对象
self apply plan:plan_123
self source restore source:src_123
```

`purge` 是高风险操作。Plan 必须列出将删除的文件、Chunk、向量、Claim、关系、受影响 Topic 和 Artifact，不能只显示来源名称。

#### 高频快捷命令

以下快捷命令只减少输入，不引入另一套语义：

```bash
self ingest <INPUT> [source add 的参数]   # 等价于 source add 并等待 ready
self sync [SOURCE_ID]                     # 等价于 source sync
self remember '一条知识'                  # 等价于 source add --kind text
```

### 9.5 Connection 与后台变化感知

```bash
# 建立持续连接
self connection add ~/project/docs --preset docs --interval 5m
self connection add ~/project/README.md --kind file

# 查看连接和实时变化
self connection list --health degraded
self connection status connection:con_123
self connection events connection:con_123 --since 1h
self connection watch --all --jsonl

# 扫描、暂停、恢复和移动路径重绑
self connection scan connection:con_123 --full
self connection pause connection:con_123
self connection resume connection:con_123
self connection rebind connection:con_123 ~/moved/project/docs --plan

# 后台进程
self daemon start
self daemon status
self daemon logs --follow
self daemon stop
```

`source add --watch` 是创建 Source、Connection、Initial Scan 和首次归档的组合快捷命令。外部路径默认采用 `mirror`；`import --watch` 监控迁入后的 `content/notes/` 等受控人工内容目录。创建 active Connection 后默认确保 Root-local Daemon 正在运行，除非显式使用 `--no-daemon`。后台 watcher 只提供低延迟提示，定时 reconciliation 才是变化判断的权威来源。详细命令见 [`domains/connection/commands.md`](./domains/connection/commands.md)。

顶层 `self status` 必须汇总 Daemon 状态以及 healthy/degraded/stale/error Connection 数量，让用户和 Agent 不进入子命令也能发现后台同步异常。

### 9.6 知识底座构建与重建

`source` 负责来源生命周期，`knowledge` 负责统一知识底座的处理状态。

```bash
# 构建所有尚未 ready 的来源
self knowledge build
self knowledge build --source source:src_123
self knowledge build --since 2026-07-01

# 查看构建状态和失败阶段
self knowledge status
self knowledge status --source source:src_123
self knowledge failures

# 按层重建
self knowledge rebuild --layer parse
self knowledge rebuild --layer chunks
self knowledge rebuild --layer fts
self knowledge rebuild --layer vectors
self knowledge rebuild --layer graph
self knowledge rebuild --layer claims
self knowledge rebuild --layer all

# 限制重建范围
self knowledge rebuild --layer vectors --source source:src_123
self knowledge rebuild --layer vectors --vector-space vector-space:vsp_123
self knowledge rebuild --layer graph --topic topic:top_123
self knowledge rebuild --layer all --changed-only

# 校验
self knowledge verify
self knowledge verify --deep
self knowledge explain chunk:chk_123
```

重建语义：

- `parse`：从内部原始快照重新提取规范内容。
- `chunks`：重新切片，并计算旧 Chunk 到新 Chunk 的对应关系。
- `fts`：重建 SQLite 全文索引。
- `vectors`：在指定的现有 VectorSpace 内修复或重算 Embedding，默认使用 Active Space；更换模型/维度使用 `vector-space create|build|verify|activate`，不由本命令偷偷迁移。
- `graph`：重新做实体识别、消歧和关系抽取。
- `claims`：重新抽取 Claim、证据链接、冲突与可信度维度。
- `all`：按依赖顺序执行全部阶段。

重建不得修改原始资料。旧索引在新索引完整可用前继续服务，成功后原子切换；失败时保留旧版本和明确的失败状态。

### 9.7 检索、问答与追溯

#### 搜索

```bash
self search '子智能体上下文隔离'
self search 'memory isolation' --mode hybrid --limit 20
self search 'subagent' --source source:src_123
self search 'agent memory' --topic topic:top_123 --since 2026-01-01
self search 'GraphRAG' --mode vector --explain
```

搜索参数：

```text
--mode hybrid|text|vector|graph
--limit <N>
--source <SOURCE_ID>         可重复
--topic <TOPIC_ID>
--collection <ID>
--project <ID>
--tag <TAG>
--since <TIME>
--until <TIME>
--kind <KIND>
--min-confidence <LEVEL>
--include-derived            包含未确认的 AI 派生内容
--explain                    展示召回、融合和重排原因
```

#### 带证据问答

```bash
self ask '我对多智能体有哪些相互矛盾的观点？'
self ask '总结子智能体的上下文隔离方案' --depth deep
self ask '最近一个月这个主题有什么变化？' --topic topic:top_123
self ask - --format markdown < question.md
```

`ask` 默认必须返回引用、结论类型和可信度。缺少证据时应返回“资料不足”，不能用模型常识静默补齐。只有显式设置 `--allow-model-knowledge` 时，才允许使用知识库外的模型知识，并必须单独标注。

#### 关联与证据链

```bash
self related entity:ent_123
self related claim:clm_123 --depth 2
self trace claim:clm_123
self trace section:sec_123
self get chunk:chk_123
self get source:src_123
```

`trace` 返回 `报告结论 → Claim → Chunk → Revision → Source` 的完整证据链，以及中间使用的模型和规则版本。

#### Agent 批量查询

```bash
self query run --spec queries.json --json
self query run --stdin --jsonl < queries.jsonl
```

批量接口中的每个请求都有独立 `request_id`、状态和错误，不因一个请求失败而丢失整批结果。

### 9.8 Topic 与综合报告

```bash
# 定义 Topic
self topic create '子智能体' \
  --scope '概念、架构、上下文隔离、通信和协作模式' \
  --exclude '普通游戏 Agent'
self topic list
self topic show topic:top_123
self topic update topic:top_123 --add-alias subagent
self topic update topic:top_123 --set scope='新的主题范围'

# 首次完整构建
self topic build topic:top_123 --template knowledge-atlas
self topic build topic:top_123 --depth deep --wait

# 基于最新数据增量更新
self topic refresh topic:top_123
self topic refresh topic:top_123 --since-last-build
self topic refresh topic:top_123 --explain-changes
self topic refresh --affected-only --detach

# 查看综合报告
self topic report topic:top_123
self topic report topic:top_123 --show-confidence
self topic report topic:top_123 --show-conflicts --show-unknowns
self topic open topic:top_123

# 版本历史与比较
self topic history topic:top_123
self topic diff topic:top_123 --from build:bld_123 --to latest

# 输出
self topic export topic:top_123 --format html --output ./exports/subagent
self topic export topic:top_123 --format html --single-file
self topic export topic:top_123 --format markdown
self topic export topic:top_123 --format json

# 删除与恢复
self topic delete topic:top_123 --plan
self topic restore topic:top_123
```

`topic build` 用于首次完整综合，`topic refresh` 用于读取上次知识快照和 Page IR 后增量更新。两者都会创建新的不可变 Build，不覆盖旧报告。

HTML 默认保存在 Self 根目录的 `artifacts/` 中。`topic export` 是将已有构建复制成用户指定的发布格式，不改变内部归档。

### 9.9 图谱、实体、关系和 Claim

#### 只读图谱操作

```bash
self graph status
self graph show --topic topic:top_123
self graph neighbors entity:ent_123 --depth 2
self graph path entity:ent_123 entity:ent_456
self graph links document:doc_123
self graph backlinks document:doc_123
self graph unresolved list --status ambiguous
self graph search 'context isolation'
self graph verify
self graph export --topic topic:top_123 --format json
self graph export --scope workspace --format jsonld
self graph export --topic topic:top_123 --format graphml
```

大型图谱构建和分层重建：

```bash
self graph build --changed-only --detach
self graph rebuild --layer structure --detach
self graph rebuild --layer links --detach
self graph rebuild --layer relations --detach
self graph rebuild --layer claims --detach
self graph rebuild --layer neighbors --vector-space vector-space:vsp_123 --detach
self graph rebuild --layer all --plan
self graph diff generation:ggen_123 generation:ggen_456
self graph activate generation:ggen_456 --plan
```

#### 实体操作

```bash
self entity list --type concept
self entity show entity:ent_123
self entity create --name 'Subagent' --type concept --user-asserted --plan
self entity update entity:ent_123 --add-alias '子智能体' --plan
self entity merge entity:ent_123 entity:ent_456 --plan
self entity delete entity:ent_123 --plan
self entity restore entity:ent_123
```

#### 关系操作

```bash
self relation show relation:rel_123
self relation create entity:ent_123 depends_on entity:ent_456 \
  --evidence chunk:chk_123 --plan
self relation evidence relation:rel_123
self relation confirm relation:rel_123
self relation reject relation:rel_123 --reason '证据不支持'
self relation update relation:rel_123 --set valid_to=2026-07-11 --plan
self relation delete relation:rel_123 --plan
```

没有证据的人工关系可以存在，但必须标记为 `user_asserted`。AI 不得自行把无证据关系提升为已确认事实。

#### Claim 操作

```bash
self claim show claim:clm_123
self claim evidence claim:clm_123
self claim conflicts claim:clm_123
self claim confirm claim:clm_123
self claim reject claim:clm_123 --reason '来源已经过期'
self claim update claim:clm_123 --set valid_to=2026-12-31 --plan
self claim delete claim:clm_123 --plan
self claim restore claim:clm_123
```

任何 Claim 修改都会使依赖它的 Topic 和 Artifact 进入 `stale` 或 `needs_review` 状态。

Predicate、Relation、Claim、GraphGeneration 的完整命令和错误码以 [`domains/graph/commands.md`](./domains/graph/commands.md) 为准。

#### 人工笔记操作

```bash
self note create --title '对子智能体的新理解' --content-file ./draft.md
printf '%s' '一条新的判断' | self note create --title '临时记录' --stdin
self note show note:note_123
self note update note:note_123 --patch ./changes.json --plan
self note move note:note_123 --to 'AI/Agents' --plan
self note delete note:note_123 --plan
self note restore note:note_123
```

`note` 操作同时更新 `content/notes/` 中的人类可读文件和 SQLite 中的知识表示。任何写回都必须保留旧 Revision，并在数据库事务与文件落盘之间保证一致性。

### 9.10 通用修改、删除与审计

对于 Agent，不应提供可绕过业务规则的任意数据库写入命令。通用资源读取可以使用 `self get <ID>`，修改必须进入对应的资源命令。

所有高影响操作采用两阶段协议：

```bash
# 生成计划，不发生业务修改
self entity merge entity:ent_123 entity:ent_456 --plan --json
self source purge source:src_123 --plan --json

# 查看并执行计划
self plan show plan:plan_123
self plan diff plan:plan_123
self apply plan:plan_123

# 放弃或查看执行结果
self plan cancel plan:plan_123
self operation show operation:op_123
self operation undo operation:op_123 --plan
```

Plan 必须包含：

- 目标对象及其当前版本
- 将发生的数据库和文件变化
- 受影响的 Chunk、向量、图关系、Claim、Topic 和 Artifact
- 是否可恢复
- 计划过期时间
- 执行前置条件和冲突检测信息

如果对象在 Plan 生成后发生变化，`self apply` 必须返回版本冲突，不能继续套用旧计划。

审计命令：

```bash
self history list
self history list --resource claim:clm_123
self history show operation:op_123
self history diff operation:op_123
```

### 9.11 Artifact、模板与 HTML 渲染

Topic 报告只是 Artifact 的一种。图片、图表、Markdown 报告和一次性 HTML 也统一进入 Artifact 系统。

```bash
self artifact list
self artifact list --type html --status ready
self artifact show artifact:art_123
self artifact open artifact:art_123
self artifact history artifact:art_123
self artifact diff build:bld_123 build:bld_456
self artifact export artifact:art_123 --format html --output ./exports/report
self artifact delete artifact:art_123 --plan
self artifact restore artifact:art_123
```

模板操作：

```bash
self template list
self template show knowledge-atlas
self template validate ./my-template
self template add ./my-template
self template update knowledge-atlas ./my-template --plan
self template remove knowledge-atlas --plan
self artifact render topic:top_123 --template knowledge-atlas
```

`artifact render` 只根据已有 Page IR 重新渲染，不重新检索或综合知识；`topic build` 和 `topic refresh` 才会更新报告内容。

### 9.12 模型管理

```bash
self model list
self model list --capability chat
self model list --capability embedding
self model show model:mdl_123
self model add --provider openai --capability chat --name main-chat
self model add --provider local --capability embedding --path ./models/local/embed.gguf
self model test model:mdl_123
self model route list
self model route set chat_fast model:mdl_123 --plan
self model route set synthesis model:mdl_456 --plan
self model usage --since 2026-07-01

self vector-space list
self vector-space show vector-space:vsp_123
self vector-space active
self vector-space create --model model:mdl_789 --dimensions 1024 \
  --distance cosine --normalize l2 \
  --query-instruction personal-knowledge-retrieval-v1 --plan
self vector-space build vector-space:vsp_456 --detach
self vector-space verify vector-space:vsp_456 --deep
self vector-space compare vector-space:vsp_123 vector-space:vsp_456 \
  --fixture retrieval-medium-v1
self vector-space activate vector-space:vsp_456 --plan
self vector-space migrate --from vector-space:vsp_123 \
  --to-model model:mdl_789 --dimensions 1024 \
  --from-local-chunks --plan
self vector-space delete vector-space:vsp_123 --plan
```

对话模型通过任务 Route 切换，不重写历史 Build。Embedding 模型、Revision、维度、Normalize、Distance 和输入版本共同定义不可变 VectorSpace；它必须经过 `create → build → verify → activate`。旧厂商完全不可用时，新空间直接从本地 Chunk 重建，Search 暂时明确降级为 FTS + Graph；绝不跨空间查询。`model set-default --capability embedding` 返回 `embedding_requires_vector_space`，不能静默覆盖现有向量。完整规则见 [`model-selection.md`](./model-selection.md)。

### 9.13 异步任务

抓取、全量摄入、向量迁移和 Topic 深度构建都可能是长任务。

```bash
self knowledge rebuild --layer all --detach
self job list
self job show job:job_123
self job watch job:job_123 --jsonl
self job logs job:job_123
self job cancel job:job_123
self job retry job:job_123
```

Job 状态至少包括：`queued`、`running`、`waiting`、`succeeded`、`partial`、`failed`、`cancelled`。任务必须保存 checkpoint，重启后可以继续或明确回滚。

### 9.14 备份、验证与维护

```bash
self backup create
self backup create --include-models
self backup list
self backup verify backup:bkp_123
self backup restore backup:bkp_123 --plan

self verify
self verify --deep
self gc --plan
self apply plan:plan_123
self migrate status
self migrate plan
self apply plan:plan_456
self logs show --level error --since 1d

self doctor --performance
self perf benchmark --profile small
self perf benchmark --profile medium --suite retrieval
self perf explain operation:op_123
self perf stats --since 24h
```

`verify` 检查 SQLite 完整性、文件哈希、向量空间、孤立对象、Artifact 依赖及引用链。`gc` 只清理无引用缓存和已满足保留策略的数据，不承担普通删除功能。

`doctor --performance` 只执行低成本诊断；可重复的 Benchmark、统计口径、数据规模和发布门禁由 [`performance.md`](./performance.md) 定义。耗时 Benchmark 统一创建 Job，结果保存在 Root 内，不阻塞现有索引和查询。

### 9.15 Agent 输入输出协议

#### JSON 输出

`--json` 返回统一 envelope：

```json
{
  "ok": true,
  "data": {
    "source_id": "source:src_123",
    "status": "ready"
  },
  "meta": {
    "request_id": "req_123",
    "operation_id": "operation:op_123",
    "root": "/path/to/my-self",
    "warnings": [],
    "next_actions": []
  },
  "error": null
}
```

失败时仍保持相同结构，`error` 至少包含稳定的 `code`、人类可读的 `message`、可选的 `details` 和建议动作。不得要求 Agent 解析彩色文本或自然语言日志来判断成功与否。

#### 标准输入

- `-` 表示从 stdin 读取内容。
- `--stdin` 用于读取结构化请求。
- `--spec <FILE>` 接受完整 JSON 请求描述。
- `--jsonl` 用于流式批处理和进度事件。
- 大文本、二进制文件和敏感内容不应直接放在命令行参数中。

#### 幂等与并发控制

- Agent 对所有写请求都可以传入 `--idempotency-key`。
- 同一个 Key 和相同参数返回第一次执行的结果。
- 相同 Key 配合不同参数必须返回冲突。
- 更新命令支持 `--if-version <VERSION>`，防止覆盖并发修改。
- 批量写入必须返回每个项目的独立状态，并明确是否采用原子事务。

#### 建议退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `2` | 参数或输入格式错误 |
| `3` | 对象不存在 |
| `4` | 版本、幂等或并发冲突 |
| `5` | 对象状态不允许当前操作 |
| `6` | 模型、网络或外部来源失败 |
| `7` | 部分成功，需要检查结果 |
| `8` | 实例被锁定或资源繁忙 |
| `10` | 操作需要 Plan 或人工确认 |
| `20` | Self 内部错误 |

### 9.16 典型工作流

#### 从本地 Markdown 目录建立知识库

```bash
self init ./my-self
self --root ./my-self source add ~/notes --kind markdown --recursive --mode import
self --root ./my-self knowledge status
self --root ./my-self search '长期记忆' --explain
```

#### 摄入网页并更新已有 Topic

```bash
self source add https://example.com/subagent-memory --kind web
self topic refresh topic:top_123 --explain-changes --wait
self topic diff topic:top_123 --from previous --to latest
self topic open topic:top_123
```

#### 重建向量并保留旧索引服务

```bash
self vector-space create --model model:mdl_new --dimensions 1024 \
  --distance cosine --normalize l2 \
  --query-instruction personal-knowledge-retrieval-v1 --plan
self apply plan:plan_123
self vector-space build vector-space:vsp_new --detach
self job watch job:job_123 --jsonl
self vector-space verify vector-space:vsp_new --deep
self vector-space activate vector-space:vsp_new --plan
self apply plan:plan_456
```

#### 生成可信综合报告并输出 HTML

```bash
self topic create '子智能体' --scope '架构、记忆、隔离和协作'
self topic build topic:top_123 --depth deep --template knowledge-atlas --wait
self topic report topic:top_123 --show-confidence --show-conflicts
self topic export topic:top_123 --format html --output ./exports/subagent
```

#### 安全删除来源

```bash
self source delete source:src_123 --plan --json
self plan show plan:plan_123
self apply plan:plan_123
self topic refresh --affected-only
```

## 10. 并发、可靠性与恢复

- 单实例允许多个只读进程并发访问。
- 同一时间只允许一个数据库迁移或关键写事务。
- 文件先写入临时路径，校验完成后原子重命名。
- 数据库只在文件成功落盘后提交引用，失败时自动回滚。
- 每个长任务保存 checkpoint，进程退出后可以恢复。
- 生成新 Artifact 成功后才原子更新 `latest.json`。
- `self verify` 检查数据库、文件哈希、缺失附件和孤立产物。
- `self gc` 只清理已经确认无引用的缓存和临时数据，默认先输出计划。
- 备份时使用 SQLite Online Backup API 或一致性快照，不能只复制正在写入的主数据库文件。

## 11. 隐私与安全

- 默认无遥测。
- 所有网络调用可记录目标提供者、发送的对象范围和时间。
- API Key 不得以明文写入 `self.toml`。
- 严格自包含时，可将凭证加密保存在根目录，通过用户口令解锁；也可由环境变量临时注入。
- HTML 渲染默认转义不可信内容，并限制任意脚本执行。
- 外部网页内容视为不可信数据，不能把其中的指令直接当成 Agent 命令。
- 日志和模型请求快照支持脱敏策略。
- 删除默认使用软删除；永久清除需要显式确认并记录审计事件。

## 12. 建议实施阶段

### Phase 1：建立可信的数据底座

- 初始化单目录实例
- 扫描或迁入 Obsidian Vault
- 增量监听 Markdown 和附件变化
- SQLite 文档、版本、Chunk 和来源模型
- SQLite FTS 全文检索
- sqlite-vec 向量检索
- 带来源的混合搜索

验收标准：能够移动整个目录后继续使用；重复同步不会产生重复数据；每条搜索结果都能回到原文。

### Phase 2：知识对象与专题页面

- 实体、关系和 Claim 抽取
- 用户确认和冲突标记
- Topic 模型与局部知识图谱
- 跨来源 Claim 聚类、独立来源判断和可信度解释
- Page IR 与组件系统
- 2～3 个高质量 HTML 模板
- 构建归档、引用追踪和版本历史

验收标准：能够从整个知识底座为一个 Topic 生成结构完整的综合报告，明确展示可信结论、单一来源、用户观点、AI 推断、冲突和未知问题，并从任何关键结论追溯到原始证据。

### Phase 3：真正的增量知识维护

- Chunk 级变更传播
- Artifact 依赖图
- 专题页增量检索和局部综合
- 页面版本比较
- 过期结论和冲突提醒

验收标准：加入少量新资料后，只处理受影响内容，并能清楚展示专题页相对上一版发生了什么变化。

### Phase 4：Agent 自动化与多入口

- 稳定 JSON 协议
- 计划与执行分离
- 异步任务与恢复
- MCP 和 HTTP API
- Obsidian 插件或轻量桌面入口
- 本地及云端模型编排

验收标准：外部 Agent 能够安全、可审计地使用 Self 完成检索、整理和构建，而不直接操作内部数据库。

## 13. 第一版明确不做

- 不自动重构整个 Obsidian Vault。
- 不允许 AI 静默覆盖人工笔记。
- 不以专用图数据库作为前置依赖。
- 不把所有 AI 产物自动重新摄入为事实。
- 不追求复杂的多人实时协作。
- 不把 HTML 作为不可重建的唯一结果。
- 不在尚未证明需要时引入多个常驻数据库服务。

第一版最重要的完整闭环是：

> 将所有来源完整摄入统一知识底座 → 构建可追溯的知识图谱 → 跨来源形成带可信度、冲突和未知项的综合报告 → 生成并归档精美专题页 → 新资料进入后基于旧版本增量更新。

## 14. 关键架构决策摘要

1. 一个目录代表一个完整、可迁移、可备份的 Self 实例。
2. SQLite 是唯一结构化数据库，FTS、向量和图关系优先统一存储。
3. 大文件进入根目录内的内容寻址文件存储。
4. 原始资料负责存证；所有已接纳来源必须完整拆解并写入统一知识底座后，才算真正进入 Self。
5. 默认检索和综合只操作 SQLite 中的规范内容、全文索引、向量、图谱和 Claim，不临时扫描原始文件。
6. Topic 是一等对象，默认产物是跨来源、带证据、可信度、冲突和未知问题的综合报告。
7. HTML 由 Page IR、模板和组件编译生成，而不是一次性自由生成。
8. 每次构建完整归档请求、检索快照、中间表示、可信度依据、引用和最终页面。
9. 后续构建以旧版本为父节点，只处理新增、变化、失效和冲突内容。
10. 所有重要结论都能追溯到具体来源及其版本。
11. CLI 是面向 Agent 的稳定协议，修改操作必须可计划、可审计、可恢复。
12. Self 的长期价值不是“替用户写更多笔记”，而是持续维护一个可信、活跃、可重新表达的个人知识世界。
