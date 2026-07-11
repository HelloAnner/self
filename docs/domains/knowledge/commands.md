# Knowledge CLI Contract

```text
self knowledge build|status|failures|verify
self knowledge rebuild --layer parse|chunks|all
self knowledge explain <chunk-id>
self knowledge document list|show
self knowledge chunk list|show
self ingestion show|retry
self note create <title> --content <markdown>
self note update <note-id> --content <markdown> --if-version <n> [--title <title>]
self note list|show
```

`knowledge explain`/`chunk show` 返回 Document、Revision、Snapshot、Blob、行定位和 lineage。Phase 4 的 `fts/vectors` rebuild layer 当前返回 `knowledge_layer_unavailable`，不得静默执行空操作。
