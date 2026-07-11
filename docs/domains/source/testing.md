# Source 测试矩阵

> 状态：Phase 2 归档 gate 与 Phase 3 默认摄入回归通过

全部测试使用 `data/test-runs/phase-2-real-cli/` 内的隔离 Root 和合成输入，不读取用户真实 Vault。

## 必测场景

- 单文件、目录、Markdown、Obsidian、stdin text/jsonl 和本地 HTTP 单页。
- Frontmatter、Wiki Link、附件、中文、代码块、空文件和忽略目录按原始字节归档。
- include/exclude、默认 `.git`/`node_modules` 忽略、递归关闭和符号链接跳过。
- 同一文件重复 Add/Sync 不新增 Blob 或 Snapshot。
- 修改一个文件只新增一个 Blob 和 Snapshot；未变化条目继续引用旧 Blob。
- 目录内删除文件产生 deleted Diff，旧 Snapshot 与 Blob 仍可读取。
- 整个 Target 消失时 Source failed，current Snapshot 不变化；恢复后 Retry 成功。
- Web Server 停止后内部 HTML Blob 仍可读取。
- Import 后删除外部副本不影响 Root 内托管 Source。
- Delete Plan、Plan 冲突、Apply 和 Restore 不删除证据。
- Snapshot Manifest/SQLite 引用/Blob Hash 一致；所有业务写入位于测试 Root。
- Schema 1 → 2 使用显式 Plan/Apply 并保留 Root 内迁移备份。

性能记录至少包含小型目录首次归档和无变化 Sync；Phase 2 不以提高阈值隐藏文件 Hash 或 SQLite 回归。
