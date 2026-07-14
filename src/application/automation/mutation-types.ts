export type PlannedMutationChange = {
  resource_id: string;
  resource_kind: string;
  change_kind: string;
  selector: Record<string, string>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

export type MutationDescription = {
  preconditions: Record<string, unknown>;
  impact: Record<string, unknown>;
  changes: PlannedMutationChange[];
  inverse: Record<string, unknown> | null;
  reversible: boolean;
  targets: {
    resourceId: string;
    resourceKind: string;
    role: "primary" | "precondition" | "affected";
    expectedVersion?: number | null;
    expectedState?: string | null;
  }[];
};

export function plannedChange(
  resourceKind: string,
  resourceId: string,
  selector: Record<string, string>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changeKind: string,
): PlannedMutationChange {
  return {
    resource_id: resourceId,
    resource_kind: resourceKind,
    change_kind: changeKind,
    selector,
    before,
    after,
  };
}
