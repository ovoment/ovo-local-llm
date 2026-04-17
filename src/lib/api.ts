import type { OvoModelsResponse } from "../types/ovo";
import type { SidecarPorts } from "../types/sidecar";

// [START] OpenAI-compatible content-parts wire format — content may be a plain
// string OR an array mixing text and image_url parts (multimodal messages).
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatWireMessage {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
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
  max_tokens?: number;
}

/**
 * Stream chat completions via the OpenAI-compat SSE endpoint.
 * Yields incremental content deltas as they arrive.
 */
export async function* streamChat(
  req: ChatCompletionRequest,
  signal?: AbortSignal,
  ports: SidecarPorts = DEFAULT_PORTS,
): AsyncGenerator<string, void, void> {
  const resp = await fetch(`${openaiBase(ports)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...req, stream: true }),
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
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch (e) {
        // Re-throw our own error frame; swallow JSON parse errors from partial chunks.
        if (e instanceof Error && e.message && !e.message.startsWith("Unexpected")) throw e;
      }
    }
  }
}
