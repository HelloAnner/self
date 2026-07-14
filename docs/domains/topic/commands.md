# Topic CLI 契约

## 1. Topic 命令

~~~bash
self topic create NAME --scope TEXT --exclude TEXT --alias ALIAS --json
self topic list --status active --limit 100 --json
self topic show topic:top_123 --json
self topic update topic:top_123 --scope TEXT --exclude TEXT --add-alias ALIAS --if-version 1 --json
self topic build topic:top_123 --mode text --limit 50 --tokens 24000 --wait --json
self topic refresh topic:top_123 --since-last-build --explain-changes --json
self topic report topic:top_123 --snapshot topic-snapshot:tsp_123 --json
self topic history topic:top_123 --json
self topic diff topic:top_123 --from build:bld_123 --to latest --json
self topic open topic:top_123 --json
self topic export topic:top_123 --format html --single-file --output report.html --json
self topic delete topic:top_123 --plan --idempotency-key key --json
self topic restore topic:top_123 --if-version 2 --json
self trace section:sec_123 --json
~~~

Phase 10 起 build/refresh 的 `--wait` 等待 durable Job 完成，`--detach` 或默认 detached 模式返回 Job ID；checkpoint、attempt 和进度保存在 Schema 11。只读 show/list/report/history/trace 禁止隐式触发模型、扫描、Build 或 Refresh。

## 2. 输出重点

topic show 返回 Topic version/status/stale_reason 和 latest Snapshot 摘要。

topic build 返回 TopicSnapshot、SynthesisRun、RetrievalRun、EvidenceContext，以及结构化 report 和 knowledge_snapshot。ReportSection 含 confidence_json、coverage_json、health_status、change_kind、Conclusion 和 Citation。

topic history 按时间倒序返回不可变 Artifact Build、父 Build、TopicSnapshot、模板/主题、Hash、耗时和警告。TopicSnapshot 历史仍由 topic report --snapshot 读取。

## 3. 错误语义

| 错误码 | 类别 | 含义 |
| --- | --- | --- |
| topic_not_found | not_found | Topic ID 不存在 |
| topic_name_conflict | conflict | 规范化名称与活动 Topic 冲突 |
| topic_scope_invalid | usage | Scope 为空或非法 |
| topic_version_conflict | conflict | if-version 或构建期间版本不再匹配 |
| topic_not_built | state | 还没有可读 Snapshot |
| topic_snapshot_not_found | not_found | Snapshot 不属于该 Topic 或不存在 |
| topic_candidate_limit_invalid | usage | limit 不在 5..100 |
| topic_context_budget_invalid | usage | tokens 不在 1024..64000 |
| section_not_found | not_found | Section ID 不存在 |
| workspace_migration_required | state | Root 不是当前 Schema 11 |

JSON 使用全局 Envelope 和退出码映射。凭证、模型原始响应和私有正文不得进入错误 details。

## 4. Artifact 映射

topic build/refresh 同时创建 Artifact Build；history/diff/open/export 是 Topic 对 Artifact 命令的稳定快捷映射。纯模板/主题重渲染使用 artifact render，禁止借此触发 Topic 综合。

topic delete 只生成通用 Plan；其影响包含绑定 Artifact，但不删除 TopicSnapshot、ReportSection、Citation 或 Build。Apply 原子软删除 Topic 与非 deleted Artifact。topic restore 按原 OperationChange 恢复两者的精确状态和稳定 ID，并分别递增 version。
