# Workspace model

> Status: Phase 1 implemented baseline

## Aggregate

`Workspace` is the identity and path boundary of one portable Self root. Its aggregate fields are `workspace_id`, `root_identity`, `format_version`, `database_schema_version`, `state`, `created_at`, and `version`.

States are:

- `initializing`: an Init Journal exists but `self.toml` is not published.
- `active`: config, database, required directories, and manifests passed verification.
- `read_only`: a newer format/schema or a diagnostic condition forbids writes.
- `needs_migration`: an older compatible instance requires an explicit migration plan.
- `damaged`: integrity checks failed; diagnosis and backup remain available.
- `deleted`: reserved for a future approved Workspace removal workflow.

`status.mode` describes whether the Workspace may accept writes, not whether the status query itself used a read-only SQLite connection. An `active` compatible Workspace reports `read_write`; schema diagnostics and non-writable lifecycle states report `read_only`.

## Value objects

- `WorkspaceRoot`: canonical absolute runtime locator; never stored as business identity.
- `WorkspaceRelativePath`: normalized `/`-separated path with no absolute prefix, `..`, device, or symlink escape.
- `ExternalInputPath`: explicitly authorized read-only path outside Root.
- `ExportPath`: explicit command target that may be outside Root.
- `RootIdentity`: filesystem identity recorded by Init Journal to detect target substitution.
- `Capability`: detected binary/platform/runtime ability with `available`, `degraded`, `unavailable`, or `unconfigured` state.

## Invariants

1. `self.toml` is the final initialization marker and is never published before core verification.
2. All business files except explicit external inputs/exports live below the canonical Root.
3. Stored business paths are Root-relative; copying the complete directory does not change `workspace_id`.
4. Unknown files in a non-empty target are never overwritten or deleted.
5. A CLI that cannot understand the config or database schema cannot start a write transaction.
6. Platform extensions are replaceable runtime assets; they do not change Workspace or knowledge identity.

## Phase 1 implementation

Phase 1 implements Init Journal, Resume/Rollback Plan, upward Root discovery, strict configuration loading, immutable configuration snapshots, capability discovery, migration handshake, diagnostics, and read-only behavior for newer schemas. The implementation persists paths relative to Root and keeps transient runtime assets below `runtime/`.

`models` remains `unconfigured` in Offline mode. A reported `vector-search` capability means the bundled SQLite runtime can load and query sqlite-vec; it does not imply that a VectorSpace or embedding model already exists. Those business objects begin in Phase 4.
