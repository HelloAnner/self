# Workspace SQLite schema baseline

> Status: Phase 1 migration `0001_workspace` implemented

SQLite is the only structured database at `data/self.sqlite3`. Database schema version `1` is created only by an approved initialization workflow.

## Implemented tables

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `workspace` | One Workspace identity and state | exactly one active logical row; public ID unique |
| `workspace_config_versions` | Immutable accepted config snapshots | `(workspace_id, version)` unique; SHA-256 content hash |
| `workspace_capabilities` | Last verified platform/component capabilities | `(workspace_id, capability)` unique |
| `setup_sessions` | Resumable guided setup state | state/checkpoint/version; no plaintext secrets |
| `operations` | Minimal durable initialization/config operation record | public operation ID; optional idempotency key unique |
| `schema_migrations` | Reviewed migration history | version and migration name unique; SQL checksum retained |

Operations owns migration history and diagnostics; Automation owns operations, plans, jobs, and audit. Workspace must not write their tables directly.

## Connection baseline

Every production connection enables foreign keys, WAL, `busy_timeout`, and controlled checkpoint behavior. A compatible SQLite library is selected before the first `Database` object and sqlite-vec is verified before migrations that require it. Runtime never executes `drizzle-kit push`.

## Version behavior

- Empty/new database: the runtime migrator applies reviewed SQL in order.
- Schema lower than supported: return a migration plan; do not hide migration inside an ordinary command.
- Schema higher than supported: open read-only for version/status/doctor/backup where safe.
- Interrupted migration: retain journal/checkpoint evidence and prove either rollback or safe resume.

Migration `drizzle/0001_workspace.sql` creates STRICT tables, indexes, and `PRAGMA user_version = 1`. Runtime migration verifies the checked-in SQL checksum before accepting an already applied migration. Init first migrates and verifies a temporary database below `runtime/tmp/`, checkpoints it, and only then renames it to `data/self.sqlite3`.

The current database format is version 2 after `0002_source.sql`. New Workspace initialization applies both reviewed migrations; an existing version 1 Workspace uses explicit Migration Plan/Apply rather than an ordinary command side effect.

Phase 1 tests cover empty initialization, idempotent repetition, injected interruption and Resume, Rollback Plan safety, lower/newer schema behavior, Root relocation, and SQLite integrity checks. Durable per-step setup rows are deferred until setup requires independently resumable Phase 2–4 work; Phase 1 persists the session aggregate in `setup_sessions` and a Root-local session journal.
