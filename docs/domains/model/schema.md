# Model SQLite Schema

> 状态：Schema 7 current；Model 表沿用 Schema 5，Graph/Answer 业务记录分别属于 Graph/Retrieval

| 表 | 所有权与用途 |
| --- | --- |
| `model_providers` | Provider protocol、Endpoint Identity、凭证环境变量名、Circuit 状态 |
| `models` | capability、Provider Model ID、Revision 稳定性和允许维度 |
| `model_invocations` | 无正文、无凭证的调用审计、用量、延迟和错误 |
| `model_sentinel_results` | VectorSpace 的公共 Sentinel fingerprint、实际 Model ID 与检查结果 |

Endpoint Identity 进入 VectorSpace fingerprint，API Key、并发和超时不进入。删除凭证不删除 Model、Invocation 或已有向量。Invocation 通过 `vector_space_id` 关联 Knowledge，但不拥有 VectorSpace。

`models.capability='chat'` 在 Phase 5 正式启用。Graph 专属 Prompt/Schema、input/output Hash 和 checkpoint 存在 `graph_extraction_runs`；模型调用审计仍统一进入 `model_invocations`，没有请求正文或响应正文列。

Phase 6 的 `model_invocations.operation_kind='retrieval.ask'` 记录 Model、Provider、input Hash、实际 Model、prompt token、耗时和错误码；请求、EvidenceContext 正文、响应体和 API Key 均不进入 Invocation。Answer 通过 `invocation_id` 引用审计记录。
