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

// [START] Attachment → OpenAI content-parts conversion.
// Files are base64'd via FileReader; previewDataUrl is reused when already computed
// for the image preview to avoid a redundant read. URL attachments pass through
// as image_url parts (server decides whether to fetch). Non-image files are
// skipped — VLMs only accept images today, and forwarding e.g. a PDF as an image
// URL would just trigger a PIL failure server-side.
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

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
    if (!a.file.type.startsWith("image/")) continue;
    const url = a.previewDataUrl ?? (await fileToDataUrl(a.file));
    if (url) parts.push({ type: "image_url", image_url: { url } });
  }
  const hasImage = parts.some((p) => p.type === "image_url");
  return { role, content: hasImage ? parts : m.content };
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

    // Persist the user turn first so message history survives refresh.
    await useSessionsStore.getState().appendMessage({
      session_id: sessionId,
      role: "user",
      content: trimmed,
      attachments: attachments ?? null,
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

      let finalUsage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      } | null = null;

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
          set({ owlState: "typing" });
        }
        accumulated += frame.delta;
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
      // [END]

      set({ streaming: false, owlState: "happy", abortController: null });
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
