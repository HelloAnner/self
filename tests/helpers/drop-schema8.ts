import { DROP_SCHEMA10_SQL } from "./drop-schema10.ts";

export const DROP_SCHEMA8_SQL = `
  ${DROP_SCHEMA10_SQL}
  DROP TABLE artifact_exports;
  DROP TABLE artifact_build_files;
  DROP TABLE artifact_build_components;
  DROP TABLE artifact_build_dependencies;
  DROP TABLE artifact_builds;
  DROP TABLE artifacts;
  DROP TABLE artifact_themes;
  DROP TABLE artifact_templates;
  DROP TABLE topic_report_citations;
  DROP TABLE topic_report_conclusions;
  DROP TABLE topic_report_sections;
  DROP TABLE topic_knowledge_gaps;
  DROP TABLE topic_report_outlines;
  DROP TABLE topic_snapshot_relations;
  DROP TABLE topic_snapshot_nodes;
  DROP TABLE topic_snapshot_claims;
  DROP TABLE topic_snapshots;
  DROP TABLE topic_synthesis_runs;
  DROP TABLE topic_aliases;
  DROP TABLE topics;
`;
