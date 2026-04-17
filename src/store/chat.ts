import { create } from "zustand";
import i18n from "i18next";
import {
  streamChat,
  webSearch,
  type ChatContentPart,
  type ChatWireMessage,
} from "../lib/api";
import type { OwlState } from "../components/Owl";
import type { ChatAttachment, Message } from "../types/ovo";
import { useSidecarStore } from "./sidecar";
import { useSessionsStore } from "./sessions";
import { updateMessageContent } from "../db/sessions";
import { maybeAutoCompact } from "../lib/compact";
import { useChatSettingsStore } from "./chat_settings";
// [START] Phase 6.1 — project context store for transient system prompt injection
import { useProjectContextStore } from "./project_context";
// [END]
// [START] Phase 6.3 — wiki retrieval for system prompt injection
import { searchWikiPages } from "../db/wiki";
// [END]
// [START] model_perf — import performance tracking store
import { useModelPerfStore } from "./model_perf";
// [END]
// [START] Phase A — attachment persistence helpers
import { saveAttachment, readAttachmentAsDataUrl } from "../lib/attachmentStorage";
// [END]
// [START] Phase 6.2c — MCP tool-use integration
import { useMcpStore } from "./mcp";
import { mcpCall } from "../lib/mcp";
import { parseToolUseBlock, buildToolsSystemMessage, BUILTIN_TOOLS, isBuiltinTool } from "../lib/toolUse";
import { useModelProfilesStore } from "./model_profiles";
import { useToastsStore } from "./toasts";
// [END]

// [START] Attachment → OpenAI content-parts conversion.
// stored kind: read bytes from disk via readAttachmentAsDataUrl and inline.
// url kind: pass through as image_url (server fetches).
// file kind (in-flight, should not reach here after Phase A save flow):
//   fall back to FileReader base64 for resilience.
// image/* → image_url part; audio/* → input_audio part; others skipped.
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

// [START] Phase B — MIME → audio format string mapping
// "audio/mpeg" → "mp3", "audio/wav" → "wav", "audio/x-m4a" | "audio/mp4" → "m4a", etc.
function audioMimeToFormat(mime: string): string {
  const sub = mime.split("/")[1] ?? "bin";
  const map: Record<string, string> = {
    mpeg: "mp3",
    "x-m4a": "m4a",
    mp4: "m4a",
    ogg: "ogg",
    flac: "flac",
    webm: "webm",
  };
  return map[sub] ?? sub;
}

// Strip "data:...;base64," prefix from a data URL, returning just the base64 payload.
function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}
// [END]

// [START] wire normalizer — strict chat templates (Llama, Qwen, Gemma, ...)
// reject empty messages or same-role runs ("Conversation roles must alternate
// user/assistant/user/assistant"). After tool-use rounds we can legitimately
// end up with an assistant with content="" (the tool_use block was the whole
// turn) followed by a tool_result user message; some templates also choke on
// two user messages in a row. This pass drops empties and collapses same-role
// neighbors by concatenating their content (text-only; multi-part arrays pass
// through untouched because collapsing image/audio parts requires care).
function wireContentAsText(content: ChatWireMessage["content"]): string | null {
  if (typeof content === "string") return content;
  return null; // multi-part array — leave as-is
}

function normalizeWire(wire: ChatWireMessage[]): ChatWireMessage[] {
  // Drop empty string-content messages (preserves multi-part / attachment ones)
  const nonEmpty = wire.filter((m) => {
    const asText = wireContentAsText(m.content);
    return asText === null ? true : asText.trim().length > 0;
  });
  // Collapse consecutive same-role string-content messages
  const merged: ChatWireMessage[] = [];
  for (const m of nonEmpty) {
    const prev = merged[merged.length - 1];
    if (
      prev
      && prev.role === m.role
      && typeof prev.content === "string"
      && typeof m.content === "string"
    ) {
      prev.content = `${prev.content}\n\n${m.content}`;
      continue;
    }
    merged.push({ ...m });
  }
  return merged;
}
// [END]

async function messageToWire(m: Message): Promise<ChatWireMessage> {
  const atts = m.attachments ?? [];
  const role = m.role === "summary" ? "system" : m.role;
  if (atts.length === 0) return { role, content: m.content };
  const parts: ChatContentPart[] = [];
  if (m.content) parts.push({ type: "text", text: m.content });
  for (const a of atts) {
    if (a.kind === "url") {
      parts.push({ type: "image_url", image_url: { url: a.url } });
      continue;
    }
    if (a.kind === "stored") {
      const mime = a.meta.mime;
      if (mime.startsWith("image/")) {
        const dataUrl = await readAttachmentAsDataUrl(a.meta);
        if (dataUrl) parts.push({ type: "image_url", image_url: { url: dataUrl } });
      } else if (mime.startsWith("audio/")) {
        // [START] Phase B — audio stored attachment → input_audio part
        const dataUrl = await readAttachmentAsDataUrl(a.meta);
        if (dataUrl) {
          parts.push({
            type: "input_audio",
            input_audio: { data: stripDataUrlPrefix(dataUrl), format: audioMimeToFormat(mime) },
          });
        }
        // [END]
      }
      continue;
    }
    // file kind — resilience fallback (save first then convert)
    const fileMime = a.file.type;
    if (fileMime.startsWith("image/")) {
      try {
        const meta = await saveAttachment(a.file);
        const dataUrl = await readAttachmentAsDataUrl(meta);
        if (dataUrl) parts.push({ type: "image_url", image_url: { url: dataUrl } });
      } catch {
        // Last resort: FileReader
        const url = a.previewDataUrl ?? (await fileToDataUrl(a.file));
        if (url) parts.push({ type: "image_url", image_url: { url } });
      }
    } else if (fileMime.startsWith("audio/")) {
      // [START] Phase B — audio file attachment → input_audio part
      try {
        const meta = await saveAttachment(a.file);
        const dataUrl = await readAttachmentAsDataUrl(meta);
        if (dataUrl) {
          parts.push({
            type: "input_audio",
            input_audio: { data: stripDataUrlPrefix(dataUrl), format: audioMimeToFormat(fileMime) },
          });
        }
      } catch {
        const dataUrl = await fileToDataUrl(a.file);
        if (dataUrl) {
          parts.push({
            type: "input_audio",
            input_audio: { data: stripDataUrlPrefix(dataUrl), format: audioMimeToFormat(fileMime) },
          });
        }
      }
      // [END]
    }
  }
  const hasMultimodal = parts.some((p) => p.type === "image_url" || p.type === "input_audio");
  return { role, content: hasMultimodal ? parts : m.content };
}
// [END]

// [START] QueueItem — pending message waiting for current stream to finish
interface QueueItem {
  content: string;
  attachments: ChatAttachment[] | undefined;
}
// [END]

interface ChatStoreState {
  streaming: boolean;
  owlState: OwlState;
  error: string | null;
  abortController: AbortController | null;
  // [START] queue state for "queue" streaming send mode
  queue: QueueItem[];
  isDraining: boolean;
  // [END]

  sendMessage: (content: string, attachments?: ChatAttachment[]) => Promise<void>;
  stopStreaming: () => void;
  clearQueue: () => void;
}

// Derive the "current model" from the current session; fall back to undefined
// (ChatPane surfaces a 'no_model' error if unset before send).
function currentModelForSend(): string | null {
  const { sessions, currentSessionId } = useSessionsStore.getState();
  const sess = sessions.find((s) => s.id === currentSessionId);
  return sess?.model_ref ?? null;
}

// [START] think-block detection — lets the owl animation switch between
// "thinking" (inside <think>/<reasoning>/Harmony analysis) and "typing"
// (visible response body) during streaming. Scans only the tail of the
// accumulated buffer so cost stays O(1) per delta regardless of response
// length; once `insideThink` flips, the caller keeps tracking it so long
// reasoning blocks (>tail window) don't lose state.
const THINK_OPEN_MARKERS: ReadonlyArray<string> = [
  "<think>",
  "<thinking>",
  "<reasoning>",
  "<|channel|>analysis",
  "<|channel|>reasoning",
];
const THINK_CLOSE_MARKERS: ReadonlyArray<string> = [
  "</think>",
  "</thinking>",
  "</reasoning>",
  "<|end|>",
];
const THINK_SCAN_WINDOW = 500;

function detectThinkTransition(accumulated: string): boolean | null {
  const start = Math.max(0, accumulated.length - THINK_SCAN_WINDOW);
  const tail = accumulated.substring(start);
  let lastOpen = -1;
  for (const tag of THINK_OPEN_MARKERS) {
    const idx = tail.lastIndexOf(tag);
    if (idx > lastOpen) lastOpen = idx;
  }
  let lastClose = -1;
  for (const tag of THINK_CLOSE_MARKERS) {
    const idx = tail.lastIndexOf(tag);
    if (idx > lastClose) lastClose = idx;
  }
  if (lastOpen === -1 && lastClose === -1) return null;
  return lastOpen > lastClose;
}
// [END]

export const useChatStore = create<ChatStoreState>((set, get) => {
  // [START] Phase 6.2c — resolve server_id for a tool name
  function resolveServerId(toolName: string): string | null {
    const { status } = useMcpStore.getState();
    for (const srv of Object.values(status)) {
      if (srv.running && srv.tools.some((t) => t.name === toolName)) {
        return srv.server_id;
      }
    }
    return null;
  }
  // [END]

  // [START] Phase 6.4 — dispatch a built-in OVO tool (hosted by the sidecar,
  // no MCP server involved). Returns the raw result object the caller will
  // JSON-serialize and feed back as a <tool_result>.
  async function dispatchBuiltin(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (name === "web_search") {
      const query = typeof args.query === "string" ? args.query : "";
      const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 8;
      return await webSearch(query, limit);
    }
    throw new Error(`Unknown built-in tool: ${name}`);
  }
  // [END]

  // [START] _sendOne — actual single-turn execution; sendMessage wraps this
  // with mode-aware dispatch logic.
  // toolLoopDepth: recursion counter for tool-call chaining; capped at 5.
  // When toolLoopDepth > 0 the caller is a tool-result continuation — skip the
  // empty-content early-return guard so the model can see the appended tool_result.
  async function _sendOne(content: string, attachments?: ChatAttachment[], toolLoopDepth = 0): Promise<void> {
    const trimmed = content.trim();
    const hasAttachments = (attachments?.length ?? 0) > 0;
    if (!trimmed && !hasAttachments && toolLoopDepth === 0) return;

    const sessions = useSessionsStore.getState();
    let sessionId = sessions.currentSessionId;

    // [START] Lazy session create — first message without active session
    // spawns one with the auto-picked model. Fail-fast if no model is known.
    const modelForNew = currentModelForSend();
    if (!sessionId) {
      if (!modelForNew) {
        set({ error: "no_model", owlState: "error" });
        return;
      }
      const created = await sessions.createSession({
        model_ref: modelForNew,
        title: trimmed ? trimmed.slice(0, 24) : "새 대화",
      });
      sessionId = created.id;
    }
    // [END]

    const modelRef = currentModelForSend();
    if (!modelRef) {
      set({ error: "no_model", owlState: "error" });
      return;
    }

    // [START] First-message auto-title — replace placeholder with user-text
    // prefix so Recents shows something meaningful immediately (no sidecar hit).
    const liveBefore = useSessionsStore.getState().messages;
    if (liveBefore.length === 0 && trimmed) {
      const preview = trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
      await useSessionsStore.getState().renameSession(sessionId, preview);
    }
    // [END]

    // [START] Phase A — Convert file-kind attachments to stored-kind before persist.
    // This ensures DB row contains a reference (meta), not a lost File blob.
    let persistableAttachments: typeof attachments = attachments;
    if (attachments && attachments.length > 0) {
      persistableAttachments = await Promise.all(
        attachments.map(async (a) => {
          if (a.kind !== "file") return a;
          try {
            const meta = await saveAttachment(a.file);
            return { kind: "stored" as const, id: a.id, meta };
          } catch {
            // Save failed — fall back to url kind with previewDataUrl if available
            if (a.previewDataUrl) {
              return { kind: "url" as const, id: a.id, url: a.previewDataUrl };
            }
            return a;
          }
        }),
      );
    }
    // [END]

    // Persist the user turn first so message history survives refresh.
    await useSessionsStore.getState().appendMessage({
      session_id: sessionId,
      role: "user",
      content: trimmed,
      attachments: persistableAttachments ?? null,
    });

    // Create a placeholder assistant row; stream deltas will patch it.
    const assistant = await useSessionsStore.getState().appendMessage({
      session_id: sessionId,
      role: "assistant",
      content: "",
    });

    const abortController = new AbortController();
    set({
      streaming: true,
      owlState: "thinking",
      error: null,
      abortController,
    });

    const ports = useSidecarStore.getState().status.ports;
    let receivedAny = false;
    let accumulated = "";
    let flushScheduled = false;
    // [START] owl: track whether the current stream is inside a reasoning
    // block — starts true because the pre-loop owlState is "thinking" (gap
    // before first token). First delta reclassifies based on markers.
    let insideThink = true;
    // [END]
    // [START] repetition guard — some models (especially small / heavily
    // quantized ones) get stuck in line-level loops. We track the last
    // non-empty trimmed line and abort the stream once it repeats >=10
    // times in a row, appending a user-facing "model limit" note instead
    // of letting the assistant spam the same sentence forever.
    let lastProcessedNewlineIdx = -1;
    let lastNonEmptyLine = "";
    let repeatCount = 0;
    let repetitionDetected = false;
    const REPETITION_THRESHOLD = 10;
    // [END]

    // [START] rAF-batched patch — store.patchMessage does the in-memory swap;
    // DB UPDATE happens once at the end to avoid per-token SQLite churn.
    const flushNow = () => {
      flushScheduled = false;
      useSessionsStore.getState().patchMessage(assistant.id, accumulated);
    };
    const scheduleFlush = () => {
      if (flushScheduled) return;
      flushScheduled = true;
      requestAnimationFrame(flushNow);
    };
    // [END]

    try {
      const liveMessages = useSessionsStore
        .getState()
        .messages.filter((m) => m.id !== assistant.id);
      const wire = await Promise.all(liveMessages.map(messageToWire));

      // [START] Phase 6.4 — active model profile: persona + user honorific +
      // (optional) extra instructions get prepended to the system prompt.
      // Sampling overrides from the profile are applied just before streamChat
      // below. Profile system blocks merge into the same wire[0] system slot
      // as project context / MCP tools so there's exactly one system message.
      const activeProfile = useModelProfilesStore.getState().getActive();
      const globalHonorific = useChatSettingsStore.getState().user_honorific.trim();
      const effectiveHonorific =
        (activeProfile?.user_honorific?.trim() || globalHonorific).trim();
      const profileLines: string[] = [];
      if (activeProfile?.persona) profileLines.push(activeProfile.persona);
      if (effectiveHonorific) {
        profileLines.push(
          `사용자를 부를 때는 "${effectiveHonorific}"라고 해.`,
        );
      }
      if (activeProfile?.system_prompt_extra) {
        profileLines.push(activeProfile.system_prompt_extra);
      }
      // [START] Phase 6.4 — Plan mode reinforcement. When the tool approval
      // mode is 'plan' we prepend an explicit instruction telling the model
      // to describe its plan instead of running anything. Complements the
      // synthetic tool_result the dispatcher injects: some models were
      // trying to 'execute anyway' despite the stub result.
      try {
        // Lazy import to avoid a hard circular between stores.
        const { useToolModeStore: tms } = await import("./tool_mode");
        const currentMode = tms.getState().mode;
        if (currentMode === "plan") {
          profileLines.push(
            "⚠️ 지금은 Plan 모드야. 도구를 실제로 호출하거나 외부 작업을 실행하지 마. 대신 어떤 단계로 문제를 해결할지 계획만 글머리표로 제시해. 도구가 필요하면 '이런 도구를 이렇게 쓸 것'이라고 서술만 해.",
          );
        }
      } catch {
        /* ignore import failure — plan hint is best-effort */
      }
      // [END]
      const profileSystemPrompt = profileLines.join("\n\n");
      // [END]

      // [START] Phase 6.1 + 6.4 — prepend transient system message combining:
      //   1. active profile's persona / honorific / extra instructions
      //   2. project context (CLAUDE.md etc)
      //   3. per-session system_prompt (user-authored)
      // NOT persisted to DB — injected only at wire-build time.
      const effectiveContextPrompt = useProjectContextStore.getState().getEffectivePrompt();
      const sessions2 = useSessionsStore.getState();
      const sessForPrompt = sessions2.sessions.find((s) => s.id === sessionId);
      const sessionSystemPrompt = sessForPrompt?.system_prompt ?? null;
      const systemBlocks = [
        profileSystemPrompt || null,
        effectiveContextPrompt || null,
        sessionSystemPrompt || null,
      ].filter((b): b is string => !!b && b.length > 0);
      if (systemBlocks.length > 0) {
        wire.unshift({ role: "system", content: systemBlocks.join("\n\n") });
      }
      // [END]

      // [START] Phase 6.2c — inject MCP tool descriptions as transient system message.
      // Prepended before any project-context system block, concatenated with \n\n---\n\n.
      // Phase 6.4: OVO built-in tools (web_search etc.) always appear alongside
      // whatever MCP servers the user has configured.
      const allTools = [...BUILTIN_TOOLS, ...useMcpStore.getState().getAllTools()];
      if (allTools.length > 0) {
        const toolsPrompt = buildToolsSystemMessage(allTools);
        if (wire.length > 0 && wire[0].role === "system") {
          wire[0] = {
            role: "system",
            content: `${toolsPrompt}\n\n---\n\n${wire[0].content as string}`,
          };
        } else {
          wire.unshift({ role: "system", content: toolsPrompt });
        }
      }
      // [END]

      // [START] Phase 6.3 — wiki retrieval: FTS-match the latest user message
      // against the local wiki and inject top-N pages as part of the system
      // prompt. Budget-capped at ~4000 chars total to keep prompt tokens
      // reasonable; callers hitting the limit see a trimmed message block.
      try {
        const lastUser = [...liveMessages].reverse().find((m) => m.role === "user");
        if (lastUser) {
          const userText = typeof lastUser.content === "string"
            ? lastUser.content
            : String(lastUser.content ?? "");
          const query = userText.slice(0, 200);
          if (query.trim()) {
            const pages = await searchWikiPages(query, 3);
            if (pages.length > 0) {
              const WIKI_BUDGET = 4000;
              let used = 0;
              const sections: string[] = [];
              for (const p of pages) {
                const header = `### ${p.title}\n`;
                const remaining = WIKI_BUDGET - used - header.length;
                if (remaining <= 0) break;
                const body = p.content.length > remaining
                  ? `${p.content.slice(0, remaining)}…`
                  : p.content;
                sections.push(`${header}${body}`);
                used += header.length + body.length;
              }
              if (sections.length > 0) {
                const wikiPrompt =
                  `<project_wiki>\n${sections.join("\n\n---\n\n")}\n</project_wiki>`;
                if (wire.length > 0 && wire[0].role === "system") {
                  wire[0] = {
                    role: "system",
                    content: `${wire[0].content as string}\n\n---\n\n${wikiPrompt}`,
                  };
                } else {
                  wire.unshift({ role: "system", content: wikiPrompt });
                }
              }
            }
          }
        }
      } catch {
        /* FTS miss → skip silently, retrieval is best-effort */
      }
      // [END]

      let finalUsage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      } | null = null;

      // [START] model_perf — timing + token-count instrumentation.
      // deltaCount increments on every delta frame; mlx-lm streams one token
      // per frame so this matches the true generation_tokens even when the
      // sidecar's usage report is missing or incomplete.
      const ttftStart = performance.now();
      let firstTokenAt: number | null = null;
      let deltaCount = 0;
      // [END]

      // [START] Phase 6.2c — tool-use detection state
      let toolCallDetected: Awaited<ReturnType<typeof parseToolUseBlock>> = null;
      // [END]

      // [START] Phase 6.4 — per-request sampling parameters: profile overrides
      // take precedence over chat_settings, which in turn take precedence over
      // the sidecar defaults. Undefined values stay off the wire.
      const cs = useChatSettingsStore.getState();
      const ps = activeProfile?.sampling;
      const samplingParams: Partial<{
        temperature: number;
        top_p: number;
        repetition_penalty: number;
        max_tokens: number;
      }> = {};
      const pickTemp = ps?.temperature ?? cs.temperature;
      const pickTopP = ps?.top_p ?? cs.top_p;
      const pickRep = ps?.repetition_penalty ?? cs.repetition_penalty;
      const pickMax = ps?.max_tokens !== undefined ? ps.max_tokens : cs.max_tokens;
      if (typeof pickTemp === "number") samplingParams.temperature = pickTemp;
      if (typeof pickTopP === "number") samplingParams.top_p = pickTopP;
      if (typeof pickRep === "number" && pickRep > 1) samplingParams.repetition_penalty = pickRep;
      if (typeof pickMax === "number" && pickMax > 0) samplingParams.max_tokens = pickMax;
      // [END]

      for await (const frame of streamChat(
        { model: modelRef, messages: normalizeWire(wire), ...samplingParams },
        abortController.signal,
        ports,
      )) {
        if (frame.usage) {
          finalUsage = frame.usage;
          continue;
        }
        if (!frame.delta) continue;
        accumulated += frame.delta;
        deltaCount += 1;
        scheduleFlush();
        // [START] repetition guard — parse every newline completed by this
        // delta. Any non-empty trimmed line that matches the previous one
        // bumps a counter; REPETITION_THRESHOLD hits abort the stream.
        {
          let idx = accumulated.indexOf("\n", lastProcessedNewlineIdx + 1);
          while (idx !== -1) {
            const line = accumulated.substring(lastProcessedNewlineIdx + 1, idx).trim();
            lastProcessedNewlineIdx = idx;
            if (line.length > 0) {
              if (line === lastNonEmptyLine) {
                repeatCount += 1;
                if (repeatCount >= REPETITION_THRESHOLD) {
                  repetitionDetected = true;
                  break;
                }
              } else {
                lastNonEmptyLine = line;
                repeatCount = 1;
              }
            }
            idx = accumulated.indexOf("\n", lastProcessedNewlineIdx + 1);
          }
        }
        if (repetitionDetected) {
          abortController.abort();
          break;
        }
        // [END]
        // [START] owl state transition — scan accumulated tail for reasoning
        // tags. First delta decides between "thinking" (explicit <think> in
        // the first chunk) and "typing" (everything else); later deltas only
        // flip when markers actually move. Keeps the owl animation in sync
        // with whether the model is reasoning or writing visible output.
        const trans = detectThinkTransition(accumulated);
        let target: boolean;
        if (!receivedAny) {
          receivedAny = true;
          // [START] model_perf — capture first-token timestamp
          firstTokenAt = performance.now();
          // [END]
          // First-delta decision: non-reasoning models have no markers → typing
          target = trans ?? false;
        } else {
          // Subsequent deltas: hold state when no markers appear in the tail
          // window, so long reasoning blocks (>500 chars) keep "thinking"
          // until </think> actually shows up.
          target = trans ?? insideThink;
        }
        if (target !== insideThink) {
          insideThink = target;
          set({ owlState: insideThink ? "thinking" : "typing" });
        }
        // [END]

        // [START] Phase 6.2c — check for complete tool_use block after each delta
        const parsed = parseToolUseBlock(accumulated);
        if (parsed !== null) {
          toolCallDetected = parsed;
          abortController.abort();
          break;
        }
        // [END]
      }
      flushNow();

      // [START] repetition guard — if the stream was killed because the
      // model looped on the same line, append a user-facing limit notice
      // instead of leaving the repeated text dangling. Returns early so
      // the normal "happy → sound → compact" finalization is skipped.
      if (repetitionDetected) {
        const notice = `\n\n---\n\n_${i18n.t("chat.repeat_limit")}_`;
        accumulated += notice;
        useSessionsStore.getState().patchMessage(assistant.id, accumulated);
        await updateMessageContent(assistant.id, accumulated);
        set({ streaming: false, owlState: "idle", abortController: null });
        drainQueue();
        return;
      }
      // [END]

      // [START] Phase 6.2c — handle tool call if detected
      if (toolCallDetected !== null) {
        const call = toolCallDetected;

        // Strip the raw <tool_use>…</tool_use> block from the visible assistant text
        const visibleText = accumulated.replace(call.raw, "").trim();
        // Persist assistant message without the tool_use block
        await updateMessageContent(assistant.id, visibleText);

        // Recursion guard
        if (toolLoopDepth >= 5) {
          useToastsStore.getState().push({
            kind: "error",
            message: "Tool loop broken (max 5 iterations)",
          });
          set({ streaming: false, owlState: "idle", abortController: null });
          drainQueue();
          return;
        }

        // Resolve dispatch target — built-in (OVO-hosted) tools bypass the
        // MCP pool entirely and hit /ovo/* endpoints directly.
        const isBuiltin = isBuiltinTool(call.name);
        const serverId = isBuiltin ? null : resolveServerId(call.name);
        const runTool = async (): Promise<unknown> => {
          if (isBuiltin) return await dispatchBuiltin(call.name, call.arguments);
          if (serverId === null) throw new Error(`Tool not found: ${call.name}`);
          return await mcpCall(serverId, call.name, call.arguments);
        };
        let resultJson: string;
        // [START] Tool-approval mode — plan / ask / bypass (default bypass)
        const { useToolModeStore } = await import("./tool_mode");
        const mode = useToolModeStore.getState().mode;
        if (mode === "plan") {
          // Don't run; give the model a synthetic "plan-only" result so it
          // keeps reasoning as if the tool had returned a success stub.
          resultJson = JSON.stringify({
            plan_only: true,
            note: `Tool '${call.name}' was not executed (plan mode).`,
          });
        } else if (!isBuiltin && serverId === null) {
          resultJson = JSON.stringify({ error: `Tool not found: ${call.name}` });
        } else if (mode === "ask") {
          // Minimal approval UX — confirm dialog. The Claude-parity richer UI
          // (approve / deny / always allow card in the chat stream) lands
          // in a follow-up.
          const approved = window.confirm(
            `🔧 ${call.name}\n\n${JSON.stringify(call.arguments, null, 2)}\n\n도구 실행을 허용할까?`,
          );
          if (!approved) {
            resultJson = JSON.stringify({ error: "User denied tool call." });
          } else {
            try {
              resultJson = JSON.stringify(await runTool());
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              resultJson = JSON.stringify({ error: errMsg });
            }
          }
        } else {
          // bypass — execute immediately
          try {
            resultJson = JSON.stringify(await runTool());
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            resultJson = JSON.stringify({ error: errMsg });
          }
        }
        // [END]

        // Append tool_result as a user-role message (transient — no content to show except for context)
        await useSessionsStore.getState().appendMessage({
          session_id: sessionId,
          role: "user",
          content: `<tool_result>${resultJson}</tool_result>`,
          attachments: null,
        });

        // Recurse — model sees the result and continues
        set({ streaming: false, owlState: "idle", abortController: null });
        await _sendOne("", undefined, toolLoopDepth + 1);
        return;
      }
      // [END]

      // [START] Persist final content + usage to SQLite + session totals.
      await updateMessageContent(assistant.id, accumulated, {
        prompt_tokens: finalUsage?.prompt_tokens ?? null,
        generation_tokens: finalUsage?.completion_tokens ?? null,
      });
      if (finalUsage) {
        await useSessionsStore
          .getState()
          .setSessionContextTokens(sessionId, finalUsage.total_tokens);
        // [START] non-blocking auto-compact check — fire-and-forget; UI reflects
        // compacting flag if it kicks in (ChatPane blocks input during compact).
        void maybeAutoCompact(sessionId);
        // [END]
      }

      // [START] model_perf — record on every successful stream end.
      // Token count priority (most → least accurate):
      //   1. finalUsage.completion_tokens — exact count from sidecar tokenizer
      //   2. deltaCount — mlx-lm streams 1 token per frame, so the number of
      //      delta frames equals the true generation token count
      //   3. accumulated.length / 4 — last-resort OpenAI-style heuristic
      //      (under-counts Korean; only used if both signals above fail)
      if (firstTokenAt !== null) {
        const ttft_ms = firstTokenAt - ttftStart;
        const gen_ms = performance.now() - firstTokenAt;
        const reportedGen = finalUsage?.completion_tokens ?? 0;
        const gen_tokens =
          reportedGen > 0
            ? reportedGen
            : deltaCount > 0
              ? deltaCount
              : Math.max(1, Math.round(accumulated.length / 4));
        useModelPerfStore.getState().record(modelRef, {
          ttft_ms,
          gen_tokens,
          gen_ms,
          prompt_tokens: finalUsage?.prompt_tokens ?? 0,
          recorded_at: Date.now(),
        });
      }
      // [END]
      // [END]

      set({ streaming: false, owlState: "happy", abortController: null });
      // [START] Reply-complete sound (owl hoot). Best-effort — silent on
      // autoplay-policy rejection or missing audio asset.
      if (useChatSettingsStore.getState().sound_enabled) {
        try {
          const audio = new Audio("/owl-hoot.mp3");
          audio.volume = 0.6;
          void audio.play().catch(() => {
            /* autoplay blocked — ignore */
          });
        } catch {
          /* Audio API unavailable — ignore */
        }
      }
      // [END]
      setTimeout(() => {
        if (!get().streaming) set({ owlState: "idle" });
      }, 1800);
    } catch (e) {
      flushNow();
      // persist whatever partial content was captured
      try {
        await updateMessageContent(assistant.id, accumulated);
      } catch {
        /* ignore */
      }
      const aborted = abortController.signal.aborted;
      set({
        streaming: false,
        abortController: null,
        owlState: aborted ? "idle" : "error",
        error: aborted ? null : e instanceof Error ? e.message : String(e),
      });
      if (!aborted) {
        setTimeout(() => {
          if (get().owlState === "error") set({ owlState: "idle" });
        }, 2400);
      }
    } finally {
      // [START] Queue drain — after each _sendOne completes (success or error),
      // check if there are queued items and run the next one if not already draining.
      drainQueue();
      // [END]
    }
  }
  // [END]

  // [START] drainQueue — dequeues and sends the next pending item if any.
  // Guard against concurrent drains: isDraining flag is set while running.
  function drainQueue(): void {
    const state = get();
    if (state.isDraining) return;
    if (state.queue.length === 0) return;
    const [next, ...rest] = state.queue;
    set({ queue: rest, isDraining: true });
    void _sendOne(next.content, next.attachments).finally(() => {
      set({ isDraining: false });
    });
  }
  // [END]

  return {
    streaming: false,
    owlState: "idle",
    error: null,
    abortController: null,
    queue: [],
    isDraining: false,

    // [START] sendMessage — mode-aware dispatch wrapping _sendOne.
    // Reads streaming_send_mode from chat_settings to decide behavior.
    sendMessage: async (content, attachments) => {
      const trimmed = content.trim();
      const hasAttachments = (attachments?.length ?? 0) > 0;
      if (!trimmed && !hasAttachments) return;

      const { streaming } = get();
      const mode = useChatSettingsStore.getState().streaming_send_mode;

      if (!streaming) {
        // Not streaming — always send immediately regardless of mode
        await _sendOne(content, attachments);
        return;
      }

      if (mode === "block") {
        // block mode: discard the send attempt (textarea is disabled anyway)
        return;
      }

      if (mode === "queue") {
        // queue mode: enqueue and wait for current stream to finish
        set((s) => ({ queue: [...s.queue, { content, attachments }] }));
        return;
      }

      if (mode === "interrupt") {
        // interrupt mode: abort current stream then send
        get().stopStreaming();
        // Poll until streaming === false (max 2s, 50ms steps)
        await new Promise<void>((resolve) => {
          const deadline = Date.now() + 2000;
          const poll = () => {
            if (!get().streaming || Date.now() >= deadline) {
              resolve();
            } else {
              setTimeout(poll, 50);
            }
          };
          poll();
        });
        await _sendOne(content, attachments);
      }
    },
    // [END]

    stopStreaming: () => {
      const { abortController } = get();
      if (abortController) abortController.abort();
    },

    clearQueue: () => {
      set({ queue: [] });
    },
  };
});
