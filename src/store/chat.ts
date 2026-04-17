import { create } from "zustand";
import {
  streamChat,
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
// [START] model_perf — import performance tracking store
import { useModelPerfStore } from "./model_perf";
// [END]
// [START] Phase A — attachment persistence helpers
import { saveAttachment, readAttachmentAsDataUrl } from "../lib/attachmentStorage";
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

export const useChatStore = create<ChatStoreState>((set, get) => {
  // [START] _sendOne — actual single-turn execution; sendMessage wraps this
  // with mode-aware dispatch logic.
  async function _sendOne(content: string, attachments?: ChatAttachment[]): Promise<void> {
    const trimmed = content.trim();
    const hasAttachments = (attachments?.length ?? 0) > 0;
    if (!trimmed && !hasAttachments) return;

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

      // [START] Phase 6.1 — prepend project context as transient system message.
      // NOT persisted to DB — injected only at wire-build time.
      const effectiveContextPrompt = useProjectContextStore.getState().getEffectivePrompt();
      if (effectiveContextPrompt) {
        const sessions2 = useSessionsStore.getState();
        const sess = sessions2.sessions.find((s) => s.id === sessionId);
        const sessionSystemPrompt = sess?.system_prompt ?? null;
        const combinedSystem = sessionSystemPrompt
          ? `${effectiveContextPrompt}\n\n${sessionSystemPrompt}`
          : effectiveContextPrompt;
        wire.unshift({ role: "system", content: combinedSystem });
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

      for await (const frame of streamChat(
        { model: modelRef, messages: wire },
        abortController.signal,
        ports,
      )) {
        if (frame.usage) {
          finalUsage = frame.usage;
          continue;
        }
        if (!frame.delta) continue;
        if (!receivedAny) {
          receivedAny = true;
          // [START] model_perf — capture first-token timestamp
          firstTokenAt = performance.now();
          // [END]
          set({ owlState: "typing" });
        }
        accumulated += frame.delta;
        deltaCount += 1;
        scheduleFlush();
      }
      flushNow();

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
