# SQLite, FTS5, and sqlite-vec Phase 0 spike

> Executed: 2026-07-11 on macOS arm64, Bun 1.3.14

## Question

Can Self use one file-backed SQLite database for ordinary state, FTS5, and sqlite-vec, and can the same native assets be distributed with a standalone CLI?

## Executable probe

`bun run spike:sqlite` creates `data/test-runs/sqlite-spike.sqlite3`, configures the production PRAGMA baseline, creates FTS5 and vec0 virtual tables, inserts text and three 3-dimensional vectors, then performs a full-text match and a two-neighbor KNN query. `tests/integration/sqlite-capabilities.test.ts` repeats the probe against a fresh real file.

## Result

| Capability | Result |
| --- | --- |
| Bun default Apple SQLite dynamic extension | failed as predicted: extension loading disabled |
| Custom compatible SQLite | passed with SQLite 3.51.3 |
| Drizzle on the same connection | passed for ordinary table create/insert/query |
| FTS5 create/insert/match | passed; `doc-a` matched `evidence` |
| sqlite-vec load/version | passed; v0.1.9 |
| vec0 insert/update/delete/KNN | passed; `chunk-a` distance 0, then updated `chunk-c` |
| File database + WAL | passed locally |

## Decision and limits

[ADR 0002](../../adr/0002-sqlite-extension-distribution.md) selects per-platform SQLite/sqlite-vec sidecars. This local macOS spike used the compatible Homebrew SQLite only as test input; release packages must build, checksum, license, and test their own reproducible library. Cross-platform load, vec deletion/update, Online Backup, restore, crash/WAL recovery, and compiled-binary asset relocation remain release-matrix work and cannot be inferred from this one host.
