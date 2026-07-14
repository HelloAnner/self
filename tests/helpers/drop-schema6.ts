import { DROP_SCHEMA8_SQL } from "./drop-schema8.ts";

export const DROP_SCHEMA6_SQL = `
  ${DROP_SCHEMA8_SQL}
  DROP TABLE answer_citations;
  DROP TABLE answer_statements;
  DROP TABLE answer_runs;
  DROP TABLE evidence_context_items;
  DROP TABLE evidence_contexts;
  DROP TABLE retrieval_candidates;
  DROP TABLE retrieval_runs;
  DROP TABLE graph_extraction_runs;
  DROP TABLE graph_semantic_neighbors;
  DROP TABLE graph_unresolved_references;
  DROP TABLE graph_conflict_members;
  DROP TABLE graph_conflict_sets;
  DROP TABLE graph_claim_relations;
  DROP TABLE graph_claim_evidence;
  DROP TABLE graph_generation_claims;
  DROP TABLE graph_claims;
  DROP TABLE graph_relation_evidence;
  DROP TABLE graph_generation_relations;
  DROP TABLE graph_relations;
  DROP TABLE graph_predicates;
  DROP TABLE graph_entity_redirects;
  DROP TABLE graph_entity_aliases;
  DROP TABLE graph_entities;
  DROP TABLE graph_generation_nodes;
  DROP TABLE graph_nodes;
  DROP TABLE graph_active_generation;
  DROP TABLE graph_generations;
`;
