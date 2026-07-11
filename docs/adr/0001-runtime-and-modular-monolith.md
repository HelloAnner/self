# ADR 0001: TypeScript, Bun, and a modular monolith

- Status: accepted
- Date: 2026-07-11
- Owners: Maintainers

## Context

Self needs a fast Agent-first CLI, direct filesystem and SQLite access, typed contracts shared with future rendering, and standalone binaries. Its single-root and single-database guarantees are weakened by early service decomposition.

## Decision

Use TypeScript 7.0.2 and Bun 1.3.14. Build one modular-monolith CLI binary with explicit Domain, Application, Infrastructure, CLI, Renderer, and Shared boundaries. A future Connection daemon is another mode of the same binary and application services, not a separate business service.

Dependencies are exact and committed in `bun.lock`. Domain code cannot import Bun, Commander, Drizzle, AI SDK, or renderer types. External databases, queues, web servers, and global dependency injection containers require a later ADR backed by measurements.

## Consequences

- CLI, schemas, model adapters, and Page IR use one type system.
- Runtime-specific capabilities remain behind ports or entry points.
- The file-size and dependency-direction gates are part of `bun run check`.
- Cross-process work must still use SQLite state, short transactions, leases, and stable operations.

## Verification

`bun run typecheck`, `bun run lint`, `bun run check:size`, `bun test`, and `bun run build` execute in the Phase 0 gate.

## Revisit when

Only measured isolation, extension, deployment, or performance limits may justify another service or database.
