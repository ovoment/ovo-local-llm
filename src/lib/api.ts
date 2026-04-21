import type { OvoModelsResponse } from "../types/ovo";
import type { SidecarPorts } from "../types/sidecar";

// [START] OpenAI-compatible content-parts wire format — content may be a plain
// string OR an array mixing text and image_url parts (multimodal messages).
// [START] Phase B — audio input part for audio-capable models (Phi-4-multimodal, Qwen2-Audio)
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };
// [END]

export interface ChatWireMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
}
// [END]

// [START] Wrap model thinking/template tokens as <think> blocks
export function cleanModelOutput(text: string): string {
  let cleaned = text;
  // Strip template tokens
  cleaned = cleaned.replace(/<\|[^|]*\|>/g, "");
  // Detect thinking preamble and wrap in <think> tags
  const thinkMatch = cleaned.match(/(?:Let's do (?:that|this|it)\.|Let's respond\.|That is \d)/i);
  if (thinkMatch && thinkMatch.index != null) {
    const thinkPart = cleaned.slice(0, thinkMatch.index + thinkMatch[0].length).trim();
    const responsePart = cleaned.slice(thinkMatch.index + thinkMatch[0].length).trim()
      .replace(/^(?:assistantfinal|assistant|final)\s*/i, "").trim();
    if (responsePart.length > 5) {
      return `<think>${thinkPart}</think>${responsePart}`;
    }
  }
  // Strip leftover prefixes
  cleaned = cleaned.replace(/^(?:analysis|assistantfinal|assistant|final)\s*/i, "");
  return cleaned.trim();
}
// [END]

export const DEFAULT_PORTS: SidecarPorts = {
  ollama: 11435,
  openai: 11436,
  native: 11437,
};

function nativeBase(ports: SidecarPorts): string {
  return `http://127.0.0.1:${ports.native}`;
}

function openaiBase(ports: SidecarPorts): string {
  return `http://127.0.0.1:${ports.openai}/v1`;
}

async function jsonOrThrow<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

export async function listModels(ports: SidecarPorts = DEFAULT_PORTS): Promise<OvoModelsResponse> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/models?mlx_only=true`);
  return jsonOrThrow<OvoModelsResponse>(resp);
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatWireMessage[];
  temperature?: number;
  top_p?: number;
  repetition_penalty?: number;
  max_tokens?: number;
}

// [START] StreamChatResult — callers that need usage totals (session.context_tokens
// update, auto-compact trigger) get the server's final usage frame. Non-stream
// consumers can ignore `usage` and just consume deltas.
export interface StreamUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface StreamChatYield {
  delta?: string;
  usage?: StreamUsage;
}
// [END]

/**
 * Stream chat completions via the OpenAI-compat SSE endpoint.
 * Yields incremental content deltas and, if `include_usage` is true,
 * a final usage object (no delta) just before the stream closes.
 */
export async function* streamChat(
  req: ChatCompletionRequest,
  signal?: AbortSignal,
  ports: SidecarPorts = DEFAULT_PORTS,
): AsyncGenerator<StreamChatYield, void, void> {
  const resp = await fetch(`${openaiBase(ports)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...req,
      stream: true,
      stream_options: { include_usage: true },
    }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`chat stream failed: ${resp.status} ${text}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: StreamUsage;
          error?: { type?: string; message?: string };
        };
        // [START] sidecar emits an error frame when generation fails mid-stream —
        // raise so the caller sees a real message instead of the headers-already-sent
        // "Load failed" that happens when the connection is just dropped.
        if (parsed.error) {
          const msg = parsed.error.message ?? "stream failed";
          const typ = parsed.error.type ? `${parsed.error.type}: ` : "";
          throw new Error(`${typ}${msg}`);
        }
        // [END]
        if (parsed.usage) {
          yield { usage: parsed.usage };
          continue;
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield { delta };
      } catch (e) {
        // Re-throw our own error frame; swallow JSON parse errors from partial chunks.
        if (e instanceof Error && e.message && !e.message.startsWith("Unexpected")) throw e;
      }
    }
  }
}

// [START] HuggingFace model search + download API wrappers
// Shape mirrors hf_downloader.py SearchResult / DownloadTask dataclasses.
// status uses "downloading" (not "running") — matches actual sidecar literal.
export interface HfSearchResult {
  repo_id: string;
  downloads?: number;
  likes?: number;
  last_modified?: string | null;
  tags?: string[];
}

export interface DownloadTask {
  task_id: string;
  repo_id: string;
  status: "pending" | "downloading" | "done" | "error" | "cancelled";
  error: string | null;
  snapshot_path: string | null;
  started_at: number;
  finished_at: number | null;
  // [START] Phase 7 — optional progress + cancel fields
  total_bytes?: number | null;
  downloaded_bytes?: number | null;
  total_files?: number | null;
  downloaded_files?: number | null;
  cancel_requested?: boolean;
  // [END]
}

export async function searchModels(
  q: string,
  limit = 25,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<HfSearchResult[]> {
  const url = `${nativeBase(ports)}/ovo/models/search?q=${encodeURIComponent(q)}&limit=${limit}`;
  const resp = await fetch(url);
  const data = await jsonOrThrow<{ query: string; results: HfSearchResult[] }>(resp);
  return data.results;
}

export async function startDownload(
  repo_id: string,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<DownloadTask> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/models/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo_id }),
  });
  return jsonOrThrow<DownloadTask>(resp);
}

export async function startDownloadFromUrl(
  url: string,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<DownloadTask> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/models/download-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return jsonOrThrow<DownloadTask>(resp);
}

export async function getDownload(
  task_id: string,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<DownloadTask> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/download/${task_id}`);
  return jsonOrThrow<DownloadTask>(resp);
}

export async function listDownloads(
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<DownloadTask[]> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/downloads`);
  const data = await jsonOrThrow<{ tasks: DownloadTask[] }>(resp);
  return data.tasks;
}

// [START] Phase 7 — cancel a running download task
export async function cancelDownload(
  task_id: string,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<void> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/download/${task_id}`, {
    method: "DELETE",
  });
  if (!resp.ok && resp.status !== 404) {
    const text = await resp.text().catch(() => "");
    throw new Error(`cancel failed: ${resp.status} ${text}`);
  }
}

// [START] Phase 7 — force-delete a model (HF cache + optional LM Studio).
// Note: we intentionally do NOT encodeURIComponent the slash in repo_id —
// FastAPI's `{repo_id:path}` parameter matches the raw `/` literal; sending
// `%2F` breaks the route match. Other reserved chars aren't expected in HF
// repo_ids so skipping encoding is safe here.
export async function deleteModel(
  repo_id: string,
  force = true,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<void> {
  const url = `${nativeBase(ports)}/ovo/models/${repo_id}?force=${force}`;
  const resp = await fetch(url, { method: "DELETE" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`delete failed: ${resp.status} ${text}`);
  }
}
// [END]
// [END]

// [START] /ovo/count_tokens + /ovo/summarize — native sidecar endpoints used
// by auto-compact engine and session token preview.
export interface CountTokensMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

export async function countTokens(
  model: string,
  messages: CountTokensMessage[],
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<number> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/count_tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages }),
  });
  const data = await jsonOrThrow<{ prompt_tokens: number }>(resp);
  return data.prompt_tokens;
}

export interface SummarizeResult {
  summary: string;
  usage: StreamUsage;
}

export async function summarize(
  model: string,
  messages: CountTokensMessage[],
  opts: { max_tokens?: number; instruction?: string } = {},
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<SummarizeResult> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, ...opts }),
  });
  return jsonOrThrow<SummarizeResult>(resp);
}
// [END]

// [START] Phase 8.4 — grammar-constrained tool-call regeneration.
// When the code agent's text-based tool_use parsing fails (malformed JSON
// the model can't recover from, wrong tag dialect, etc.) we call this
// endpoint as a last-resort. The sidecar loads the same model behind an
// Outlines logits processor and returns a tool call JSON that is
// guaranteed to parse and match one of the declared tool signatures —
// the decoder physically cannot emit an invalid token.
export interface ConstrainedToolSchema {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
}

export interface ConstrainedToolCallResponse {
  tool_call: { name: string; arguments: Record<string, unknown> };
  raw: string;
}

export async function generateConstrainedToolCall(
  model: string,
  messages: CountTokensMessage[],
  tools: ConstrainedToolSchema[],
  opts: { max_tokens?: number } = {},
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<ConstrainedToolCallResponse> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/tool_call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, tools, ...opts }),
  });
  return jsonOrThrow<ConstrainedToolCallResponse>(resp);
}
// [END]

// [START] unloadLoadedModels — asks the sidecar to drop every currently-held
// MLX runner (text + vlm pools). Used when the user switches session models
// so unified memory isn't wedged by the previous model. Fire-and-forget from
// the caller — failures are swallowed by the caller's try/catch if present.
export async function unloadLoadedModels(
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<{ freed: string[] }> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/unload`, { method: "POST" });
  return jsonOrThrow<{ freed: string[] }>(resp);
}
// [END]

// [START] Phase 6.4 — OVO built-in web search (key-less, DuckDuckGo-backed).
// Surfaces as a 'web_search' tool in the MCP catalog (see lib/toolUse.ts)
// and is routed to this endpoint instead of the MCP pool.
export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  query: string;
  results: WebSearchHit[];
}

export async function webSearch(
  query: string,
  limit = 8,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<WebSearchResult> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/websearch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  return jsonOrThrow<WebSearchResult>(resp);
}
// [END]

// [START] Phase 7 — image generation client.
// SSE consumer for /ovo/images/generate plus the non-streaming fallback.
// Gallery listing fetches the user's previously-saved renders so the UI
// can rebuild a grid on mount.
export interface LoraEntry {
  path: string;
  strength: number;
}

export interface ImagesGenerateRequest {
  prompt: string;
  model: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg_scale?: number;
  sampler?: string;
  seed?: number | null;
  batch?: number;
  shift?: number | null;
  loras?: LoraEntry[];
  control_image_b64?: string | null;
  control_model?: string | null;
  control_strength?: number;
}

export interface GeneratedImage {
  index: number;
  path: string;
  base64_png: string;
  seed: number;
  width: number;
  height: number;
}

export interface ImagesLoadingEvent {
  type: "loading";
  model: string;
}

export interface ImagesProgressEvent {
  type: "progress";
  step: number;
  total: number;
  elapsed_ms: number;
}

export interface ImagesImageEvent extends GeneratedImage {
  type: "image";
}

export interface ImagesDoneEvent {
  type: "done";
  model: string;
  sampler: string;
  total_elapsed_ms: number;
}

export interface ImagesErrorEvent {
  type: "error";
  message: string;
}

export type ImagesEvent =
  | ImagesLoadingEvent
  | ImagesProgressEvent
  | ImagesImageEvent
  | ImagesDoneEvent
  | ImagesErrorEvent;

export async function* streamImageGeneration(
  req: ImagesGenerateRequest,
  signal?: AbortSignal,
  ports: SidecarPorts = DEFAULT_PORTS,
): AsyncGenerator<ImagesEvent, void, void> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/images/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "");
    throw new Error(`image stream failed: ${resp.status} ${text}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as ImagesEvent;
        yield parsed;
        if (parsed.type === "done" || parsed.type === "error") return;
      } catch {
        // Ignore malformed frames — next one will likely parse.
      }
    }
  }
}

export interface ImagesGallery {
  images: Array<{ path: string; name: string; size_bytes: number; modified_at: number }>;
}

export async function listImagesGallery(
  limit = 100,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<ImagesGallery> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/images/gallery?limit=${limit}`);
  return jsonOrThrow<ImagesGallery>(resp);
}

// [START] Phase 7 — raw image URL + delete helpers.
// Serving through the sidecar sidesteps Tauri's assetProtocol scope entirely.
export function imageRawUrl(
  absolutePath: string,
  ports: SidecarPorts = DEFAULT_PORTS,
): string {
  return `${nativeBase(ports)}/ovo/images/raw?path=${encodeURIComponent(absolutePath)}`;
}

export async function deleteImage(
  absolutePath: string,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<void> {
  const resp = await fetch(
    `${nativeBase(ports)}/ovo/images/raw?path=${encodeURIComponent(absolutePath)}`,
    { method: "DELETE" },
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`delete failed: ${resp.status} ${text}`);
  }
}

// [START] Phase 7 — Upscale client (x4 via StableDiffusionUpscalePipeline).
export interface UpscaleRequest {
  source_path: string;
  prompt?: string;
  steps?: number;
  guidance_scale?: number;
  model?: string;
  seed?: number | null;
}

export interface UpscaleResult {
  path: string;
  base64_png: string;
  width: number;
  height: number;
  elapsed_ms: number;
}

export async function upscaleImage(
  req: UpscaleRequest,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<UpscaleResult> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/images/upscale`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  return jsonOrThrow<UpscaleResult>(resp);
}
// [END]
// [END]

export async function searchImageModels(
  q: string,
  limit = 25,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<HfSearchResult[]> {
  const url = `${nativeBase(ports)}/ovo/models/search?q=${encodeURIComponent(q)}&limit=${limit}&kind=image`;
  const resp = await fetch(url);
  const data = await jsonOrThrow<{ query: string; results: HfSearchResult[] }>(resp);
  return data.results;
}
// [END] Phase 7

// [START] Phase 8 — /ovo/system/info for llmfit.
// Snapshot of the host hardware (RAM / CPU / GPU / disk) used to score
// whether a given model can run comfortably on this machine. Fields follow
// the sidecar shape 1:1 so additions on either side stay synchronised.
export interface SystemInfo {
  platform: string;
  arch: string;
  os_release: string;
  cpu: {
    brand: string;
    logical_cores: number;
    physical_cores: number;
  };
  memory: {
    total_bytes: number;
    available_bytes: number;
    used_bytes: number;
    percent: number;
  };
  disk: {
    path: string;
    free_bytes: number;
    total_bytes: number;
  };
  gpu: {
    unified: boolean;
    kind: string;
    // [START] Phase 8 — authoritative MLX budget.
    // Bytes MLX will actually allocate without forcing macOS into swap.
    // Populated by configure_memory_limits() at sidecar startup; 0 means
    // the sidecar hasn't planted a limit yet (non-MLX host or legacy
    // build). Use `mlx_memory_limit_bytes` as the preferred "usable"
    // ceiling in fit scoring — it's more accurate than `memory.total`
    // minus a rule-of-thumb overhead.
    mlx_memory_limit_bytes?: number;
    mlx_cache_limit_bytes?: number;
    gpu_wired_limit_bytes?: number;
    // [END]
  };
}

export async function getSystemInfo(
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<SystemInfo> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/system/info`);
  return jsonOrThrow<SystemInfo>(resp);
}
// [END]
