# Model 调用工作流

1. Application 解析 Model 与 Provider，校验 capability、维度和 Provider 状态。
2. 从 `self.toml`/Registry 得到 Endpoint 与环境变量名；只在进程内读取 Key。
3. 规范化输入并创建无正文 Invocation，按受控批次调用 Provider。
4. 校验响应数量、维度、有限值，按空间规则 L2 normalize。
5. 保存实际 Model ID、Token、延迟和向量 Hash；正文、Key 和完整向量不进入日志。
6. 429/超时进行有限重试；凭证/Model Not Found 打开 Circuit，调用方得到明确失败。

首次构建 floating Model 的 VectorSpace 时计算公共 Sentinel fingerprint。后续 build/query 先复核；超过容差时停止向该空间写入和 Query Embedding，已有向量保留审计，Hybrid Search 返回 `vector_degraded` 并走 FTS。

结构化 Chat 路径同样在事务外调用 Provider，但不自动重试语义不合规结果。响应必须通过 Graph 的 `graph-extract-v3` Schema、精确摘录和 Predicate 校验后才在短事务发布；不合规响应记录为 failed Invocation/ExtractionRun，Active Graph 不受影响。

Ask 使用独立 `answer-grounded-v1` 契约。模型只能看到有界 EvidenceContext 和局部 E-key；直接结论必须携带原文摘录，Inference 至少携带两个 Citation。Provider JSON 通过 Zod 后仍不直接发布：Retrieval 负责把规范化摘录回映到不可变 Chunk 的精确范围，并校验 key、类型、冲突和外部知识授权。Citation 门禁失败时 Invocation 可记录成功响应，但不会创建 Answer。
