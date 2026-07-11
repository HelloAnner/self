# Knowledge 核心模型

> 状态：Phase 3 implemented

`Document` 是 `(source_id, normalized_path_key)` 下的长期逻辑身份；Connection 提供 rename 证据时路径更新但 Document ID 不变。`Revision` 是不可变的规范内容版本，记录 Snapshot entry、Blob、Parser/Normalizer 和算法 fingerprint。未变化 Blob 在新 Snapshot 中复用当前 Revision。

`Chunk` 是 Document 内不可变内容身份。`knowledge_revision_chunks` 保存 Chunk 在某 Revision 的 ordinal、标题路径和原始行定位，因此未变化 Chunk 可被多个 Revision 复用且历史证据不被改写。修改 Chunk 创建新 ID，旧 Chunk tombstone，并以 lineage 记录 modified/split/merged 对应关系。

任何 active Chunk 必须能沿：

```text
Chunk → RevisionChunk → Revision → SnapshotEntry → Blob → Source
```

`Note` 是 Root `content/notes/` 中可人工编辑的 Markdown，SQLite 保存 Note ID、Source/Document 映射和乐观版本。每次更新先写 ManagedWriteReceipt，再原子写文件、归档 Snapshot 并发布 Revision；陈旧 `--if-version` 必须冲突且不得改文件。
