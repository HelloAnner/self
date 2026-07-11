# Knowledge SQLite Schema

> 状态：Database Schema 4 implemented

| 表 | 用途 |
| --- | --- |
| `knowledge_documents` | 稳定 Document、当前 Revision 和 tombstone |
| `knowledge_revisions` | 不可变规范内容、Snapshot/Blob/Parser 证据 |
| `knowledge_chunks` | 稳定、不可变 Chunk 内容与 active/tombstoned 投影 |
| `knowledge_revision_chunks` | Revision 内 Chunk 顺序、标题路径和行定位 |
| `knowledge_run_documents` | 每个 ready Run 发布或复用的 Document/Revision |
| `knowledge_chunk_lineage` | 新旧 Chunk modified/split/merged 映射 |
| `knowledge_notes` | managed Note、Source/Document 和乐观版本 |

Revision 唯一键为 `(document_id, snapshot_id, algorithm_fingerprint)`；Chunk 不因 Revision 更新而原地修改。新当前 Revision 与 Chunk 状态在同一个 Knowledge 发布事务中切换。FTS5 和向量表不在 Schema 4 创建，避免把 Phase 4 索引误报为已完成。
