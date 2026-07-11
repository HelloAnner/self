# Ingestion 领域模型

> 状态：Phase 3 implemented

`IngestionRun` 唯一描述一个 Snapshot 在固定算法配置下的摄入。幂等身份由 `snapshot_id + config_fingerprint` 决定；Parser、Normalizer、Chunker 版本与 Chunk 配置共同构成 fingerprint。

状态机：

```text
queued → parsing → normalized → chunked → publishing → ready
              └──────────────────────────────→ failed → retrying
```

`NormalizedDocument` 是格式无关 DTO，包含规范文本、Block、标题层级、链接、标签、Frontmatter、语言、原始行定位、内容 Hash 和结构 Hash。Markdown、纯文本、HTML、JSONL 和 PDF 都必须产生同一 DTO；图片等未支持附件记为 `skipped`，解析器声称支持但失败则整个 Run 为 `failed`。

不变量：

1. Run 只能从已经归档的 Snapshot 开始。
2. `ready` Run 的每个 parsed entry 都有 Run→Document→Revision 投影。
3. Parser 失败不得发布任何该 Run 的 Knowledge 半成品。
4. `publishing` 后崩溃可通过幂等键和 Revision 唯一键安全重试。
5. 错误只保存路径、阶段和脱敏原因，不保存完整私人内容。
