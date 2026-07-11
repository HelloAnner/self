# Graph 领域

> 状态：详细设计基线
> 核心目标：把分散在不同 Source、Document、Chunk 和时间中的知识组织为可解释、可追溯、可增量重建的多关系网络。

## 1. Graph 为什么是核心能力

目录只能表达一棵树，向量只能回答“哪些内容语义相近”。Self 还需要回答：

- 哪些文档显式链接或引用了另一个文档？
- 同一个概念在哪些项目、时间和来源中出现？
- 某个结论由哪些 Chunk 支持，又被哪些资料反驳？
- 一个技术依赖什么、替代什么、属于什么、由什么导致？
- 一个 Topic 的核心实体、关系、冲突和未知问题是什么？
- 文档变化后，哪些 Claim、Topic、报告章节和 HTML 需要刷新？

Graph 是 Source/Knowledge 与 Retrieval/Topic 之间的组织骨架，不是独立于证据的“AI 记忆”。每条可陈述事实必须能回到 Claim、Chunk、Revision 和 Source Snapshot。

## 2. 存储选型

Graph 的权威存储是实例内同一个 `data/self.sqlite3`：

- 节点和关系使用普通 SQLite 邻接表。
- 邻居查询使用组合索引。
- 有界路径和层级遍历使用 Recursive CTE。
- 语义近邻使用 sqlite-vec 的独立派生表，不把 Top-K 相似度永久膨胀成事实边。
- FTS 负责精确文本，Vector 负责候选召回，Graph 负责有类型、可解释的关系扩展。
- Cytoscape.js 只负责 Artifact 中的交互展示，不是图数据库。

第一阶段不使用 Neo4j、ArangoDB、NebulaGraph 或外部 RDF Store。原因是 Self 必须单目录迁移、备份和恢复；个人知识规模下 SQLite 的邻接表、有界遍历和预计算投影足够。未来只有真实 Benchmark 证明 SQLite 不满足 Large Profile 时，才允许增加可删除、可重建的图索引 sidecar，SQLite 仍是事实源。

文件格式定位：

| 格式 | 定位 |
| --- | --- |
| SQLite 表 | 权威 Graph、状态、证据和索引 |
| JSON | CLI、Page IR 和局部子图传输 |
| JSON-LD | 语义互操作导出 |
| GraphML | Gephi、Cytoscape 等图工具交换 |
| HTML/Cytoscape JSON | Artifact 展示产物，可重建 |
| RDF/Turtle | 未来可选导出，不作为第一版内部模型 |

## 3. 关系的五个层次

Graph 明确区分来源和语义强度：

1. **结构关系**：Source、Document、Revision、Chunk、Claim 的组成和证据链，确定性产生。
2. **显式文档关系**：Markdown Link、Wiki Link、Embed、引用、Frontmatter、Tag 和附件链接，由 Parser 产生。
3. **实体语义关系**：`is_a`、`part_of`、`uses`、`depends_on`、`created_by` 等，需要证据和类型约束。
4. **Claim 关系**：`supports`、`contradicts`、`refines`、`supersedes`、`equivalent_to`，用于可信综合。
5. **派生相似关系**：Chunk/Document 的 Vector Top-K、聚类和 Topic 候选，可重建且不能直接当成事实。

## 4. 核心对象

- `GraphNode`：Graph 内统一节点投影，可引用 Document、Chunk、Topic、Entity、Claim 等稳定对象。
- `Entity`：人物、组织、项目、概念、技术、事件、地点、作品或用户自定义类型。
- `EntityAlias`：实体别名、语言、范围和来源。
- `PredicateDefinition`：受控关系词典、方向、Domain/Range、逆关系和约束。
- `Relation`：主体、谓词、客体、时间、状态和派生方式。
- `RelationEvidence`：Relation 到 Claim/Chunk 的证据连接。
- `Claim`：可被支持、反驳、确认或过期的主张。
- `ClaimEvidence`：Claim 到 Chunk 的直接证据或反证。
- `ClaimRelation`：Claim 之间的支持、冲突、细化和替代。
- `UnresolvedReference`：尚未解析目标的 Wiki Link、Citation 或别名。
- `SemanticNeighbor`：绑定 VectorSpace 的可重建 Top-K 相似投影。
- `GraphGeneration`：一次派生图谱增量/全量构建版本。
- `EntityRedirect`：实体 merge 后旧 ID 到新 ID 的永久重定向。

## 5. 关键不变量

- 人工或源文档显式关系与 AI 推断关系必须区分 `origin`。
- 机器抽取的 Relation/Claim 默认 `proposed`，不能直接伪装成人工确认事实。
- 除明确的 `user_asserted` 外，每个事实 Relation/Claim 至少有一条 Evidence。
- 相似度只是候选信号；`semantic_neighbors` 不能自动提升为事实 Relation。
- Predicate 必须来自版本化 Registry；模型不能任意发明永久谓词。
- 关系具有方向；对称、逆关系和传递性由 PredicateDefinition 定义，不靠字符串猜测。
- 冲突关系必须并存，禁止最后写入覆盖。
- Document/Chunk 删除只使证据失效或关系 stale，不破坏历史 Build。
- 实体 merge 保留所有别名、证据、历史 ID 和 Redirect；不得物理改写历史 Artifact。
- 增量构建最终必须收敛到相同输入上的全量重建结果。

公开 ID 使用：`graph-node:gn_...`、`entity:ent_...`、`relation:rel_...`、`claim:clm_...`、`evidence:evd_...`、`reference:gref_...`、`conflict:cfs_...`、`generation:ggen_...`、`extraction:gex_...`。

## 6. 领域边界

Graph 负责：

- Entity、Alias、Predicate、Relation、Claim、Evidence、Conflict 和 GraphGeneration。
- Knowledge 对象的 Graph 投影。
- 显式链接解析、实体消歧、关系/Claim 抽取和图谱查询。
- 图谱 rebuild、verify、export 和受控修改。

Graph 不负责：

- Source Snapshot、Document/Revision/Chunk 的权威内容；属于 Source/Knowledge。
- Chunk Embedding 和 VectorSpace；属于 Knowledge。
- 多路召回的最终融合排序；属于 Retrieval。
- Topic 报告结构和 HTML；属于 Topic/Artifact。

## 7. 与其他领域的协作

```text
IngestionPublished / KnowledgeChanged
  → Graph 建立结构投影和显式链接
  → Model 抽取 Entity / Relation / Claim 候选
  → Graph 消歧、校验、聚合并绑定 Evidence
  → Retrieval 使用有界 Graph Expansion
  → Topic 固化本次使用的局部子图快照
  → Artifact 渲染图谱、时间线、冲突和证据
```

## 8. 详细文档

- [`model.md`](./model.md)：节点、关系层次、谓词、Claim、状态和不变量。
- [`schema.md`](./schema.md)：SQLite 表、索引、查询和版本策略。
- [`workflows.md`](./workflows.md)：增量构建、显式链接、实体消歧、全量重建和失效传播。
- [`commands.md`](./commands.md)：Graph、Entity、Relation、Claim CLI 和错误语义。
- [`testing.md`](./testing.md)：图结构、证据、增量等价、性能和真实 Vault 测试。
