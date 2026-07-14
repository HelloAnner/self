# Model 领域模型

> 状态：Phase 6 implemented

`Provider` 描述调用协议、非敏感 Endpoint Identity、凭证环境变量名和 Circuit 状态；它不保存 API Key。`Model` 是 Provider 中一个明确 capability、Model ID、Revision 稳定性和允许维度集合的注册项。Phase 4 只执行 Embedding capability，但表和审计对象允许后续对话/视觉 Route 复用。

`Invocation` 只保存输入 Hash、批量大小、实际 Model ID、用量、延迟、错误和目标 VectorSpace，不保存 Query、Chunk 正文或凭证。Hosted 浮动别名的响应 Model ID 与固定公共 Sentinel 向量共同用于漂移检测。

Fixture Provider 只在 `SELF_ENABLE_TEST_PROVIDERS=1` 时可注册，以固定 Hash-ngram 算法生成可重复向量；它用于故障、迁移和 CLI E2E，不冒充生产语义模型。生产 Hosted 基线为 DashScope OpenAI-compatible `text-embedding-v4@1024`，凭证只从 Registry 记录的环境变量名读取。

稳定错误包括 `model_not_found`、`model_provider_unconfigured`、`model_credentials_missing`、`model_call_failed`、`model_rate_limited`、`model_dimension_mismatch` 和 `model_drift_detected`。

Phase 5 启用 `chat` capability 作为 Graph 结构化抽取边界。OpenAI-compatible Provider 使用 JSON object mode；`graph-extract-v3` 将允许的 Entity 类型、Predicate 和输出契约随请求发送。返回结果先经 Zod Schema、枚举、实体局部引用、原文精确子串和 Predicate Domain/Range 校验，Invocation 仍只保存输入 Hash、实际 Model、Token、耗时和错误，不保存正文/响应体/Key。

Phase 6 增加 `answer-grounded-v1`。Provider 只能引用 EvidenceContext 提供的局部 key，并返回 Statement 类型与逐字 supporting excerpt；Self 在 Model 边界之外把规范化摘录回映为 Chunk 精确原文，再由 Retrieval 决定是否发布。`retrieval.ask` Invocation 与 Graph 调用使用同一审计表，但 Answer/Statement/Citation 由 Retrieval 拥有。
