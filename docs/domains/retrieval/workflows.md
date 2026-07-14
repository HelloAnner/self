# Retrieval 工作流

```text
parse/limit/filter
  ├─ text: active FTS Generation
  └─ vector: exact active VectorSpace → compatible Query Embedding → partitioned KNN
merge by Chunk ID → RRF → bounded local rerank → bulk evidence hydrate → result/trace
```

- `--mode text` 不访问模型。
- `--mode vector` 没有 active ready 空间、Provider 不可用或漂移时明确失败。
- `--mode hybrid` 同样问题时返回 FTS 结果并附 `vector_degraded` warning；不得用另一 Model 查询旧空间。
- FTS 与 Vector 各自先限制候选，再统一过滤和 Hydration，避免 N+1 和无界数组。
- `--explain` 显示 route rank/score、RRF 贡献、过滤、index generation、space fingerprint 和分阶段耗时，不泄露向量或正文之外的秘密。

## Ask

```text
normalize Query / hash
  → capture active FTS + VectorSpace + GraphGeneration
  → Search seeds
  → seed Chunk → mentions/entity → Claim → Claim Evidence bounded expansion
  → dedupe and fit deterministic Context budget
  → persist RetrievalRun + EvidenceContext
  → no evidence? insufficient_evidence without model
  → structured Chat response
  → validate local evidence key
  → map normalized quote back to exact Chunk substring
  → validate conclusion type / inference citation count / conflict
  → atomically publish Answer + Statement + Citation
```

模型调用不在 SQLite 事务内。Context 先固化，响应通过门禁后才在一个事务中发布 Answer；Provider 失败或 Citation 失败不会留下半个 Answer。Invocation 仅保存 Hash、模型、token、耗时和错误，不保存 API Key。

`trace` 从 Answer 读取其 RetrievalRun、Context 水位与全部 Item，并重新从不可变 Chunk 取出原文验证 Hash。输出的 Citation 链为 `Statement → ContextItem/Claim → Chunk → Revision → Snapshot → Source/Blob`。同一知识快照可重复得到相同 Context Hash；依赖变化后旧 Context 保留但状态为 `stale`。

`related <ID>` 使用有界 Graph traversal；`related <query>` 使用 text seed 后扩展 Claim Evidence。它不调用 Chat Model，也不把 `similar_to` 默认当成事实边。
