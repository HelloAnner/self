# ADR 0002: Distribute compatible SQLite and sqlite-vec as platform sidecars

- Status: accepted
- Date: 2026-07-11
- Owners: Maintainers

## Context

Self requires SQLite, FTS5, and sqlite-vec in one database. Bun 1.3.14 on macOS uses Apple SQLite by default, and that build rejects dynamic extension loading. Assuming a globally installed SQLite or extension would break clean-machine installation and single-root portability.

## Decision

Every platform release package carries a tested compatible SQLite library and sqlite-vec `0.1.9` extension. Before creating any `bun:sqlite` `Database`, infrastructure selects the release/instance sidecar and calls `Database.setCustomSQLite`. `self init` will copy the current platform assets into `runtime/extensions/` and record versions and checksums; cross-platform moves retain business data and use `doctor` to add the new platform assets.

This is a sidecar strategy, not static linking. Ordinary tables use Drizzle; FTS5, vec0, PRAGMA, triggers, and capability probes use named parameterized SQL modules. Production release assets must come from the reproducible platform build, not from an undeclared Homebrew dependency.

## Consequences

- The same SQLite file owns structured data, FTS, vectors, graph, and runtime state.
- Package size and platform verification increase.
- Database construction must be centralized because custom SQLite is process-global and must be selected first.
- A sqlite-vec upgrade requires insert, delete, KNN, WAL, backup, restore, and migration verification.

## Verification

On macOS arm64 the unmodified Bun SQLite failed with `This build of sqlite3 does not support dynamic extension loading`. Selecting SQLite 3.51.3 then loaded sqlite-vec v0.1.9, matched FTS text, inserted three vectors, and returned `chunk-a` then `chunk-c` for the KNN query. The executable probe is `bun run spike:sqlite`.

## Revisit when

Reconsider static linking only if Bun provides a supported reproducible embedding mechanism that passes the full platform, backup, and clean-machine matrix.
