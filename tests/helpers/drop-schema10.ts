import { DROP_SCHEMA11_SQL } from "./drop-schema11.ts";

export const DROP_SCHEMA10_SQL = `
  ${DROP_SCHEMA11_SQL}
  DROP TABLE source_purge_receipts;
  DROP TABLE audit_events;
  DROP TABLE automation_operation_changes;
  DROP TABLE automation_idempotency_records;
  DROP TABLE automation_plan_targets;
  DROP TABLE automation_plans;
  DROP INDEX operations_plan_idx;
  DROP INDEX operations_target_history_idx;
  DROP INDEX operations_undo_idx;
  ALTER TABLE operations DROP COLUMN resource_version_after;
  ALTER TABLE operations DROP COLUMN resource_version_before;
  ALTER TABLE operations DROP COLUMN atomicity;
  ALTER TABLE operations DROP COLUMN reversible;
  ALTER TABLE operations DROP COLUMN undo_of_operation_id;
  ALTER TABLE operations DROP COLUMN plan_id;
`;
