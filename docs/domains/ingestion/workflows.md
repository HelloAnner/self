# Ingestion 工作流

## Build

1. 验证 Source/Snapshot 和 `self.toml [ingestion]`。
2. 以 Snapshot 与算法 fingerprint 创建或恢复 IngestionRun。
3. 从 Root 内 Blob 读取字节，按 MIME/扩展选择真实 Parser。
4. 规范化换行、Unicode、结构、链接和证据行号。
5. 使用版本化 semantic Chunker 生成确定性 ChunkDraft。
6. 将 entry 结果和 checkpoint 写入 Ingestion 表。
7. 由 Knowledge Repository 在一个短事务中发布 Document/Revision/Chunk 映射。
8. 最后把 Run 与 Source 投影切换为 `ready`。

解析、PDF 解码和 Chunk 计算都在事务外。Knowledge 发布成功但 Run 尚未 ready 时，重试复用已经发布的 Revision/Chunk；发布事务失败则不留下半套当前指针。

## Parser 边界

- Markdown：Frontmatter、标题、列表、引用、表格、代码围栏、Markdown/Wiki Link 和行号。
- Text/JSON/CSV：UTF-8 规范文本。
- HTML：移除 script/style/template，保留标题、正文和链接，不执行来源代码。
- JSONL：逐行严格 JSON，键顺序规范化。
- PDF：`pdfjs-dist` 只做文本/页码提取；不渲染、不联网，扫描件 OCR 留给插件。
- 不支持媒体：明确 `skipped`，不伪装为 parsed。
