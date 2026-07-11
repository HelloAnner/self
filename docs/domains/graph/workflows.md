# Graph 工作流

## 1. 增量构建总流程

```text
KnowledgeChanged(revision, changed chunks)
  → 同步结构节点投影
  → 解析显式 Link/Embed/Citation/Tag
  → 解析或记录 UnresolvedReference
  → 对变化 Chunk 执行 Entity/Mention 抽取
  → Entity Candidate 消歧
  → Relation/Claim 结构化抽取
  → Predicate、Domain/Range、Schema 校验
  → 绑定 Evidence 和 Source Lineage
  → Claim 聚类、支持/冲突检测
  → 更新 Confidence 和影响集合
  → 发布 GraphChanged
  → 标记相关 Retrieval Cache、Topic、Artifact stale
```

未变化 Chunk 的抽取结果按 `input_hash + extractor/model/prompt/schema` 复用。模型调用发生在事务外；校验通过的候选在短事务内幂等发布。

## 2. 显式文档链接

### 2.1 创建

Parser 输出原始 Target、链接类型、显示文本和 Source Position。Graph：

1. 规范化相对路径、Wiki 名称、Heading 和 Block ID。
2. 在当前 Workspace 文档索引中精确解析。
3. 唯一命中时创建 `links_to`、`embeds` 或 `cites` Relation。
4. 无命中时写 UnresolvedReference `missing`。
5. 多命中时写 `ambiguous` 和候选 ID，不猜测。

### 2.2 Rename/Move

Document ID 不随路径改变。路径索引变化后：

- 已按 Document ID 解析的 Relation 保持。
- 未解析和 ambiguous Target 重新尝试。
- 原始 Target 和旧 Revision Evidence 保留。
- Self 不自动重写外部文件链接；若要修复，生成独立 Plan。

## 3. Entity 抽取和消歧

1. Parser/Model 输出 Mention、候选类型和原文 span。
2. 精确 identity key 优先命中。
3. 再按 Alias、类型、同现上下文和 Scope 召回候选。
4. 规则计算 match reasons；模型只能对有限候选重排。
5. 高确定性命中绑定现有 Entity。
6. 不确定时创建 proposed Entity 或 MergeCandidate。
7. 禁止只按名称相同自动合并。

用户确认 Merge 后，应用层在一个 Operation 中创建 Redirect、移动当前投影、更新受影响对象版本并标记 Topic/Artifact stale。历史 Build 继续解析旧 ID。

## 4. Relation 和 Claim 抽取

模型输入只包含有限 Chunk、已知 Entity 候选、Predicate Registry 子集和输出 Schema。输出必须：

- 引用输入中的 Entity/Mention ID。
- 使用允许的 Predicate。
- 给出 Evidence span。
- 分离原文直接陈述与模型推断。
- 保留时间、版本、条件和否定信息。

校验失败只使 ExtractionRun failed/partial，不发布半条事实。AI 候选默认 proposed；显式 Parser 关系可按规则 accepted。

## 5. Claim 对齐和冲突

候选 Claim 按 subject、predicate、object/value、qualifier 和时间分桶，再进行语义对齐：

- 相同语义 → `equivalent_to` 或聚合 Evidence。
- 更具体 → `refines`。
- 新版本替代旧版本 → `supersedes`。
- 相同适用范围且不能同时为真 → `contradicts`。
- 提供支持但不是同一主张 → `supports`。

时间范围不同、版本不同或条件不同不自动判冲突。模型只能提出 Conflict Candidate，规则和用户可以确认。

## 6. Semantic Neighbor 构建

对每个 ready VectorSpace：

1. 选择 Active Chunk/Document 节点。
2. 按项目、语言、类型或时间做预过滤。
3. KNN 取有限候选。
4. 去除同文档相邻 Chunk 和内容重复。
5. 写入 Top-K、score、rank、内容 Hash 和算法版本。
6. 超过阈值的候选可进入 Relation Enrichment，但仍需证据校验。

VectorSpace 激活变化触发新空间 Neighbor Job；旧空间投影保持可回滚但不参与 Active Graph Retrieval。

## 7. 文档变化和失效传播

Revision 更新时：

- 未变化 Chunk 和 Evidence 保持 active。
- 被替换 Chunk 的 Evidence 进入 stale。
- 只剩 stale Evidence 的 Relation/Claim 进入 stale/needs_review。
- 仍有其他 active Evidence 的对象重新计算 Confidence。
- SemanticNeighbor 按双方内容 Hash 局部重算。
- 受影响 Topic/Section/Artifact 通过依赖索引标记 stale。

删除使用 tombstone。历史 Revision、Evidence 和 Build 按 Retention 保留，不能 cascade 物理删除。

## 8. 全量重建

Graph 重建分层：

```text
structure  → 系统对象和组成链
links      → Link/Embed/Citation/Tag
mentions   → Entity Mention 与候选
relations  → 语义 Relation
claims     → Claim、Evidence、冲突
neighbors  → 绑定 VectorSpace 的相似投影
all        → 按上述顺序
```

过程：

1. 创建 shadow GraphGeneration。
2. 从本地 Revision/Chunk 和当前配置读取输入，不依赖外部原始路径仍在线。
3. 复用人工确认 Entity、Redirect、Relation/Claim Overlay。
4. 分层构建并保存 checkpoint。
5. 校验数量、Evidence 覆盖、Redirect、Predicate、抽样路径和 Golden Query。
6. 比较新旧 Generation 的 Node/Edge/Claim Diff。
7. 短事务激活新 Generation。
8. 旧 Generation 保留回滚期，再由 GC Plan 清理。

重建开始时不得清空 Active Graph。模型 Provider 不可用时，structure/links 仍可完整重建；模型派生层保持旧版本或明确 partial。

## 9. 增量与全量等价

规范比较忽略 Generation ID、时间和物理行号，但必须等价：

- Active GraphNode 外部引用。
- 显式文档关系和 UnresolvedReference。
- Entity、Alias、Redirect。
- Relation/Claim 的规范身份、状态、限定和 Evidence 集。
- Conflict/ClaimRelation。
- Active VectorSpace 的 SemanticNeighbor Top-K（允许浮点容差和稳定 tie-break）。

不等价视为数据正确性缺陷，不能以“AI 有随机性”忽略；非确定性输出必须通过缓存、固定模型快照和规范聚合控制。

## 10. 查询工作流

```text
Query
  → FTS/Vector 找到种子 Chunk/Entity/Claim
  → Graph 按 Predicate allowlist 有界扩展
  → 批量 Hydrate Evidence
  → 按时间、来源、可信度和 Topic Scope 过滤
  → 返回 Subgraph + Trace
```

Graph Expansion 不默认遍历 `similar_to`，避免语义边造成爆炸。每次查询记录种子、扩展 Predicate、深度、裁剪原因和使用的 Generation。

## 11. 备份和恢复

Graph 随 `self.sqlite3` 一致性备份。恢复后：

- 验证 Active Generation、Predicate Seed 和跨领域引用。
- SemanticNeighbor、closure/metrics 等派生投影允许重建。
- 手工确认、Evidence、Redirect 和 Conflict 不得只存在于缓存/导出文件。
- JSON-LD/GraphML 不能代替数据库备份。
