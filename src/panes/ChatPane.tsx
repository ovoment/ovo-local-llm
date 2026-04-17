import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { listModels } from "../lib/api";
import { useSidecarStore } from "../store/sidecar";
import { useChatStore } from "../store/chat";
import { useSessionsStore } from "../store/sessions";
import { useChatSettingsStore } from "../store/chat_settings";
import { ModelSelector } from "../components/ModelSelector";
import { ChatInput } from "../components/ChatInput";
import { ChatMessageBubble } from "../components/ChatMessageBubble";
import { Owl } from "../components/Owl";
import type { OvoModel } from "../types/ovo";

export function ChatPane() {
  const { t } = useTranslation();
  const status = useSidecarStore((s) => s.status);

  const streaming = useChatStore((s) => s.streaming);
  const owlState = useChatStore((s) => s.owlState);
  const error = useChatStore((s) => s.error);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  // [START] queue count + streaming send mode for ChatInput
  const queueCount = useChatStore((s) => s.queue.length);
  const streamingSendMode = useChatSettingsStore((s) => s.streaming_send_mode);
  // [END]

  const sessions = useSessionsStore((s) => s.sessions);
  const currentSessionId = useSessionsStore((s) => s.currentSessionId);
  const messages = useSessionsStore((s) => s.messages);
  const loadSessions = useSessionsStore((s) => s.loadSessions);
  const selectSession = useSessionsStore((s) => s.selectSession);
  const clearCurrentMessages = useSessionsStore((s) => s.clearCurrentMessages);
  const setSessionModel = useSessionsStore((s) => s.setSessionModel);

  const currentSession = sessions.find((s) => s.id === currentSessionId) ?? null;
  const currentModel = currentSession?.model_ref ?? null;
  // [START] compacting flag — blocks ChatInput while auto-compact is running (R.5)
  const compacting = currentSession?.compacting ?? false;
  // [END]

  const [models, setModels] = useState<OvoModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // [START] Load sessions once at mount; side-effect-free if already loaded.
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);
  // [END]

  useEffect(() => {
    if (status.health !== "healthy") return;
    let cancelled = false;
    listModels(status.ports)
      .then((resp) => {
        if (cancelled) return;
        setModels(resp.models);
        setModelsError(null);
        // [START] Lazy default model — if no current session yet, remember the
        // first model so the "lazy create session" path on first send picks it.
        if (!currentModel && resp.models.length > 0 && currentSessionId) {
          void setSessionModel(currentSessionId, resp.models[0].repo_id);
        }
        // [END]
      })
      .catch((e: unknown) => {
        if (!cancelled) setModelsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [status.health, status.ports, currentModel, currentSessionId, setSessionModel]);

  // Stick to bottom only if user hasn't scrolled up; rAF-scheduled single write per frame.
  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickToBottom.current) return;
    let raf = 0;
    raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, streaming]);

  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottom.current = distanceFromBottom < 64;
  };

  // [START] Phantom selection fallback — when no session exists yet but user
  // is about to type, show the first available model so the lazy-create path
  // on first send has something to use.
  const phantomModel =
    !currentSessionId && models.length > 0 ? models[0].repo_id : null;
  const effectiveModel = currentModel ?? phantomModel;

  const handleModelChange = async (modelRef: string | null) => {
    if (!currentSessionId) {
      // no session yet — we can't persist; remember via phantom by creating
      // a session immediately (empty title) so selection sticks.
      if (!modelRef) return;
      const { createSession } = useSessionsStore.getState();
      await createSession({ model_ref: modelRef });
      return;
    }
    await setSessionModel(currentSessionId, modelRef);
  };
  // [END]

  const sidecarReady = status.health === "healthy";
  const hasMessages = messages.length > 0;
  // [START] inputDisabled — block mode also disables during streaming; queue/interrupt keep it open
  const inputDisabled = !sidecarReady || !effectiveModel || compacting || (streaming && streamingSendMode === "block");
  const allowTypeDuringStreaming = streamingSendMode !== "block";
  // [END]

  // Ignore selectSession passthrough until the Recents sidebar is added in R.3.
  void selectSession;

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-2 border-b border-[#E8CFBB] bg-white/40">
        <ModelSelector
          models={models}
          value={effectiveModel}
          onChange={(m) => void handleModelChange(m)}
          disabled={!sidecarReady}
        />
        <div className="flex items-center gap-3">
          <Owl state={owlState} size="xs" />
          {hasMessages && (
            <button
              type="button"
              onClick={() => void clearCurrentMessages()}
              disabled={streaming}
              className="p-1.5 rounded-md text-[#8B4432] hover:bg-white/60 disabled:opacity-40 disabled:cursor-not-allowed transition"
              aria-label={t("chat.clear")}
              title={t("chat.clear")}
            >
              <Trash2 className="w-4 h-4" aria-hidden />
            </button>
          )}
        </div>
      </header>

      <div
        ref={listRef}
        onScroll={onListScroll}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {!sidecarReady ? (
          <div className="h-full flex items-center justify-center text-sm text-[#8B4432]">
            {t(`sidecar.status.${status.health}`)}…
          </div>
        ) : modelsError ? (
          <div className="h-full flex items-center justify-center text-sm text-rose-600">
            {t("chat.error_prefix")}: {modelsError}
          </div>
        ) : !hasMessages ? (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-[#8B4432]">
            <Owl state="idle" size="lg" />
            <p className="text-sm">{t("chat.empty")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 max-w-3xl mx-auto w-full">
            {messages.map((m, i) => (
              <ChatMessageBubble
                key={m.id}
                message={m}
                streaming={streaming && i === messages.length - 1}
              />
            ))}
          </div>
        )}
      </div>

      {error && error !== "no_model" && (
        <div className="px-4 py-2 text-xs text-rose-700 bg-rose-50 border-t border-rose-200">
          {t("chat.error_prefix")}: {error}
        </div>
      )}
      {error === "no_model" && (
        <div className="px-4 py-2 text-xs text-[#8B4432] bg-[#FAF3E7] border-t border-[#E8CFBB]">
          {t("chat.no_model")}
        </div>
      )}
      {compacting && (
        <div className="px-4 py-2 text-xs text-[#8B4432] bg-[#FAF3E7] border-t border-[#E8CFBB] flex items-center gap-2">
          <span className="inline-flex gap-0.5" aria-hidden>
            <span className="w-1 h-1 rounded-full bg-[#8B4432] animate-bounce [animation-delay:-0.3s]" />
            <span className="w-1 h-1 rounded-full bg-[#8B4432] animate-bounce [animation-delay:-0.15s]" />
            <span className="w-1 h-1 rounded-full bg-[#8B4432] animate-bounce" />
          </span>
          {t("compact.in_progress")}
        </div>
      )}

      <ChatInput
        onSend={(text, attachments) => void sendMessage(text, attachments)}
        onStop={stopStreaming}
        streaming={streaming}
        disabled={inputDisabled}
        allowTypeDuringStreaming={allowTypeDuringStreaming}
        queueCount={queueCount}
      />
    </div>
  );
}
