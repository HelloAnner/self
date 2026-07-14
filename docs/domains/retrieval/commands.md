# Retrieval CLI Contract

```text
self search <query> [--mode text|vector|hybrid] [--limit <n>]
  [--source <source-id>] [--path <prefix>] [--type <media-type>]
  [--tag <tag>] [--since <iso>] [--until <iso>]
  [--explain] [--json]
```

默认 mode/limit 来自 `self.toml`，limit 有硬上限 100。结果包括稳定 evidence ID、片段、路径、行号、最终分数和 route；`--explain` 增加完整 trace。空 Query、非法时间范围和超限返回 usage error。

Phase 4 已实现 Source、路径前缀、媒体类型、标签和 Revision 时间过滤。独立 Project/Collection/Topic 对象尚未进入数据库，在相应领域落地前不注册伪造的 `--project/--topic/--collection` 过滤语义。

## Ask

```text
self ask <query|-> [--mode text|vector|hybrid]
  [--depth shallow|normal|deep] [--model <chat-model-id>]
  [--source <source-id>] [--tokens <256..32000>]
  [--allow-model-knowledge] [--json]
```

没有 `--model` 时选择首个可用 active Chat Model；证据为空且未允许外部知识时不需要 Model。返回 `answer_id`、`retrieval_run_id`、`context_id`、标准 `result_kind`、模型/Invocation、Statement 类型/可信度和 Citation 完整证据 ID。

稳定失败：`ask_input_invalid`、`ask_depth_invalid`、`context_budget_invalid`、`model_not_available`、`model_network_disabled`、`model_call_failed`、`model_response_invalid`、`answer_citation_unsupported`。最后一项表示模型输出未通过证据发布门禁，退出码为 external error，且不会创建 Answer。

## Related 与 Trace

```text
self related <resource-id|query> [--depth 1..4] [--limit 1..500] [--json]
self trace <answer-id|claim-id|chunk-id> [--json]
```

`trace answer:...` 返回 Context Items、重放 Hash、模型/Prompt 版本和全部证据链。Phase 6 支持 Answer、Claim、Chunk；Section/Topic 在 Phase 7 对象落地后接入同一协议。
