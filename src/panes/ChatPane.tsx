import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { listModels } from "../lib/api";
import { useSidecarStore } from "../store/sidecar";
import { useChatStore } from "../store/chat";
import { ModelSelector } from "../components/ModelSelector";
import { ChatInput } from "../components/ChatInput";
import { ChatMessageBubble } from "../components/ChatMessageBubble";
import { Owl } from "../components/Owl";
import type { OvoModel } from "../types/ovo";

export function ChatPane() {
  const { t } = useTranslation();
  const status = useSidecarStore((s) => s.status);

  const messages = useChatStore((s) => s.messages);
  const currentModel = useChatStore((s) => s.currentModel);
  const streaming = useChatStore((s) => s.streaming);
  const owlState = useChatStore((s) => s.owlState);
  const error = useChatStore((s) => s.error);
  const setCurrentModel = useChatStore((s) => s.setCurrentModel);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const clearConversation = useChatStore((s) => s.clearConversation);

  const [models, setModels] = useState<OvoModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (status.health !== "healthy") return;
    let cancelled = false;
    listModels(status.ports)
      .then((resp) => {
        if (cancelled) return;
        setModels(resp.models);
        setModelsError(null);
        if (!currentModel && resp.models.length > 0) {
          setCurrentModel(resp.models[0].repo_id);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setModelsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [status.health, status.ports, currentModel, setCurrentModel]);

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

  const sidecarReady = status.health === "healthy";
  const hasMessages = messages.length > 0;
  const inputDisabled = !sidecarReady || !currentModel;

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between gap-3 px-4 py-2 border-b border-[#E8CFBB] bg-white/40">
        <ModelSelector
          models={models}
          value={currentModel}
          onChange={setCurrentModel}
          disabled={!sidecarReady}
        />
        <div className="flex items-center gap-3">
          <Owl state={owlState} size="xs" />
          {hasMessages && (
            <button
              type="button"
              onClick={clearConversation}
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
                key={i}
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

      <ChatInput
        onSend={(text, attachments) => void sendMessage(text, attachments)}
        onStop={stopStreaming}
        streaming={streaming}
        disabled={inputDisabled}
      />
    </div>
  );
}
