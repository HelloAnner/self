# Source 工作流

> 状态：Phase 2 implemented

## Add / Archive

1. 校验输入、kind、mode、过滤规则和外部路径授权。
2. 生成稳定 Source ID 与规范 identity key；重复请求复用原 Source。
3. 注册 Source 并进入 `archiving`。
4. 枚举确定性排序条目；跳过符号链接和默认忽略目录。
5. 流式计算 SHA-256，将新 Blob 原子写入 Root，验证已存在 Blob。
6. 比较当前 Snapshot，生成 added/modified/deleted Diff。
7. 无变化时复用当前 Snapshot；有变化时先写不可变 Manifest，再用一个 SQLite 事务发布 Snapshot 和 current 指针。
8. `--no-build` 返回 `ingestion_status=not_started`；默认把 Snapshot 交给 Ingestion，达到 `ready` 后返回完整结果。

Phase 3 起公开 Add 默认完成 Source→Ingestion→Knowledge；`--no-build` 保留为显式归档入口。Ingestion 失败不回滚已经发布的 Snapshot，也不把 Source 归档状态改成 failed。

## Sync / Retry

Sync 重新读取 SourceSpec。目录仍可访问时，缺少的文件会作为 deleted 进入新 Snapshot；整个外部 Target 不可访问时保留旧 Snapshot并进入 failed。Retry 只允许 failed Source，再执行相同归档流程。

Web Source 仅获取单页，不跟随链接；保存响应原始字节、最终 URL、获取时间和 MIME。已有网页 Snapshot 在断网后仍可通过 Blob 相对路径离线读取。

## Import

Import 先把输入复制到 `content/sources/imports/<source-id>/`，不删除外部文件。后续 SourceSpec 指向该 Root 内托管副本。未知目标文件不覆盖；同 Hash 文件复用。

## Delete / Restore

Delete 必须先生成 `source.delete` Plan，记录 Source version 和当前 Snapshot。Apply 在前置条件未变化时软删除。Restore 创建一次审计 Operation 并恢复 active；Blob 和 Snapshot 始终保留。

## Connection 接纳

Phase 2 暴露可选 `change_batch_id` 的归档应用服务。`source_batch_receipts` 保证同一 ChangeBatch 重试返回同一 Snapshot。ChangeBatch 的扫描、Cursor 和变化分类仍由 Phase 2.5 Connection 所有。
