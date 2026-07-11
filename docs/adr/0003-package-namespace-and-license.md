# ADR 0003: npm namespace and open-source license

- Status: accepted
- Date: 2026-07-11
- Owners: Maintainers

## Context

The unscoped npm name `self` is occupied. Public release also requires an explicit OSI-approved license chosen by the copyright holder; source visibility alone does not grant open-source rights.

## Decision

Use the MIT License, selected by the Maintainer on 2026-07-11. Use `@helloanner/self` as the candidate npm namespace, with exact-version packages such as `@helloanner/self-darwin-arm64`. Package skeletons remain `private: true` until the separate public Preview release gate confirms control of the `helloanner` npm scope and the complete supply-chain checklist.

Every source distribution, npm package, and standalone release includes the root MIT `LICENSE`. Third-party notices remain separate and do not inherit the project license.

## Consequences

- Self is open source under the short, permissive MIT terms.
- Package metadata and staged artifacts identify MIT consistently.
- Third-party notices, SBOM, namespace ownership, and publication workflows remain release-gated.
- Namespace changes must update all packages and distribution documents atomically before the first publication.

## Verification

The local clean-machine spike packs the private meta and current platform packages, installs them without lifecycle scripts, removes Bun from the launched process path, and verifies `self version --json` through the Node launcher.

## Revisit when

The project License is a deliberate legal compatibility decision and must not change incidentally. npm namespace ownership is verified separately before public Preview publication.
