ALTER TABLE operations ADD COLUMN plan_id TEXT;
ALTER TABLE operations ADD COLUMN undo_of_operation_id TEXT;
ALTER TABLE operations ADD COLUMN reversible INTEGER NOT NULL DEFAULT 0
  CHECK (reversible IN (0, 1));
ALTER TABLE operations ADD COLUMN atomicity TEXT NOT NULL DEFAULT 'atomic'
  CHECK (atomicity IN ('atomic', 'per_item'));
ALTER TABLE operations ADD COLUMN resource_version_before INTEGER;
ALTER TABLE operations ADD COLUMN resource_version_after INTEGER;

CREATE INDEX operations_plan_idx ON operations(plan_id) WHERE plan_id IS NOT NULL;
CREATE INDEX operations_target_history_idx ON operations(target_id, created_at DESC);
CREATE INDEX operations_undo_idx
  ON operations(undo_of_operation_id) WHERE undo_of_operation_id IS NOT NULL;

CREATE TABLE automation_plans (
  plan_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('ready','applied','cancelled','expired','failed')),
  request_id TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  resource_id TEXT,
  idempotency_key TEXT,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  input_json TEXT NOT NULL,
  preconditions_json TEXT NOT NULL,
  impact_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  inverse_json TEXT,
  reversible INTEGER NOT NULL CHECK (reversible IN (0, 1)),
  atomicity TEXT NOT NULL CHECK (atomicity IN ('atomic','per_item')),
  manifest_relative_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  cancelled_at TEXT,
  CHECK (json_valid(input_json)),
  CHECK (json_valid(preconditions_json)),
  CHECK (json_valid(impact_json)),
  CHECK (json_valid(changes_json)),
  CHECK (inverse_json IS NULL OR json_valid(inverse_json))
) STRICT;

CREATE UNIQUE INDEX automation_plans_idempotency_uq
  ON automation_plans(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX automation_plans_state_created_idx
  ON automation_plans(state, created_at DESC);
CREATE INDEX automation_plans_resource_idx
  ON automation_plans(resource_id, created_at DESC) WHERE resource_id IS NOT NULL;

CREATE TABLE automation_plan_targets (
  plan_id TEXT NOT NULL REFERENCES automation_plans(plan_id),
  resource_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary','precondition','affected')),
  expected_version INTEGER,
  expected_state TEXT,
  PRIMARY KEY (plan_id, resource_id, role)
) STRICT;
CREATE INDEX automation_plan_targets_resource_idx
  ON automation_plan_targets(resource_id, plan_id);

CREATE TABLE automation_idempotency_records (
  idempotency_key TEXT PRIMARY KEY,
  command_kind TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('planned','running','succeeded','failed','cancelled')),
  plan_id TEXT,
  operation_id TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (result_json IS NULL OR json_valid(result_json))
) STRICT;
CREATE INDEX automation_idempotency_operation_idx
  ON automation_idempotency_records(operation_id) WHERE operation_id IS NOT NULL;

CREATE TABLE automation_operation_changes (
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  resource_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','skipped')),
  version_before INTEGER,
  version_after INTEGER,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  inverse_json TEXT,
  error_json TEXT,
  PRIMARY KEY (operation_id, ordinal),
  CHECK (json_valid(before_json)),
  CHECK (json_valid(after_json)),
  CHECK (inverse_json IS NULL OR json_valid(inverse_json)),
  CHECK (error_json IS NULL OR json_valid(error_json))
) STRICT;
CREATE INDEX automation_operation_changes_resource_idx
  ON automation_operation_changes(resource_id, operation_id);

CREATE TABLE audit_events (
  event_id TEXT PRIMARY KEY,
  operation_id TEXT REFERENCES operations(operation_id),
  plan_id TEXT,
  event_type TEXT NOT NULL,
  resource_id TEXT,
  actor TEXT NOT NULL DEFAULT 'cli',
  before_json TEXT,
  after_json TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  CHECK (before_json IS NULL OR json_valid(before_json)),
  CHECK (after_json IS NULL OR json_valid(after_json)),
  CHECK (json_valid(metadata_json))
) STRICT;
CREATE INDEX audit_events_resource_idx
  ON audit_events(resource_id, created_at DESC) WHERE resource_id IS NOT NULL;
CREATE INDEX audit_events_operation_idx
  ON audit_events(operation_id, created_at) WHERE operation_id IS NOT NULL;
CREATE INDEX audit_events_plan_idx
  ON audit_events(plan_id, created_at) WHERE plan_id IS NOT NULL;

CREATE TABLE source_purge_receipts (
  source_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(operation_id),
  source_identity_hash TEXT NOT NULL CHECK (length(source_identity_hash) = 64),
  impact_json TEXT NOT NULL,
  purged_at TEXT NOT NULL,
  CHECK (json_valid(impact_json))
) STRICT;

CREATE TRIGGER automation_plans_core_immutable
BEFORE UPDATE ON automation_plans
WHEN NEW.plan_id IS NOT OLD.plan_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.action IS NOT OLD.action
  OR NEW.request_id IS NOT OLD.request_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.resource_id IS NOT OLD.resource_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.input_json IS NOT OLD.input_json
  OR NEW.preconditions_json IS NOT OLD.preconditions_json
  OR NEW.impact_json IS NOT OLD.impact_json
  OR NEW.changes_json IS NOT OLD.changes_json
  OR NEW.inverse_json IS NOT OLD.inverse_json
  OR NEW.reversible IS NOT OLD.reversible
  OR NEW.atomicity IS NOT OLD.atomicity
  OR NEW.manifest_relative_path IS NOT OLD.manifest_relative_path
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'automation_plan_core_immutable');
END;

CREATE TRIGGER automation_plan_targets_immutable_update
BEFORE UPDATE ON automation_plan_targets
BEGIN
  SELECT RAISE(ABORT, 'automation_plan_target_immutable');
END;
CREATE TRIGGER automation_plan_targets_immutable_delete
BEFORE DELETE ON automation_plan_targets
BEGIN
  SELECT RAISE(ABORT, 'automation_plan_target_immutable');
END;
CREATE TRIGGER automation_operation_changes_immutable_update
BEFORE UPDATE ON automation_operation_changes
BEGIN
  SELECT RAISE(ABORT, 'automation_operation_change_immutable');
END;
CREATE TRIGGER automation_operation_changes_immutable_delete
BEFORE DELETE ON automation_operation_changes
BEGIN
  SELECT RAISE(ABORT, 'automation_operation_change_immutable');
END;
CREATE TRIGGER audit_events_immutable_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_event_immutable');
END;
CREATE TRIGGER audit_events_immutable_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_event_immutable');
END;

UPDATE workspace
SET database_schema_version = 10,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 10;
