export type ModelProvider = {
  provider_id: string;
  name: string;
  provider_type: "openai_compatible" | "test_deterministic";
  protocol: "openai-compatible" | "fixture";
  endpoint_identity: string;
  api_key_env: string | null;
  state: "active" | "disabled" | "failed";
  circuit_state: "closed" | "open" | "half_open";
};

export type RegisteredModel = {
  model_id: string;
  provider_id: string;
  capability: "embedding" | "chat" | "rerank" | "vision" | "ocr";
  provider_model_id: string;
  model_revision: string;
  revision_stability: "fixed" | "floating";
  dimensions_json: string;
  state: "active" | "disabled" | "failed";
};

export type VectorSpaceDefinition = {
  provider_type: string;
  provider_endpoint_identity: string;
  provider_model_id: string;
  model_revision: string;
  revision_stability: "fixed" | "floating";
  tokenizer_revision: string;
  dimensions: number;
  scalar_type: "float32";
  pooling: string;
  normalization: "l2";
  distance_metric: "cosine";
  query_instruction_id: string;
  query_instruction_text: string;
  document_instruction_id: string | null;
  document_instruction_text: string | null;
  embedding_input_version: string;
};
