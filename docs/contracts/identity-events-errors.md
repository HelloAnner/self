# Cross-domain identity, event, and error contract

> Status: Phase 0 baseline

## Stable identities

Public resource IDs use `<resource>:<prefix>_<uuid-v7>`. IDs are immutable across moves, renames, rebinds, restores, and merges; a merge records a redirect. Database rows, events, logs, CLI output, and manifests use the complete public ID.

The executable registry is `src/shared/ids/registry.ts`. It covers Workspace/Setup/Diagnostics, Connection observations and batches, Source evidence, Knowledge revisions and chunks, graph resources, Topics/Artifacts, Models/Jobs, events, and safe operations. Request IDs use `req_<uuid-v7>` and are correlation identifiers rather than resource IDs.

## Event envelope

Domain events are immutable facts emitted after their owning transaction commits:

```json
{
  "event_id": "event:evt_<uuid-v7>",
  "event_type": "source.snapshot_created.v1",
  "occurred_at": "2026-07-11T00:00:00.000Z",
  "aggregate_id": "source:src_<uuid-v7>",
  "aggregate_version": 3,
  "request_id": "req_<uuid-v7>",
  "operation_id": "operation:op_<uuid-v7>",
  "payload_version": 1,
  "payload": {}
}
```

Rules:

- `event_type` is `<domain>.<fact>.v<integer>` and is never repurposed.
- Payloads contain stable upstream IDs and Root-relative business paths.
- Times are UTC RFC 3339; content identity is SHA-256 lowercase hexadecimal.
- Consumers are idempotent by `event_id`; events do not grant permission to write another domain's tables.
- Breaking payload changes introduce a new event version.

## CLI envelope

`--json` writes exactly one object to stdout. Success and failure retain `ok`, `data`, `meta`, and `error`. `meta` always includes `request_id`, nullable `operation_id` and `root`, `warnings`, and `next_actions`. A public error has stable `code`, `message`, `category`, `retryable`, optional redacted `details`, and suggested actions; internal causes never enter stdout.

## Error and exit-code registry

| Exit | Category | Meaning |
| ---: | --- | --- |
| 0 | success | Complete success |
| 2 | usage | Invalid arguments or input schema |
| 3 | not_found | Stable target does not exist |
| 4 | conflict | Version, idempotency, or concurrent state conflict |
| 5 | state | Object state disallows the operation |
| 6 | external | Provider, network, filesystem source, or platform capability failure |
| 7 | partial | Incomplete batch result; never treated as success |
| 8 | locked | Workspace or resource is busy |
| 10 | plan_required | Valid Plan or explicit approval is required |
| 20 | internal | Self invariant or unexpected implementation failure |

Domain error codes use lower snake case and remain stable after publication. Messages may improve without changing program behavior. New codes must be added to the owning domain commands document and contract tests.
