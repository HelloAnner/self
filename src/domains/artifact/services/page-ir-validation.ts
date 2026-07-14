import { PAGE_IR_COMPONENT_TYPES, type PageIrV1 } from "../model/types.ts";

export type PageIrValidation = { valid: boolean; errors: string[] };

export function validatePageIr(input: unknown): PageIrValidation {
  const errors: string[] = [];
  if (!record(input)) return { valid: false, errors: ["page_ir_must_be_object"] };
  if (input.schema !== "self.page-ir") errors.push("page_ir_schema_invalid");
  if (input.version !== 1) errors.push("page_ir_version_unsupported");
  if (!record(input.artifact)) errors.push("page_ir_artifact_missing");
  if (!record(input.topic)) errors.push("page_ir_topic_missing");
  if (!record(input.template)) errors.push("page_ir_template_missing");
  if (!record(input.theme)) errors.push("page_ir_theme_missing");
  if (!Array.isArray(input.components)) errors.push("page_ir_components_missing");
  if (!Array.isArray(input.citations)) errors.push("page_ir_citations_missing");
  if (Array.isArray(input.components)) validateComponents(input.components, errors);
  if (Array.isArray(input.citations)) validateCitations(input.citations, errors);
  return { valid: errors.length === 0, errors };
}

export function assertPageIr(input: unknown): asserts input is PageIrV1 {
  const result = validatePageIr(input);
  if (!result.valid) throw new Error(result.errors.join(","));
}

function validateComponents(rows: unknown[], errors: string[]) {
  const keys = new Set<string>();
  rows.forEach((row, index) => {
    if (!record(row)) {
      errors.push(`component_${index}_invalid`);
      return;
    }
    if (typeof row.key !== "string" || row.key.length === 0)
      errors.push(`component_${index}_key_invalid`);
    else if (keys.has(row.key)) errors.push(`component_${index}_key_duplicate`);
    else keys.add(row.key);
    if (!(PAGE_IR_COMPONENT_TYPES as readonly unknown[]).includes(row.type))
      errors.push(`component_${index}_type_invalid`);
    if (!hash(row.contentHash)) errors.push(`component_${index}_content_hash_invalid`);
    if (!hash(row.dependencyHash)) errors.push(`component_${index}_dependency_hash_invalid`);
    if (!record(row.payload)) errors.push(`component_${index}_payload_invalid`);
  });
}

function validateCitations(rows: unknown[], errors: string[]) {
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    if (!record(row)) {
      errors.push(`citation_${index}_invalid`);
      return;
    }
    if (typeof row.citationId !== "string" || row.citationId.length === 0)
      errors.push(`citation_${index}_id_invalid`);
    else if (ids.has(row.citationId)) errors.push(`citation_${index}_id_duplicate`);
    else ids.add(row.citationId);
    if (typeof row.excerpt !== "string") errors.push(`citation_${index}_excerpt_invalid`);
    if (!hash(row.excerptHash)) errors.push(`citation_${index}_hash_invalid`);
  });
}

function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
