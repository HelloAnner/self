import { describe, expect, test } from "bun:test";
import {
  type VectorSpaceDefinition,
  vectorSpaceFingerprint,
} from "../../src/domains/model/index.ts";

const baseline: VectorSpaceDefinition = {
  provider_type: "openai_compatible",
  provider_endpoint_identity: "https://example.invalid/v1",
  provider_model_id: "text-embedding-v4",
  model_revision: "floating",
  revision_stability: "floating",
  tokenizer_revision: "provider-default-v1",
  dimensions: 1024,
  scalar_type: "float32",
  pooling: "provider-default",
  normalization: "l2",
  distance_metric: "cosine",
  query_instruction_id: "personal-knowledge-retrieval-v1",
  query_instruction_text: "Retrieve direct evidence.",
  document_instruction_id: null,
  document_instruction_text: null,
  embedding_input_version: "chunk-title-path-content-v1",
};

describe("VectorSpace fingerprint", () => {
  test("is deterministic and independent of object insertion order", () => {
    const reversed = Object.fromEntries(
      Object.entries(baseline).reverse(),
    ) as VectorSpaceDefinition;
    expect(vectorSpaceFingerprint(reversed)).toBe(vectorSpaceFingerprint(baseline));
  });

  test("changes for every mathematical compatibility boundary", () => {
    const original = vectorSpaceFingerprint(baseline);
    for (const changed of [
      { provider_endpoint_identity: "https://other.invalid/v1" },
      { provider_model_id: "text-embedding-v3" },
      { model_revision: "fixed-2026-07" },
      { dimensions: 768 },
      { query_instruction_text: "Retrieve only exact passages." },
      { embedding_input_version: "chunk-content-v2" },
    ]) {
      expect(vectorSpaceFingerprint({ ...baseline, ...changed })).not.toBe(original);
    }
  });
});
