# Knowledge CLI Contract

```text
self knowledge build|status|failures|verify
self knowledge rebuild --layer parse|chunks|all
self knowledge explain <chunk-id>
self knowledge document list|show
self knowledge chunk list|show
self ingestion show|retry
self note create <title> --content <markdown>
self note update <note-id> --content <markdown> --if-version <n> [--title <title>] [--idempotency-key <key>]
self note move <note-id> --to <directory> --plan [--idempotency-key <key>]
self note delete <note-id> --plan [--idempotency-key <key>]
self note restore <note-id> [--if-version <n>] [--idempotency-key <key>]
self note list|show
```

`knowledge explain`/`chunk show` 返回 Document、Revision、Snapshot、Blob、行定位和 lineage。Phase 4 起 `knowledge rebuild --layer fts|vectors` 分别创建 FTS shadow Generation 或重建 active VectorSpace；没有 active VectorSpace 时 vectors layer 返回 `vector_space_not_active`。

VectorSpace 正式契约为 `vector-space create|list|show|active|build|verify|compare|activate|migrate|delete`。create/activate/migrate/delete 先返回 Plan，再由通用 `apply` 执行。

Phase 9 中 Note update 继续以 `--if-version` 直接提交，并加入幂等 Operation/Audit；move/delete 属于高影响操作，只生成通用 Plan。Move 只改变 Root 内托管路径和 Source locator，不制造内容未变化的 Snapshot/Revision；Undo Plan 同时恢复文件和 SQLite。Delete 组合 Source 软删除影响，Restore 保留 Note、Source、Document、Revision 和 Chunk ID。
