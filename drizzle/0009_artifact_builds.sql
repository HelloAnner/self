CREATE TABLE artifact_templates (
  template_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,
  page_ir_version INTEGER NOT NULL CHECK (page_ir_version > 0),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','deprecated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifact_themes (
  theme_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  relative_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','deprecated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('topic_report')),
  topic_id TEXT UNIQUE REFERENCES topics(topic_id),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready','stale','failed','deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  latest_build_id TEXT,
  stale_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX artifacts_status_updated_idx ON artifacts(status, updated_at DESC);
CREATE INDEX artifacts_latest_build_idx ON artifacts(latest_build_id);

CREATE TABLE artifact_builds (
  build_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  parent_build_id TEXT REFERENCES artifact_builds(build_id),
  topic_snapshot_id TEXT NOT NULL REFERENCES topic_snapshots(topic_snapshot_id),
  build_kind TEXT NOT NULL CHECK (build_kind IN ('full','refresh','render')),
  state TEXT NOT NULL CHECK (state IN ('building','ready','failed')),
  page_ir_version INTEGER NOT NULL CHECK (page_ir_version > 0),
  template_id TEXT NOT NULL REFERENCES artifact_templates(template_id),
  template_version TEXT NOT NULL,
  theme_id TEXT NOT NULL REFERENCES artifact_themes(theme_id),
  theme_version TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  relative_directory TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
  knowledge_hash TEXT NOT NULL CHECK (length(knowledge_hash) = 64),
  page_ir_hash TEXT CHECK (page_ir_hash IS NULL OR length(page_ir_hash) = 64),
  manifest_hash TEXT CHECK (manifest_hash IS NULL OR length(manifest_hash) = 64),
  content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
  timings_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  error_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (json_valid(timings_json)),
  CHECK (json_valid(warnings_json)),
  CHECK (error_json IS NULL OR json_valid(error_json))
) STRICT;
CREATE INDEX artifact_builds_artifact_idx
  ON artifact_builds(artifact_id, created_at DESC);
CREATE INDEX artifact_builds_snapshot_idx
  ON artifact_builds(topic_snapshot_id, state);

CREATE TABLE artifact_build_dependencies (
  build_id TEXT NOT NULL REFERENCES artifact_builds(build_id),
  dependency_kind TEXT NOT NULL CHECK (dependency_kind IN
    ('topic_snapshot','document','revision','chunk','claim','entity','relation','model','template','theme')),
  dependency_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  role TEXT NOT NULL CHECK (role IN ('input','citation','render')),
  PRIMARY KEY (build_id, dependency_kind, dependency_id, role)
) STRICT;
CREATE INDEX artifact_build_dependencies_lookup_idx
  ON artifact_build_dependencies(dependency_kind, dependency_id, build_id);

CREATE TABLE artifact_build_components (
  build_id TEXT NOT NULL REFERENCES artifact_builds(build_id),
  component_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  component_type TEXT NOT NULL CHECK (component_type IN
    ('hero','conclusion_cards','evidence_blocks','timeline','comparison_matrix',
     'knowledge_graph','conflicts','knowledge_gaps','source_directory')),
  topic_section_id TEXT REFERENCES topic_report_sections(section_id),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  dependency_hash TEXT NOT NULL CHECK (length(dependency_hash) = 64),
  reused_from_build_id TEXT REFERENCES artifact_builds(build_id),
  reused_from_component_key TEXT,
  payload_json TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  theme_version TEXT NOT NULL,
  PRIMARY KEY (build_id, component_key),
  UNIQUE (build_id, ordinal),
  CHECK (json_valid(payload_json))
) STRICT;
CREATE INDEX artifact_build_components_section_idx
  ON artifact_build_components(topic_section_id, build_id);

CREATE TABLE artifact_build_files (
  build_id TEXT NOT NULL REFERENCES artifact_builds(build_id),
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  media_type TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manifest','input','page_ir','data','html','style','script')),
  PRIMARY KEY (build_id, relative_path)
) STRICT;

CREATE TABLE artifact_exports (
  export_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  build_id TEXT NOT NULL REFERENCES artifact_builds(build_id),
  export_format TEXT NOT NULL CHECK (export_format IN ('html','markdown','json')),
  single_file INTEGER NOT NULL DEFAULT 0 CHECK (single_file IN (0,1)),
  output_path TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX artifact_exports_build_idx ON artifact_exports(build_id, created_at DESC);

CREATE TRIGGER artifact_builds_ready_immutable_update
BEFORE UPDATE ON artifact_builds WHEN OLD.state = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;
CREATE TRIGGER artifact_builds_ready_immutable_delete
BEFORE DELETE ON artifact_builds WHEN OLD.state = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;

CREATE TRIGGER artifact_dependencies_ready_insert
BEFORE INSERT ON artifact_build_dependencies
WHEN (SELECT state FROM artifact_builds WHERE build_id = NEW.build_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;
CREATE TRIGGER artifact_dependencies_ready_update
BEFORE UPDATE ON artifact_build_dependencies
WHEN (SELECT state FROM artifact_builds WHERE build_id = OLD.build_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;
CREATE TRIGGER artifact_dependencies_ready_delete
BEFORE DELETE ON artifact_build_dependencies
WHEN (SELECT state FROM artifact_builds WHERE build_id = OLD.build_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;

CREATE TRIGGER artifact_components_ready_insert
BEFORE INSERT ON artifact_build_components
WHEN (SELECT state FROM artifact_builds WHERE build_id = NEW.build_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;
CREATE TRIGGER artifact_components_ready_update
BEFORE UPDATE ON artifact_build_components
WHEN (SELECT state FROM artifact_builds WHERE build_id = OLD.build_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;
CREATE TRIGGER artifact_components_ready_delete
BEFORE DELETE ON artifact_build_components
WHEN (SELECT state FROM artifact_builds WHERE build_id = OLD.build_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;

CREATE TRIGGER artifact_files_ready_insert
BEFORE INSERT ON artifact_build_files
WHEN (SELECT state FROM artifact_builds WHERE build_id = NEW.build_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;
CREATE TRIGGER artifact_files_ready_update
BEFORE UPDATE ON artifact_build_files
WHEN (SELECT state FROM artifact_builds WHERE build_id = OLD.build_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;
CREATE TRIGGER artifact_files_ready_delete
BEFORE DELETE ON artifact_build_files
WHEN (SELECT state FROM artifact_builds WHERE build_id = OLD.build_id) = 'ready'
BEGIN SELECT RAISE(ABORT, 'artifact_build_immutable'); END;

UPDATE workspace
SET database_schema_version = 9,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1;

PRAGMA user_version = 9;
