# Ingestion CLI Contract

Phase 3 通过 `knowledge build/rebuild` 启动 Ingestion，通过 `ingestion show/retry` 检查单次 Run：

```text
self knowledge build [--source <id>|--snapshot <id>|--all] [--json]
self knowledge rebuild --layer parse|chunks|all [--source <id>|--all] [--json]
self knowledge status [--source <id>] [--json]
self knowledge failures [--source <id>] [--json]
self ingestion show <ingestion-id> [--json]
self ingestion retry <ingestion-id> [--json]
```

默认 `source add` 与 `source sync` 完成 Ingestion；`--no-build` 明确停在 `not_started`。批量 Build 部分失败使用退出码 7。稳定错误包括 `ingestion_parse_failed`、`ingestion_failed`、`ingestion_not_found`、`ingestion_retry_invalid`、`ingestion_config_invalid` 和 `knowledge_build_partial`。
