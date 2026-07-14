# Topic 工作流

## 1. 定义 Topic

~~~text
name + scope + exclude + aliases
  -> Unicode 规范化与唯一检查
  -> Topic(active, version=1)
~~~

Scope 为空时使用 Topic 名称。Alias 去重但保留用户可读形式。更新 Scope、Exclude 或 Alias 会递增 version；已经存在 latest 时同步标记 stale，原因是 topic_scope_changed。

## 2. 首次完整 Build

~~~text
读取 Topic/Scope/version
  -> 生成 deep RetrievalPlan
  -> FTS/Vector 候选与 Graph Claim 扩展
  -> 固化 RetrievalRun + EvidenceContext
  -> 应用排除条件
  -> 读取 Claim Evidence、ConflictSet 和来源谱系
  -> Claim 聚类与局部 Graph
  -> 分类 consensus/single_source/opinion/inference/conflict
  -> 生成 Outline/Section/KnowledgeGap
  -> 计算 Confidence/Coverage/Health
  -> 写不可变 TopicSnapshot
  -> 原子切换 Topic.latest_snapshot_id
~~~

默认 mode 为 text，以保证离线构建稳定；可显式使用 vector/hybrid。无 Claim 时仍发布 insufficient Snapshot：只包含概览和 KnowledgeGap，不调用模型补写内容。

## 3. 重复 Build 与版本

Phase 7 的重复 topic build 是完整 rebuild。它总是创建新 Snapshot：

- 相同输入收敛到相同 snapshot_hash。
- Section 内容 Hash 相同则 change_kind=unchanged，并记录 parent_section_id。
- 不同内容标记 modified；新章节标记 added。
- change_summary 保存 Claim added/removed/unchanged 和章节变化。

旧 Snapshot 可用 topic report --snapshot 读取。Phase 8 已在这个父链上实现 topic refresh：active Topic 重复调用直接跳过检索；stale/needs_review Topic 生成新 Snapshot，Section change_kind 与稳定依赖 Hash 驱动 Artifact 只重建受影响组件。HTML 为保证内部一致性仍完整快速重编译。

## 4. 失效传播

- Knowledge 发布：所有有 latest 的 active Topic 标记 stale。
- Graph Generation 激活或通用 Graph 变更：相关精确依赖尚不可得时保守标记 active Topic stale。
- Claim confirm/reject：只查询 latest TopicSnapshot 中包含该 Claim 的 Topic，标记 needs_review。
- Scope/Alias/Exclude 更新：当前 Topic 标记 stale。

失效只修改 Topic 当前状态，不修改历史 Snapshot、Section 或 Citation。

## 5. Graph 抽取部分失败

结构化模型输出不符合 Schema 或返回未知 Predicate 时，该 Chunk 的 ExtractionRun 标记 failed，并计入 chunks_failed/failure_codes；同批其他 Chunk 继续。凭证缺失、网络和 Provider 故障仍中止批次，防止把系统性失败伪装成成功。

Graph Generation 只有通过完整 verify 后才能激活。旧 Generation 在新构建期间继续服务。

## 6. Section Trace

trace section 读取 Section 和 Conclusion，批量加载 Citation，并根据字符区间从 Chunk 重放原文 Hash。输出链为：

~~~text
ReportSection -> Conclusion -> Claim -> Chunk -> Revision -> SourceSnapshot -> Source/Blob
~~~

任何 Hash 不一致都是完整性失败，不能只显示 warning 后继续当作受支持结论。
