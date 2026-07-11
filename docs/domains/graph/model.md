# Graph 领域模型

## 1. 图的组成

Self 使用 Property Graph 思路，但不把任意 JSON 当作模型：节点类型、Predicate 和可查询字段都受版本化 Schema 控制。

```text
GraphNode ── typed Relation ──> GraphNode
    │                              │
    └── external_ref               └── external_ref

Relation / Claim
    └── EvidenceLink ──> Chunk ──> Revision ──> Snapshot ──> Source
```

`GraphNode` 是统一遍历投影，Entity、Claim 等丰富业务对象仍保存在各自专表。Document/Chunk/Topic 节点只保存稳定外部引用和查询所需摘要，不复制正文。

## 2. 节点类型

### 2.1 系统对象节点

| `node_kind` | 权威对象 | 典型关系 |
| --- | --- | --- |
| `source` | Source | `contains`、`derived_from` |
| `document` | Knowledge | `links_to`、`mentions`、`about` |
| `revision` | Knowledge | `revision_of`、`contains` |
| `chunk` | Knowledge | `part_of`、`mentions`、`evidence_for` |
| `topic` | Topic | `about`、`includes` |
| `claim` | Graph | `supported_by`、`contradicts` |
| `entity` | Graph | 领域语义 Predicate |

结构链的权威仍是原领域表。GraphNode 是由事件维护、可验证和可重建的遍历投影。

### 2.2 Entity 类型

内置类型只提供稳定上层分类，允许通过 Registry 增加子类型：

- `person`
- `organization`
- `project`
- `concept`
- `technology`
- `product`
- `event`
- `place`
- `work`
- `dataset`
- `method`
- `standard`
- `user_defined`

实体类型不是 Tag。Tag 是来源中的分类信号；Entity 是可以合并、消歧、建立关系并被 Claim 引用的对象。

## 3. Predicate Registry

每个 PredicateDefinition 至少包含：

- `predicate_key`：稳定 snake_case，例如 `depends_on`。
- `display_name` 和多语言别名。
- 允许的 subject/object kind 或 Entity type。
- 是否对称、反身、传递。
- 可选 `inverse_predicate_key`。
- 是否允许时间范围。
- 是否必须有 Evidence。
- 来源层次：structural、explicit、semantic、claim、topic。
- 当前 Schema Version 和 deprecated replacement。

初始受控谓词：

| 类别 | Predicate | 含义 |
| --- | --- | --- |
| 结构 | `contains`、`part_of`、`revision_of`、`derived_from` | 系统组成和来源链 |
| 文档 | `links_to`、`embeds`、`cites`、`references`、`tagged_with` | 原文显式关系 |
| 提及 | `mentions`、`about`、`defined_in` | 内容与实体/主题 |
| 分类 | `is_a`、`instance_of` | 类型和概念层级 |
| 组成 | `has_part`、`part_of`、`member_of` | 组成和归属 |
| 依赖 | `uses`、`depends_on`、`implements`、`compatible_with` | 技术和项目关系 |
| 人事 | `created_by`、`owned_by`、`maintained_by` | 责任和创建关系 |
| 时序 | `precedes`、`follows`、`supersedes` | 时间和版本演进 |
| 因果 | `causes`、`contributes_to`、`prevents` | 有证据的因果/影响 |
| 比较 | `similar_to`、`alternative_to`、`different_from` | 比较关系；similar_to 需区分事实与向量候选 |
| Claim | `supports`、`contradicts`、`refines`、`equivalent_to` | 主张之间关系 |

规则：

- 对称 Predicate 只保存一个 canonical edge，按 ID 排序 subject/object。
- 逆关系默认查询时展开，不重复保存两条边。
- 传递关系不自动物化无限闭包；只对受控层级建立有限 closure cache。
- 模型输出未知 Predicate 时进入 `proposed_predicate` 队列，默认退化为带说明的 `related_to` 候选，不直接扩展 Registry。

## 4. Relation

Relation 是有类型、有方向、有时间、有证据的断言：

```text
subject_node_id
predicate_key
object_node_id
qualifier_hash
valid_from / valid_to
observed_at
origin
status
confidence dimensions
generation_id
```

`qualifier_hash` 来自规范化限定信息，例如角色、作用域、条件、单位、版本和地域。相同三元组在不同时间或条件下可以并存，不能只用 subject/predicate/object 粗暴去重。

### 4.1 Origin

| `origin` | 产生方式 | 默认可信状态 |
| --- | --- | --- |
| `structural` | 系统对象关系 | accepted |
| `explicit_link` | 原文 Link/Citation/Frontmatter | accepted，但目标解析可能 pending |
| `parser` | 确定性 AST 规则 | accepted/proposed |
| `user` | 用户明确创建 | accepted，标记 user_asserted |
| `model` | LLM 结构化抽取 | proposed |
| `rule` | 可解释规则推导 | proposed/accepted |
| `embedding` | 向量相似 | 只进入 SemanticNeighbor，不直接成为 Relation |

### 4.2 Relation 状态

```text
proposed → accepted → stale → deprecated → deleted
    ├────→ rejected
    └────→ needs_review
```

- `stale`：证据 Revision 变化，需要重新确认。
- `rejected`：候选被否定但保留审计。
- `deprecated`：被新关系替代或 Predicate 退役。
- `deleted`：软删除；历史引用仍可解释。

## 5. 文档关系

文档关联按证据强度分开：

### 5.1 显式链接

- Markdown Link（显示文本 + 目标路径）→ `links_to`
- Obsidian `[[Wiki Link]]` → `links_to`
- `![[Embed]]` → `embeds`
- Citation/脚注 → `cites`
- Frontmatter `related/projects/aliases` → 对应受控 Predicate
- Tag → `tagged_with`，Tag 可以提升为 Entity 候选但不自动等同

链接先保存原始 target、source position 和 Revision。目标无法解析时保存 UnresolvedReference；新增或重命名文档后重新解析。

### 5.2 语义关联

Vector Top-K 存入 `semantic_neighbors`：

- 绑定 `vector_space_id` 和双方内容 Hash。
- 保存 score、rank、过滤范围和算法版本。
- 每个节点有硬 Top-K 和最低阈值。
- VectorSpace 切换后旧相似投影整体 stale/rebuild。
- 只有经过规则、模型证据校验或用户确认，才提升为事实 Relation。

### 5.3 主题关联

Topic 对节点的关系包含：

- `core`：主题核心对象。
- `supporting`：支持主要结论。
- `contradicting`：提供反证或争议。
- `context`：背景材料。
- `excluded`：明确排除，防止下一次刷新重新混入。

Topic Membership 属于 Topic；Graph 保存只读投影供遍历，TopicSnapshot 固化构建时使用的节点和边版本。

## 6. Claim 与事实关系

Claim 不等于普通边。它可以表达：

```text
subject + predicate + object/value
+ qualifiers
+ valid time
+ epistemic status
+ evidence set
```

例如“项目 A 在 2026 年依赖库 B v3”需要时间和版本限定，不能压缩成永恒的 `A depends_on B`。Graph 可以从 accepted Claim 投影一条 Relation，但 Relation 必须记录 `claim_id`，Claim 才是事实语义与冲突判断的主体。

Claim 状态：

```text
proposed → accepted / user_confirmed
    ├──→ disputed
    ├──→ superseded
    ├──→ stale
    ├──→ rejected
    └──→ deleted
```

ClaimRelation 类型：

- `supports`
- `contradicts`
- `refines`
- `supersedes`
- `equivalent_to`
- `derived_from`

支持/反驳强度必须回到 Evidence，而不是只保存模型给出的数字。

## 7. Evidence

EvidenceLink 至少记录：

- `chunk_id`、`revision_id` 和稳定 Source 路径。
- 原文起止位置、页码或 DOM locator。
- Evidence Role：support、contradict、context、definition。
- Directness：direct、paraphrase、inferred。
- Extraction Run、Model/Prompt/Schema 版本。
- 引用片段 Hash；正文不在 Graph 重复保存。
- Evidence 当前是否 active/stale/withdrawn。

同一转载链不能被计算为多个独立来源。Source Lineage 和内容 Hash 用于证据独立性聚类。

## 8. Entity 消歧、合并和拆分

消歧信号：

- 规范名称和别名。
- Entity Type 与 Predicate Domain/Range。
- 同现 Entity 和文档/项目上下文。
- 显式 ID、URL、邮箱域、仓库地址等强标识。
- 时间范围和地理范围。
- Vector 相似候选；只作为信号。

自动合并只允许强确定性规则。模型认为相同但缺少强 ID 时创建 MergeCandidate。

Merge：

- 目标 Entity ID 保持稳定。
- 来源 Entity 进入 redirected。
- Alias、Evidence 和 Relation 重绑定到 canonical projection，但历史记录保留原 ID。
- 旧 ID 永久通过 EntityRedirect 解析。

Split 必须创建新 Entity、明确移动哪些 Mention/Evidence，并通过 Plan 展示受影响 Claim、Topic 和 Artifact。

## 9. Confidence

Relation/Claim 保存分维度评估：

- source_quality
- directness
- corroboration
- freshness
- extraction_quality
- consistency
- user_verification

`confidence_level` 是可展示投影，不替代维度、证据和解释。Graph Query 可以按 level 过滤，但默认保留争议内容并标记。

## 10. Generation 与重建边界

- 手工确认、显式原文链接和稳定 ID 不因模型重建被覆盖。
- 模型/规则派生对象绑定 `generation_id`。
- 新 Generation 在 shadow 状态构建和校验。
- 激活后旧派生对象进入 superseded/stale，但按保留策略保存。
- SemanticNeighbor 绑定 VectorSpace，可随空间删除重建。
- 同一输入 Revision、Predicate Registry、Extractor 和配置的增量结果必须与全量重建等价。
