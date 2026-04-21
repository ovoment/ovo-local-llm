// [START] PingpongPane — two named models with personas talk to each other.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftRight, ArrowRight, ArrowLeft, Play, Square, Send, Loader2, User, Trash2,
} from "lucide-react";
import { useSidecarStore } from "../store/sidecar";
import { useToastsStore } from "../store/toasts";
import { listModels, streamChat, type ChatWireMessage } from "../lib/api";
import { isChatCapableModel } from "../lib/models";
import type { OvoModel } from "../types/ovo";

interface ModelSlot {
  repoId: string;
  name: string;
  persona: string;
  messages: ChatWireMessage[];
}

function defaultSlot(): ModelSlot {
  return { repoId: "", name: "", persona: "", messages: [] };
}

interface DisplayMessage {
  speaker: string;
  role: "user" | "assistant";
  content: string;
  side?: "left" | "right";
}

export function PingpongPane() {
  const { t } = useTranslation();
  const ports = useSidecarStore((s) => s.status.ports);
  const health = useSidecarStore((s) => s.status.health);

  const [models, setModels] = useState<OvoModel[]>([]);
  const [left, setLeft] = useState<ModelSlot>(defaultSlot);
  const [right, setRight] = useState<ModelSlot>(defaultSlot);
  const [timeline, setTimeline] = useState<DisplayMessage[]>([]);
  const [userInput, setUserInput] = useState("");
  const [autoMode, setAutoMode] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingSide, setStreamingSide] = useState<"left" | "right" | null>(null);
  const [streamingText, setStreamingText] = useState("");

  const autoRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (health !== "healthy") return;
    void listModels(ports).then((r) => setModels(r.models.filter(isChatCapableModel))).catch(() => {});
  }, [health, ports]);

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timeline, streamingText]);

  const stopAll = () => {
    autoRef.current = false;
    setAutoMode(false);
    abortRef.current?.abort();
    setStreaming(false);
    setStreamingSide(null);
    setStreamingText("");
  };

  const buildSystemPrompt = (slot: ModelSlot, otherSlot: ModelSlot): string => {
    const parts: string[] = [];
    if (slot.persona) {
      parts.push(`You are ${slot.name || "an AI"}. ${slot.persona}`);
    } else if (slot.name) {
      parts.push(`You are ${slot.name}.`);
    }
    if (otherSlot.name) {
      parts.push(`You are having a conversation with ${otherSlot.name}${otherSlot.persona ? ` (${otherSlot.persona})` : ""}.`);
    }
    parts.push("Respond naturally. The user may also join the conversation at any time.");
    return parts.join(" ");
  };

  const generateResponse = async (
    targetSide: "left" | "right",
  ): Promise<string> => {
    const slot = targetSide === "left" ? left : right;
    const otherSlot = targetSide === "left" ? right : left;
    if (!slot.repoId) throw new Error("No model selected");

    const sysPrompt = buildSystemPrompt(slot, otherSlot);
    const msgs: ChatWireMessage[] = [
      { role: "system", content: sysPrompt },
      ...slot.messages,
    ];

    setStreaming(true);
    setStreamingSide(targetSide);
    setStreamingText("");
    abortRef.current = new AbortController();

    let full = "";
    try {
      for await (const chunk of streamChat(
        { model: slot.repoId, messages: msgs, max_tokens: 2048 },
        abortRef.current.signal,
        ports,
      )) {
        if (chunk.delta) {
          full += chunk.delta;
          setStreamingText(full);
        }
      }
    } finally {
      setStreaming(false);
      setStreamingSide(null);
      setStreamingText("");
    }

    if (full) {
      const assistantMsg: ChatWireMessage = { role: "assistant", content: full };
      const setter = targetSide === "left" ? setLeft : setRight;
      setter((prev) => ({ ...prev, messages: [...prev.messages, assistantMsg] }));

      const speakerName = slot.name || slot.repoId.split("/").pop() || targetSide;
      setTimeline((prev) => [...prev, {
        speaker: speakerName,
        role: "assistant",
        content: full,
        side: targetSide,
      }]);
    }
    return full;
  };

  const pushToSide = async (from: "left" | "right") => {
    const source = from === "left" ? left : right;
    const targetSide = from === "left" ? "right" : "left";
    const target = from === "left" ? right : left;

    if (!source.messages.length || !target.repoId) return;
    const lastMsg = source.messages[source.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;

    const sourceName = source.name || source.repoId.split("/").pop() || from;
    const relayMsg: ChatWireMessage = {
      role: "user",
      content: `[${sourceName}]: ${lastMsg.content as string}`,
    };

    const setter = targetSide === "left" ? setLeft : setRight;
    setter((prev) => ({ ...prev, messages: [...prev.messages, relayMsg] }));
    await generateResponse(targetSide);
  };

  const startAuto = async () => {
    if (!left.repoId || !right.repoId) return;
    autoRef.current = true;
    setAutoMode(true);

    try {
      while (autoRef.current) {
        await pushToSide("left");
        if (!autoRef.current) break;
        await pushToSide("right");
        if (!autoRef.current) break;
      }
    } catch {
      // cancelled
    } finally {
      autoRef.current = false;
      setAutoMode(false);
    }
  };

  const sendUserMessage = async () => {
    const text = userInput.trim();
    if (!text) return;
    setUserInput("");

    const userMsg: ChatWireMessage = { role: "user", content: text };
    setLeft((prev) => ({ ...prev, messages: [...prev.messages, userMsg] }));
    setRight((prev) => ({ ...prev, messages: [...prev.messages, userMsg] }));

    setTimeline((prev) => [...prev, {
      speaker: t("pingpong.you"),
      role: "user",
      content: text,
    }]);

    if (left.repoId) await generateResponse("left");
    if (right.repoId) await generateResponse("right");
  };

  const clearAll = () => {
    stopAll();
    setLeft((prev) => ({ ...prev, messages: [] }));
    setRight((prev) => ({ ...prev, messages: [] }));
    setTimeline([]);
  };

  if (health !== "healthy") {
    return (
      <div className="h-full flex items-center justify-center text-sm text-ovo-muted">
        {t(`sidecar.status.${health}`)}…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col p-4 gap-3">
      {/* Header */}
      <header className="flex items-center gap-2">
        <ArrowLeftRight className="w-5 h-5 text-ovo-accent" />
        <h2 className="text-lg font-semibold text-ovo-text">{t("pingpong.title")}</h2>
        <span className="text-xs text-ovo-muted ml-auto">{t("pingpong.subtitle")}</span>
      </header>

      {/* Model selectors with name + persona */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start">
        {/* Left slot */}
        <div className="space-y-1.5">
          <select
            value={left.repoId}
            onChange={(e) => setLeft((prev) => ({
              ...prev,
              repoId: e.target.value,
              name: prev.name || e.target.value.split("/").pop() || "",
            }))}
            className="w-full px-2.5 py-1.5 rounded-lg bg-ovo-surface border border-ovo-border text-xs text-ovo-text focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          >
            <option value="">{t("pingpong.select_model")}</option>
            {models.map((m) => (
              <option key={m.repo_id} value={m.repo_id}>{m.repo_id.split("/").pop()}</option>
            ))}
          </select>
          <input
            type="text"
            value={left.name}
            onChange={(e) => setLeft((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={t("pingpong.name_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-xs text-ovo-accent font-semibold focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          />
          <input
            type="text"
            value={left.persona}
            onChange={(e) => setLeft((prev) => ({ ...prev, persona: e.target.value }))}
            placeholder={t("pingpong.persona_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-[11px] text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          />
        </div>

        {/* VS badge */}
        <div className="flex items-center justify-center pt-2">
          <span className="text-xs font-bold text-ovo-muted">VS</span>
        </div>

        {/* Right slot */}
        <div className="space-y-1.5">
          <select
            value={right.repoId}
            onChange={(e) => setRight((prev) => ({
              ...prev,
              repoId: e.target.value,
              name: prev.name || e.target.value.split("/").pop() || "",
            }))}
            className="w-full px-2.5 py-1.5 rounded-lg bg-ovo-surface border border-ovo-border text-xs text-ovo-text focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          >
            <option value="">{t("pingpong.select_model")}</option>
            {models.map((m) => (
              <option key={m.repo_id} value={m.repo_id}>{m.repo_id.split("/").pop()}</option>
            ))}
          </select>
          <input
            type="text"
            value={right.name}
            onChange={(e) => setRight((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={t("pingpong.name_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-xs text-ovo-accent font-semibold focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          />
          <input
            type="text"
            value={right.persona}
            onChange={(e) => setRight((prev) => ({ ...prev, persona: e.target.value }))}
            placeholder={t("pingpong.persona_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-[11px] text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          />
        </div>
      </div>

      {/* Conversation timeline + side controls */}
      <div className="flex-1 flex gap-2 min-h-0">
        {/* Timeline */}
        <div className="flex-1 rounded-xl bg-ovo-surface border border-ovo-border overflow-y-auto p-4 space-y-3 min-h-0">
          {timeline.length === 0 && !streaming && (
            <div className="flex items-center justify-center h-full text-sm text-ovo-muted">
              {t("pingpong.empty")}
            </div>
          )}
          {timeline.map((msg, i) => (
            <div key={i} className={`flex gap-2 ${msg.role === "user" ? "justify-center" : msg.side === "left" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[75%] rounded-lg px-3 py-2 text-xs ${
                msg.role === "user"
                  ? "bg-sky-500/10 border border-sky-500/30 text-center"
                  : msg.side === "left"
                    ? "bg-ovo-accent/10 border border-ovo-accent/20"
                    : "bg-emerald-500/10 border border-emerald-500/20"
              }`}>
                <div className={`font-semibold text-[11px] mb-1 ${
                  msg.role === "user" ? "text-sky-400" : msg.side === "left" ? "text-ovo-accent" : "text-emerald-400"
                }`}>
                  {msg.speaker}
                </div>
                <div className="whitespace-pre-wrap text-ovo-text leading-relaxed">{msg.content}</div>
              </div>
            </div>
          ))}
          {/* Streaming indicator */}
          {streaming && streamingText && (
            <div className={`flex gap-2 ${streamingSide === "left" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[75%] rounded-lg px-3 py-2 text-xs ${
                streamingSide === "left"
                  ? "bg-ovo-accent/10 border border-ovo-accent/20"
                  : "bg-emerald-500/10 border border-emerald-500/20"
              }`}>
                <div className={`font-semibold text-[11px] mb-1 flex items-center gap-1 ${
                  streamingSide === "left" ? "text-ovo-accent" : "text-emerald-400"
                }`}>
                  {streamingSide === "left" ? (left.name || "Left") : (right.name || "Right")}
                  <Loader2 className="w-3 h-3 animate-spin" />
                </div>
                <div className="whitespace-pre-wrap text-ovo-text leading-relaxed">{streamingText}</div>
              </div>
            </div>
          )}
          <div ref={timelineEndRef} />
        </div>

        {/* Control buttons */}
        <div className="flex flex-col items-center justify-center gap-2 shrink-0">
          <button
            type="button"
            disabled={streaming || !left.messages.length || !right.repoId}
            onClick={() => void pushToSide("left")}
            className="p-2 rounded-lg bg-ovo-surface border border-ovo-border text-ovo-muted hover:text-ovo-accent transition disabled:opacity-30"
            title={t("pingpong.push_right")}
          >
            <ArrowRight className="w-4 h-4" />
          </button>

          {autoMode ? (
            <button
              type="button"
              onClick={stopAll}
              className="p-2 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-400 hover:brightness-110 transition"
              title={t("pingpong.stop")}
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              type="button"
              disabled={streaming || !left.repoId || !right.repoId || timeline.length === 0}
              onClick={() => void startAuto()}
              className="p-2 rounded-lg bg-ovo-accent/20 border border-ovo-accent/40 text-ovo-accent hover:brightness-110 transition disabled:opacity-30"
              title={t("pingpong.auto")}
            >
              <Play className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            disabled={streaming || !right.messages.length || !left.repoId}
            onClick={() => void pushToSide("right")}
            className="p-2 rounded-lg bg-ovo-surface border border-ovo-border text-ovo-muted hover:text-ovo-accent transition disabled:opacity-30"
            title={t("pingpong.push_left")}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

          <div className="border-t border-ovo-border w-6 my-1" />

          <button
            type="button"
            onClick={clearAll}
            disabled={streaming}
            className="p-2 rounded-lg bg-ovo-surface border border-ovo-border text-ovo-muted hover:text-rose-500 transition disabled:opacity-30"
            title={t("pingpong.clear")}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* User input */}
      <div className="flex gap-2">
        <div className="flex items-center gap-1.5 text-sky-400 shrink-0">
          <User className="w-4 h-4" />
        </div>
        <input
          type="text"
          value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendUserMessage();
            }
          }}
          placeholder={t("pingpong.user_placeholder")}
          disabled={streaming || (!left.repoId && !right.repoId)}
          className="flex-1 px-3 py-2.5 rounded-lg bg-ovo-surface border border-ovo-border text-sm text-ovo-text placeholder:text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent disabled:opacity-40"
        />
        <button
          disabled={!userInput.trim() || streaming}
          onClick={() => void sendUserMessage()}
          className="px-4 py-2.5 rounded-lg bg-ovo-accent text-white disabled:opacity-40 hover:brightness-110 transition"
        >
          <Send className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
// [END]
