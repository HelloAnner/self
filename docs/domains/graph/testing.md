# Graph 测试设计

## 1. 核心目标

Graph 测试不仅验证“能查到边”，还必须验证关系类型、方向、证据、时间、冲突、重建和历史可解释性。

## 2. Fixture

最小 Graph Fixture 包含：

- 3 个显式互链 Markdown，其中含 Wiki Link、Embed、Heading 和不存在链接。
- 同名不同人的消歧场景。
- 一个实体的中英文和缩写别名。
- 两个支持同一 Claim 的独立来源。
- 两篇转载同一来源的非独立证据。
- 时间范围不同、表面矛盾但实际不冲突的 Claim。
- 真正互斥的 Claim。
- 一条被新版本 supersede 的 Relation。
- Vector 相似但事实无关的负例。
- Entity Merge 后旧 ID 仍被历史 Artifact 引用。

## 3. Schema 与约束测试

- Relation subject/object、Predicate 和 JSON 约束生效。
- Domain/Range 不合法被 Application 拒绝。
- 对称 Relation canonicalization 幂等。
- EntityRedirect 不能成环。
- Fact Relation/Claim 缺 Evidence 时不能 accepted。
- Qualifier 相同去重，不同时间/版本可并存。
- 跨领域 Chunk 删除不触发证据物理级联。
- SemanticNeighbor 每节点 Top-K 有硬上限且绑定 VectorSpace。

## 4. 显式链接测试

- 相对 Markdown Link、Wiki Link、Alias、Heading、Block 和 Embed 正确解析。
- Rename/Move 后已解析 Relation 仍指向相同 Document ID。
- Missing/Ambiguous 保存原始 Target、位置和候选。
- 新文档加入后 pending Target 最终解析。
- 链接解析不越过 Workspace/Connection 安全边界。

## 5. Entity 测试

- 名称相同但类型/上下文不同不自动合并。
- 强 identity key 重复被确定性合并。
- Alias 查找语言和 Scope 正确。
- Merge 保留 Evidence、Alias、Redirect 和历史 ID。
- Split 只移动 Plan 指定 Mention，受影响 Claim/Topic stale。
- 并发 Merge 使用版本冲突拒绝旧 Plan。

## 6. Relation、Claim 和 Conflict

- 模型未知 Predicate 不进入正式 Relation。
- 否定、条件、版本和时间限定不丢失。
- Evidence span 必须落在指定 Chunk/Revision。
- 支持、反证、上下文角色正确。
- 同一转载链不增加 corroboration 独立数。
- 冲突双方同时保留，解决操作不删除历史。
- 证据 Revision 失效后 Confidence 和状态正确传播。

## 7. Semantic Neighbor

- 同一空间相似关系按稳定 tie-break 排序。
- 不同 VectorSpace 的 score 不混合。
- 内容 Hash 变化只重算受影响邻居。
- VectorSpace 切换使旧 Neighbor stale 并构建新投影。
- 高相似负例不会未经验证提升成事实 Relation。

## 8. 增量与重建等价

随机执行新增、修改、移动、删除、恢复、Merge 和 Split：

1. 在实例 A 走增量路径。
2. 将最终 Sources 导入实例 B 全量重建。
3. 规范化比较 Node、显式 Link、Entity、Relation、Claim、Evidence、Conflict 和 Neighbor。
4. 忽略运行 ID/时间，要求业务身份与状态等价。

这是 Release 阻断门禁。

## 9. Crash Matrix

故障点：

```text
after_graph_node_projection
after_explicit_link_parse
during_entity_resolution
after_extraction_response
before_graph_publish
during_claim_alignment
during_semantic_neighbor_batch
before_generation_activate
during_entity_merge
```

每个故障点重启后验证 Active Generation 仍完整、Job 可重试、没有半 Relation/Claim、旧图可查询。

## 10. 查询性能

在 Medium Profile 测试：

- ID/Entity/Alias 点查。
- 一跳和二跳邻居。
- 深度 ≤4 的受限路径。
- 100 节点/300 边 Subgraph。
- Claim → Evidence 批量 Hydration。
- Background Rebuild 与前台 Graph Query 并发。

任何意外全表扫描、N+1 Evidence 查询或无界 Recursive CTE 阻止发布。预算以 `docs/performance.md` 为准。

## 11. Export 和 Artifact

- JSON、JSON-LD、GraphML 节点/边数量和稳定 ID 一致。
- 导出 proposed/stale 需要显式选项。
- Cytoscape 页面节点可以回到 Entity/Claim/Chunk。
- 大图默认聚类、分页或按需展开，不一次输出全部节点。
- 离线 HTML 不依赖外部图服务。

## 12. 人工验收

用真实 Obsidian Vault 和多个项目 docs 验证：

1. Backlink 与 Obsidian 实际链接一致。
2. 同一概念跨项目形成 Entity 关联。
3. Topic 能沿 Graph 找到仅靠关键词/向量遗漏的证据。
4. HTML 展示关系类型、方向、Evidence、冲突和时间。
5. 人工纠正 Entity/Relation 后，下一次模型重建不会覆盖确认结果。
