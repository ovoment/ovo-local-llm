export type ModelSource = "hf" | "lmstudio";

/**
 * MLX quantization config as it appears in HuggingFace config.json.
 * The sidecar forwards it verbatim — may be a structured object OR a legacy
 * string ("q4", "q8_0"), so consumers must handle both shapes.
 */
export interface QuantizationConfig {
  group_size?: number;
  bits?: number;
  mode?: string;
}

export interface OvoModel {
  repo_id: string;
  revision: string;
  snapshot_path: string;
  size_bytes: number;
  is_mlx: boolean;
  model_type?: string | null;
  architecture?: string | string[] | null;
  quantization?: QuantizationConfig | string | null;
  hidden_size?: number | null;
  source: ModelSource;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OvoSettings {
  language: "ko" | "en";
  theme: "system" | "light" | "dark";
  default_model?: string;
  ollama_port: number;
  openai_port: number;
  expose_to_network: boolean;
  claude_integration_enabled: boolean;
  pet_enabled: boolean;
}

export interface OvoModelsResponse {
  models: OvoModel[];
  count: number;
  cache_dirs: { hf: string; lmstudio: string };
}
