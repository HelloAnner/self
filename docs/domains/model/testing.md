# Model 测试矩阵

- 固定 Fixture Provider 重复输入得到逐位一致向量，维度和 L2 规则正确。
- Provider 返回数量、维度、NaN/Infinity 或 Model ID 不符合契约时拒绝写入。
- 429、超时、凭证缺失、Model Not Found 和 Circuit Breaker 有稳定错误。
- Sentinel 漂移后停止 active VectorSpace 的写入和 Query Embedding。
- 日志、Invocation、commands.jsonl、Fixture 和 diagnostics 不包含 Key 或私人正文。
- 默认 Gate 不访问公网；Live Suite 显式注入环境变量、限制批次/费用并单独保存脱敏证据。
- Chat Fixture 与真实对话模型都必须经过相同的 `graph-extract-v3` 校验；未知 Predicate、非法 Domain/Range、非原文 Evidence 和错误 JSON 不发布半成品。
- Fixture 与真实 Chat Model 都必须经过 `answer-grounded-v1` Schema 和 Retrieval Citation 回映；模型改写空白/Markdown 标点时只允许保守规范化匹配，最终保存的 Citation 与 Statement 必须是 Chunk 中的精确原文。
- 无证据默认不产生 Chat Invocation；显式 `--allow-model-knowledge` 的 Statement 必须标记 `model_knowledge` 且没有知识库 Citation。
