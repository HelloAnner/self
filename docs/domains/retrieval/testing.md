# Retrieval 测试矩阵

- 中文、英文、路径、标题和代码术语的 trigram FTS Fixture。
- FTS/Vector/Hybrid 均返回完整 Chunk→Source 证据链和稳定顺序。
- 同维度不同 fingerprint、不同维度和非 active 空间均无法混查。
- Provider 缺失、断网、Model Not Found、Sentinel 漂移：vector 失败、hybrid 明确降级。
- Source/path/type/tag/time过滤组合、结果上限和特殊 FTS 字符无注入。
- 影子重建和 VectorSpace build 期间旧 active 指针持续查询。
- 增量索引与最终资料全量重建的当前 Search signature 等价。
- 阶段耗时和 EXPLAIN QUERY PLAN 进入 Gate，Small Profile 本地阶段满足性能预算。
- 编译后二进制 `ask` 覆盖冲突并存、每条事实 Citation、Claim 可信度和标准结果类型。
- 伪造 Evidence key、非原文 excerpt、无 Citation 事实和单证据 inference 均不得发布 Answer。
- 无证据默认不调用模型；显式外部知识必须标记 `model_knowledge` 且无伪 Citation。
- Knowledge/Graph/Claim 改变后旧 Context 与 Answer cache 进入 `stale`，历史链仍可查询。
- `trace` 重放每个 Context Item 的 excerpt Hash，并证明 Answer → Chunk → Revision → Snapshot → Source。
- Schema 6→7 通过显式 Migration Plan/Apply；失败场景保留旧 Schema backup。
- Phase 6 合成 E2E 使用确定性 Chat Provider；Live Gate 使用环境变量凭证和真实 OpenAI-compatible Provider，证据目录不得包含私人正文或 Key。
