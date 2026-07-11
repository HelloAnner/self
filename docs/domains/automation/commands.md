# Automation CLI contract baseline

> Status: Phase 3 implemented baseline

## Command source of truth

Each public command has a stable `CommandSpec` containing its ID, summary, Root requirement and execution class. `self commands --json` exposes the registry and `self schema command <id> --json` returns a closed Draft 2020-12 input schema with positional arguments, options, required fields, `x-self-root`, and `x-self-execution`. CLI actions call Application workflows and do not execute SQL or make domain decisions.

## Implemented commands

```text
self version [--json]
self commands [--json]
self schema command <id> [--json]
self completion <bash|fish|zsh>

self init <DIR> [--offline] [--plan] [--json]
self init resume <DIR> [--json]
self init rollback <DIR> --plan [--json]
self --root <DIR> apply <plan-id> [--json]
self --init [--root <DIR>] [--offline] [--resume] [--no-color]
self setup --interactive
self setup plan --spec <file> [--json]
self setup status|resume

self status [--verbose] [--json]
self system info [--json]
self doctor [--system|--workspace|--components|--all] [--json]
self component list|show|verify
self capability list|show
self config list|get|set|unset|validate
self diagnostics collect --redact
self diagnostics show|verify <id>
self migration plan

self source add <input> [--no-build]
self source list|show|status|files
self source sync [source-id] [--all] [--changed-only]
self source retry <source-id>
self source delete <source-id> --plan
self source restore <source-id>

self connection add|list|show|status|events|changes|watch|scan
self connection pause|resume|retry|rebind
self daemon run|start|status|stop|restart|logs
self knowledge build|rebuild|status|failures|verify|explain
self knowledge document list|show
self knowledge chunk list|show
self ingestion show|retry
self note create|update|list|show
```

Human output lists CLI, database schema, CLI protocol, and Page IR. JSON additionally returns config format. It is Root-free: it does not open SQLite, scan files, create a directory, read credentials, or access the network.

Success data:

```json
{
  "cli_version": "0.1.0",
  "config_format_version": 1,
  "database_schema_version": 4,
  "cli_protocol_version": 1,
  "page_ir_version": 1
}
```

## Output rules

- stdout contains only final human output, one JSON envelope, or JSONL events.
- stderr contains diagnostics/progress and never content needed to determine success.
- Only CLI main establishes the process exit status.
- `partial` uses exit 7 and includes failed items; it is not success.
- Public errors follow [the cross-domain contract](../../contracts/identity-events-errors.md).

## Phase 1 failure semantics

- Non-empty unknown targets require `init --plan`; Apply preserves unknown files.
- `self.toml` is published only after the database and runtime assets pass verification.
- Configuration mutation is atomic and blocked by older/newer database formats.
- Interactive Setup requires a TTY, rejects `--json`, and keeps hosted-model failure resumable without damaging the Workspace.
- Diagnostics require explicit redaction and store a hash-verifiable Root-local bundle.

Phase 1 persists Request/Operation identity for initialization and config changes. Full cross-command idempotency, generic Plan preconditions, Job and Undo remain Phase 9–10 work.

Phase 2 adds explicit database Migration Plan/Apply and Source evidence commands. Archive results expose Source and Snapshot IDs plus independent `archive_status` and `ingestion_status`. Batch Sync returns exit 7 with per-Source failures when only part of the request succeeds. Source Delete uses a versioned Plan; physical Purge remains deferred.

Phase 2.5 adds Schema 3 Connection and Daemon contracts. `source add --watch` composes Source, Connection, Initial Scan and optional Daemon startup; a bound `source sync` delegates to Connection reconciliation. Streaming events use JSONL, batch Scan uses exit 7 on partial failure, and Rebind requires Plan/Apply.

Phase 3 adds Schema 4 Ingestion/Knowledge/Note contracts. Default Source Add/Sync waits for Ingestion ready; `--no-build` remains the explicit archive-only path. Build partial failure uses exit 7, Note update requires `--if-version`, and unavailable future rebuild layers fail explicitly.
