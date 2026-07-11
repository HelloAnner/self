# Source 领域模型

> 状态：Phase 2 归档与 Phase 3 摄入投影已实现

## 聚合

`Source` 是外部信息的逻辑身份和归档边界。它保存稳定 `source_id`、来源种类、模式、规范化 SourceSpec、当前已发布 Snapshot、版本和生命周期状态。外部位置可以变化或消失，但不能成为唯一证据。

Source 状态为：

- `active`：可以查询，且当前 Snapshot（如果存在）已完整发布。
- `failed`：最近一次归档失败；旧 Snapshot 仍是有效证据，可 Retry。
- `deleted`：软删除，不删除 Blob、Snapshot 或 Manifest，可以 Restore。

归档阶段单独使用 `registered`、`archiving`、`published` 和 `failed`，避免用含糊的全局 `ready` 代替后续 Ingestion 状态。

## Blob 与 Snapshot

`Blob` 以小写 SHA-256 作为内容身份，保存原始字节、大小、MIME 和 Root 相对路径。同一字节内容只保存一次，可以被任意 Snapshot 复用。

`Snapshot` 是 Source 在某次归档时发布的不可变条目集合。每个条目保存来源内逻辑路径、Blob Hash、MIME、大小及原始 URI（适用时）。Snapshot Manifest 位于 Root 内并记录前一版本以及 added/modified/deleted Diff。

## SourceSpec

SourceSpec 包含 `kind`、`mode`、明确授权的 locator、递归策略及 include/exclude Glob。种类包括 `file`、`markdown`、`directory`、`obsidian`、`web`、`text` 和 `jsonl`；模式包括：

- `snapshot`：归档当前内容，显式 Sync 可再次读取原位置。
- `mirror`：Source 接纳显式 Sync；Phase 2.5 由 Connection 提供持续扫描。
- `import`：首次归档时复制到 `content/sources/imports/<source-id>/`，随后从 Root 内托管副本 Sync。

## 不变量

1. Snapshot 发布事务只能引用已完成原子写入且 Hash 验证通过的 Blob/Manifest。
2. 已发布 Snapshot、Blob 和 Manifest 不原地修改。
3. 未变化条目复用 Blob；整个集合未变化时复用当前 Snapshot。
4. 外部文件或目录不可用时保留旧 Snapshot，并把 Source 标为 failed，不伪造批量删除。
5. 删除 Source 只改变生命周期状态；Phase 2 不实现物理 Purge。
6. Source 归档成功本身不代表下游完成；`ingestion_status` 与 `current_ingestion_run_id` 必须独立投影真实 Ingestion/Knowledge 状态，Vector 与 Graph 仍不得由 Source 状态推断。
