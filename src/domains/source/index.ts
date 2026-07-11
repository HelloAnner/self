export { type SourceAddInput, sourceAddInputSchema } from "./model/spec.ts";
export type {
  ArchivedEntry,
  InputEntry,
  SnapshotChange,
  SourceKind,
  SourceMode,
  SourceRow,
  SourceSpec,
} from "./model/types.ts";
export {
  compareSnapshotEntries,
  type EvidenceEntryIdentity,
} from "./services/snapshot-diff.ts";
