import { describe, expect, test } from "bun:test";
import { classifyChanges } from "../../src/domains/connection/index.ts";
import type { InventoryEntry, Observation } from "../../src/domains/connection/model/types.ts";

const time = "2026-07-11T00:00:01.000Z";

describe("Connection change classification", () => {
  test("distinguishes modification, rename, and creation", () => {
    const previous = [observation("a.md", "inode-a", "old"), observation("b.md", "inode-b", "b")];
    const current = [
      inventory("a.md", "inode-a", "new"),
      inventory("moved.md", "inode-b", "b"),
      inventory("new.md", "inode-c", "c"),
    ];
    const result = classifyChanges(previous, current, time, 30_000);
    expect(
      result.changes.map((item) => [item.kind, item.relative_path, item.previous_path]),
    ).toEqual([
      ["modified", "a.md", null],
      ["renamed", "moved.md", "b.md"],
      ["created", "new.md", null],
    ]);
  });

  test("requires delete grace and recognizes restoration", () => {
    const active = observation("gone.md", "inode", "hash");
    const pending = {
      ...active,
      state: "missing_pending" as const,
      missing_since: "2026-07-11T00:00:00.000Z",
    };
    expect(classifyChanges([active], [], time, 30_000).changes).toHaveLength(0);
    expect(classifyChanges([pending], [], time, 500).changes[0]?.kind).toBe("deleted");
    const deleted = { ...active, state: "deleted" as const };
    expect(
      classifyChanges([deleted], [inventory("gone.md", "new-inode", "hash")], time, 500).changes[0]
        ?.kind,
    ).toBe("restored");
  });
});

function observation(path: string, identity: string, hash: string): Observation {
  return {
    observation_id: `observation:obs_${path}`,
    connection_id: "connection:con_test",
    target_id: "target:ct_test",
    relative_path: path,
    normalized_path_key: path,
    file_identity: identity,
    size_bytes: 1,
    mtime_ns: "1",
    quick_fingerprint: hash,
    content_hash: hash,
    snapshot_id: null,
    state: "active",
    missing_since: null,
    version: 1,
  };
}

function inventory(path: string, identity: string, hash: string): InventoryEntry {
  return {
    relative_path: path,
    normalized_path_key: path,
    file_identity: identity,
    size_bytes: 1,
    mtime_ns: "2",
    quick_fingerprint: hash,
    content_hash: hash,
  };
}
