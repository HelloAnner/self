# Architecture Decision Records

ADR records choices that change Self's long-lived architecture, data compatibility, distribution, or security posture. The status of an ADR is one of `proposed`, `accepted`, `superseded`, or `rejected`.

## Index

| ADR | Status | Decision |
| --- | --- | --- |
| [0001](./0001-runtime-and-modular-monolith.md) | accepted | TypeScript 7, Bun 1.3.14, modular monolith |
| [0002](./0002-sqlite-extension-distribution.md) | accepted | Platform SQLite and sqlite-vec sidecars |
| [0003](./0003-package-namespace-and-license.md) | accepted | MIT License and `@helloanner/self` candidate namespace |
| [0004](./0004-versioned-public-contracts.md) | accepted | Independent CLI, config, database, protocol, and Page IR versions |

New records copy [template.md](./template.md), use the next four-digit number, and link superseded decisions in both directions.
