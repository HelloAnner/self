# Artifact CLI 契约

## Topic 快捷命令

```bash
self topic build TOPIC --template knowledge-atlas --json
self topic refresh TOPIC --since-last-build --explain-changes --json
self topic history TOPIC --json
self topic diff TOPIC --from BUILD --to latest --json
self topic open TOPIC --json
self topic export TOPIC --format html|markdown|json --output PATH --json
self topic export TOPIC --format html --single-file --output report.html --json
```

`topic build` 创建 TopicSnapshot 和 `full` Artifact Build。`topic refresh` 在输入未失效时是零检索幂等读；输入变化时创建 TopicSnapshot 和 `refresh` Build。

## Artifact 和 Template

```bash
self artifact list --status ready --json
self artifact show ARTIFACT --json
self artifact open ARTIFACT --json
self artifact history ARTIFACT --json
self artifact diff FROM_BUILD TO_BUILD --json
self artifact render TOPIC --template knowledge-atlas --theme self-light --json
self artifact export ARTIFACT --format html|markdown|json --output PATH --json
self artifact delete ARTIFACT --plan [--idempotency-key key] --json
self artifact restore ARTIFACT [--if-version 2] --json
self template list --json
```

`artifact render` 只重新渲染已有知识。`artifact delete` 仅生成通用 Plan；Apply 软删除 Artifact 但保留全部 Build、Page IR、Manifest 和离线文件。Restore 恢复相同 Artifact ID 和删除前状态；也可对可逆删除 Operation 生成 Undo Plan。

## 关键输出

Build 命令返回 artifact/build/parent/snapshot ID、kind/state、Root 内相对目录、index path、Page IR/Manifest Hash、组件总数、复用/重建数量、Citation 数和 render_ms。JSON 仍使用全局单 Envelope。

## 错误语义

| 错误码 | 类别 | 含义 |
| --- | --- | --- |
| `artifact_not_found` | not_found | Artifact 或 Topic Artifact 不存在 |
| `artifact_build_not_found` | not_found | Build ID 不存在 |
| `artifact_not_built` | state | Artifact 尚无 ready Build |
| `artifact_not_ready` | state | 目标 Build 未 ready |
| `artifact_template_missing` | state | Root 和 Release 都缺少模板资源 |
| `artifact_template_invalid` | state | Template metadata 不是合法 JSON |
| `artifact_template_incompatible` | state | Template 与 Page IR 版本不兼容 |
| `artifact_citation_invalid` | state | Citation excerpt 与 Chunk Hash 不一致 |
| `artifact_file_missing` | state | 归档 Page IR/HTML 缺失 |
| `artifact_path_invalid` | state/internal | 内部路径逃逸 Root/artifacts |
| `artifact_export_format_invalid` | usage | format 不是 html/markdown/json |
| `artifact_export_option_invalid` | usage | 非 HTML 使用 single-file |
| `artifact_export_exists` | conflict | 输出目标已存在，拒绝覆盖 |
| `artifact_diff_scope_mismatch` | conflict | 两个 Build 不属于同一 Artifact |
| `workspace_migration_required` | state | Root 不是当前 Schema 11 |
