# Ingestion 领域

> 状态：待详细设计

## 目标

Ingestion 将 Source 的原始快照转换为可进入统一知识底座的规范内容，并保证失败可见、可重试、可恢复。

## 负责范围

- 文件类型识别和解析器选择
- Markdown、HTML、PDF、Office、代码等结构解析
- OCR、媒体转写和结构化数据展开
- 文本规范化、语言检测和语义切片
- 摄入状态机和阶段 checkpoint
- Parser 与 Chunker 版本记录
- 新旧 Chunk 对齐和变更集合输出

## 核心对象

- `IngestionRun`：针对 Snapshot 的一次摄入运行
- `ParseResult`：结构化解析结果
- `NormalizedDocument`：格式无关的规范文档
- `ChunkDraft`：尚未发布到 Knowledge 的语义片段
- `IngestionFailure`：可定位、可重试的阶段错误

## 状态机

```text
queued → parsing → normalized → chunked → publishing → ready
             └──────────────────────────→ failed ──→ retrying
```

前置条件是 Source Snapshot 已经归档；`archived` 属于 Source，不是 IngestionRun 状态。

## 关键不变量

- 没有 Snapshot 不得开始摄入。
- 同一 Snapshot、解析器版本和配置应产生确定性结果。
- 部分失败不能被标记为 `ready`。
- 重新切片必须输出旧 Chunk 到新 Chunk 的映射。

## 不负责

- 原始文件同步
- Chunk 的长期所有权和检索索引
- Entity、Relation 和 Claim 的最终发布
