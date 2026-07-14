# Knowledge SQLite Schema

> 状态：Database Schema 6 current；Knowledge 表沿用 Schema 5，Graph 表由 Graph 领域拥有

| 表 | 用途 |
| --- | --- |
| `knowledge_documents` | 稳定 Document、当前 Revision 和 tombstone |
| `knowledge_revisions` | 不可变规范内容、Snapshot/Blob/Parser 证据 |
| `knowledge_chunks` | 稳定、不可变 Chunk 内容与 active/tombstoned 投影 |
| `knowledge_revision_chunks` | Revision 内 Chunk 顺序、标题路径和行定位 |
| `knowledge_run_documents` | 每个 ready Run 发布或复用的 Document/Revision |
| `knowledge_chunk_lineage` | 新旧 Chunk modified/split/merged 映射 |
| `knowledge_notes` | managed Note、Source/Document 和乐观版本 |

Revision 唯一键为 `(document_id, snapshot_id, algorithm_fingerprint)`；Chunk 不因 Revision 更新而原地修改。新当前 Revision 与 Chunk 状态在同一个 Knowledge 发布事务中切换。

Schema 5 增加 `knowledge_index_generations`、`knowledge_active_indexes`、`knowledge_fts`、`vector_spaces`、`vector_build_runs`、`knowledge_embeddings`、`knowledge_active_vector_space` 和 `vector_space_evaluations`。FTS 使用 Generation 隔离 shadow rows；vec0 按受校验维度创建 `knowledge_vec_f32_<dimensions>`，并以 `vector_space_id TEXT PARTITION KEY` 隔离同维度空间。普通表保存证据/FK，虚表只保存 KNN 所需 ID、partition 和向量。
