# Retrieval 领域模型

> 状态：Phase 6 implemented

`Query` 保存本次请求中的文本和过滤条件，但默认不持久化原文。`Candidate` 按 Chunk 稳定 ID 去重，并分别保存 FTS rank、Vector distance、route rank 和来源。`RetrievalTrace` 返回阶段耗时、候选裁剪、active FTS Generation/VectorSpace 与降级原因。

FTS rank 和 Vector distance 不可直接相加。Hybrid 使用确定性的 Reciprocal Rank Fusion，再施加有限的标题/路径精确命中规则；输出同时保留每一路贡献。相同索引指针、Query 和过滤条件应得到稳定顺序，最终 tie-breaker 是 Chunk ID。

过滤支持 Source ID、逻辑路径前缀、媒体类型、标签和 Revision 时间范围。任何结果都携带 Chunk、Document、Revision、Snapshot、Blob 与来源行定位。

## 带证据回答对象

`RetrievalPlan` 固化 Query Hash、模式、深度、过滤条件、候选上限和 Context token budget。`shallow|normal|deep` 只扩大受限候选、Graph 深度与预算，不改变证据规则。

`EvidenceContext` 是一次回答实际交给模型的最小证据快照。每个 Item 使用 `E1` 等局部 key，并保存 Chunk、Document、Revision、Source、Snapshot、Blob、可选 Claim、原文范围与 Hash。正文从不可变 Chunk 重放；Query 原文默认不持久化。

`Answer` 包含若干 `Statement`。结论类型为 `fact|single_source|user_opinion|inference|conflict|unknown|model_knowledge`；可信度沿用 Claim 的 `high|medium|low|disputed|unknown`，不能由检索分数冒充。`model_knowledge` 只在显式 `--allow-model-knowledge` 时允许，并且不能伪装 Citation。

每个事实型 Statement 必须有 Citation。Provider 返回局部 Evidence key 和 supporting excerpt；Self 将其规范化回映到 Chunk 中的精确原文范围，再以精确原文作为可发布 Statement。`inference` 至少引用两个 Evidence Item。无法回映、未知 key 或缺失引用均返回 `answer_citation_unsupported`，不创建 Answer。

标准结果为：`answered`、`insufficient_evidence`、`conflicted`、`cannot_determine`。冲突证据不会相互覆盖；无证据且未允许模型外部知识时不调用 Chat Model。
