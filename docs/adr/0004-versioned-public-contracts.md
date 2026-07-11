# ADR 0004: Version public contracts independently

- Status: accepted
- Date: 2026-07-11
- Owners: Maintainers

## Context

CLI installation, instance configuration, SQLite schema, Agent protocol, and rendered artifacts evolve on different timelines. A single package version cannot safely express all compatibility decisions.

## Decision

Track these independent versions from the first executable:

| Contract | Phase 0 value | Compatibility owner |
| --- | ---: | --- |
| CLI SemVer | `0.1.0` | Distribution/Automation |
| Config format | `1` | Workspace |
| Database schema | `1` | Operations and owning domains |
| CLI protocol | `1` | Automation |
| Page IR | `1` | Artifact |

`self version --json` returns all five values in the stable JSON envelope without opening a Workspace, creating files, or accessing the network. Parser, chunker, prompt, vector-space fingerprint, and template versions are separate domain algorithm versions when those capabilities appear.

## Consequences

Compatibility checks are explicit. A newer database is read-only diagnostic input to an older CLI; vector-space changes never masquerade as schema migrations; old Page IR remains renderable through a compatible renderer.

## Verification

Human and JSON contract tests execute the source CLI and the compiled standalone binary. The JSON output is also exercised through the npm meta-package launcher.

## Revisit when

Never collapse these versions. Add another independently versioned contract only with an ADR and migration/compatibility tests.
