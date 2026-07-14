# Automation CLI contract baseline

> Status: Phase 10 implemented through Schema 11 / CLI v1.0.0 RC

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

self plan list|show|diff|cancel
self operation list|show
self operation undo <operation-id> --plan
self history list [--resource <id>]
self history show|diff <operation-id>

self job list|show|logs|watch|cancel|retry
self backup create|list|show|verify
self backup restore <backup-id> --to <new-root> --plan
self verify [--deep] [--wait|--detach]
self gc --plan [--older-than <duration>]
self maintenance status|checkpoint

self source add <input> [--no-build]
self source list|show|status|files
self source sync [source-id] [--all] [--changed-only]
self source retry <source-id>
self source delete|purge <source-id> --plan [--idempotency-key <key>]
self source restore <source-id> [--if-version <n>] [--idempotency-key <key>]

self connection add|list|show|status|events|changes|watch|scan
self connection pause|resume|retry|rebind|detach|restore
self daemon run|start|status|stop|restart|logs
self knowledge build|rebuild|status|failures|verify|explain
self knowledge document list|show
self knowledge chunk list|show
self ingestion show|retry
self note create|update|move|delete|restore|list|show
self entity|relation|claim delete <id> --plan
self entity|relation|claim restore <id>
self topic|artifact delete <id> --plan
self topic|artifact restore <id>
```

Human output lists CLI, database schema, CLI protocol, and Page IR. JSON additionally returns config format. It is Root-free: it does not open SQLite, scan files, create a directory, read credentials, or access the network.

Success data:

```json
{
  "cli_version": "1.0.0",
  "config_format_version": 1,
  "database_schema_version": 11,
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

Phase 1 persists Request/Operation identity for initialization and config changes. Phase 9 extends this into generic immutable Plan, per-resource OperationChange, AuditEvent and IdempotencyRecord. Phase 10 adds durable Job/Event state, cancellation, retry, checkpoint, worker lease and wait/detach execution without changing the JSON envelope.

Phase 2 adds explicit database Migration Plan/Apply and Source evidence commands. Archive results expose Source and Snapshot IDs plus independent `archive_status` and `ingestion_status`. Batch Sync returns exit 7 with per-Source failures when only part of the request succeeds. Source Delete uses a versioned Plan; physical Purge remains deferred.

Phase 2.5 adds Schema 3 Connection and Daemon contracts. `source add --watch` composes Source, Connection, Initial Scan and optional Daemon startup; a bound `source sync` delegates to Connection reconciliation. Streaming events use JSONL, batch Scan uses exit 7 on partial failure, and Rebind requires Plan/Apply.

Phase 3 adds Schema 4 Ingestion/Knowledge/Note contracts. Default Source Add/Sync waits for Ingestion ready; `--no-build` remains the explicit archive-only path. Build partial failure uses exit 7, Note update requires `--if-version`, and unavailable future rebuild layers fail explicitly.

Phase 4 adds Schema 5 `model`, `vector-space` and `search` contracts. VectorSpace create/activate/migrate/delete require versioned Plan/Apply; build/verify are checkpointed maintenance actions. Search text mode never calls a model, vector mode requires one compatible active ready space, and hybrid returns FTS evidence plus `vector_degraded` when the Provider/circuit/coverage is unavailable. Large Connection scans split into bounded ChangeBatches and cap inline change details.

Phase 5 adds Schema 6 `graph`, `entity`, `relation`, `claim` and `conflict` contracts. Generation activation, Entity create/merge and Relation create return versioned Plan and are applied by the same `self apply` protocol. Since Phase 10, Graph build/rebuild `--detach` creates a durable Job and `--wait` follows it to a terminal state.

Phase 6 adds Schema 7 `ask`, `related` and `trace` contracts. `ask` is classified as `write` because it persists RetrievalRun, EvidenceContext, Invocation and Answer audit records; `related` and `trace` are indexed read operations. Model/Citation failure uses the standard single JSON failure envelope and never mixes progress logs into stdout.

Phase 9 adds Schema 10 safe mutation commands. High-impact delete, detach, move, purge and Undo only create a 15-minute Plan; `self apply` re-checks the exact before image and returns conflict on drift. Repeated Apply or a repeated matching idempotency key returns the original result without another effect; reusing the key for different normalized input returns `idempotency_conflict`. Restore creates a new monotonic version and an `undo_of_operation_id` audit link. Irreversible purge cannot produce an Undo Plan.

Phase 10 adds Schema 11 operational commands. `backup create` and `verify --deep` are durable Jobs; `backup restore` only creates a Plan for an absent destination and Apply verifies hashes plus the restored Workspace before atomic publication. `gc --plan` persists exact candidates and reference proof. Job logs are immutable and redacted; cancellation is cooperative at checkpoints, while a killed worker is recovered through dead-PID or expired-lease detection. Read commands never resume work implicitly.
