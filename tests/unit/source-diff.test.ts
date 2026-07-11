import { describe, expect, test } from "bun:test";
import { compareSnapshotEntries } from "../../src/domains/source/index.ts";

describe("Source Snapshot Diff", () => {
  test("reports deterministic added, modified, and deleted evidence", () => {
    expect(
      compareSnapshotEntries(
        [
          { logical_path: "deleted.md", blob_sha256: "old-deleted" },
          { logical_path: "modified.md", blob_sha256: "old-modified" },
          { logical_path: "same.md", blob_sha256: "same" },
        ],
        [
          { logical_path: "added.md", blob_sha256: "new-added" },
          { logical_path: "modified.md", blob_sha256: "new-modified" },
          { logical_path: "same.md", blob_sha256: "same" },
        ],
      ),
    ).toEqual([
      {
        logical_path: "added.md",
        change_kind: "added",
        previous_blob_sha256: null,
        blob_sha256: "new-added",
      },
      {
        logical_path: "deleted.md",
        change_kind: "deleted",
        previous_blob_sha256: "old-deleted",
        blob_sha256: null,
      },
      {
        logical_path: "modified.md",
        change_kind: "modified",
        previous_blob_sha256: "old-modified",
        blob_sha256: "new-modified",
      },
    ]);
  });
});
