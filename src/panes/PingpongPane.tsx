// [START] PingpongPane — two named models with personas, history, @targeting, attachments.
import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftRight, ArrowRight, ArrowLeft, Play, Square, Send,
  Loader2, User, Trash2, History,
} from "lucide-react";
import { useSidecarStore } from "../store/sidecar";
import { useToastsStore } from "../store/toasts";
import { listModels, streamChat, cleanModelOutput, type ChatWireMessage } from "../lib/api";
import { isChatCapableModel } from "../lib/models";
import {
  createPingpongSession, listPingpongSessions, deletePingpongSession,
  addPingpongMessage, loadPingpongMessages,
  type PingpongSession,
} from "../db/pingpong";
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
  side: "left" | "right" | "user";
}

export function PingpongPane() {
  const { t } = useTranslation();
  const ports = useSidecarStore((s) => s.status.ports);
  const health = useSidecarStore((s) => s.status.health);

  const [models, setModels] = useState<OvoModel[]>([]);
  const [left, setLeft] = useState<ModelSlot>(() => {
    try {
      const saved = localStorage.getItem("ovo:pp:left");
      return saved ? { ...defaultSlot(), ...JSON.parse(saved) } : defaultSlot();
    } catch { return defaultSlot(); }
  });
  const [right, setRight] = useState<ModelSlot>(() => {
    try {
      const saved = localStorage.getItem("ovo:pp:right");
      return saved ? { ...defaultSlot(), ...JSON.parse(saved) } : defaultSlot();
    } catch { return defaultSlot(); }
  });
  const [timeline, setTimeline] = useState<DisplayMessage[]>([]);
  const [userInput, setUserInput] = useState("");
  const [autoMode, setAutoMode] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamingSide, setStreamingSide] = useState<"left" | "right" | null>(null);
  const [streamingText, setStreamingText] = useState("");

  // [START] History
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<PingpongSession[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  // [END]

  useEffect(() => {
    try {
      const { repoId, name, persona } = left;
      localStorage.setItem("ovo:pp:left", JSON.stringify({ repoId, name, persona }));
    } catch {}
  }, [left.repoId, left.name, left.persona]);

  useEffect(() => {
    try {
      const { repoId, name, persona } = right;
      localStorage.setItem("ovo:pp:right", JSON.stringify({ repoId, name, persona }));
    } catch {}
  }, [right.repoId, right.name, right.persona]);

  const autoRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const timelineEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (health !== "healthy") return;
    void listModels(ports).then((r) => setModels(r.models.filter(isChatCapableModel))).catch(() => {});
    void listPingpongSessions().then(setSessions).catch(() => {});
  }, [health, ports]);

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timeline, streamingText]);

  // [START] Save message to DB
  const persistMessage = useCallback(async (msg: DisplayMessage) => {
    if (!sessionId) return;
    await addPingpongMessage({
      session_id: sessionId,
      speaker: msg.speaker,
      side: msg.side,
      role: msg.role,
      content: msg.content,
    }).catch(() => {});
  }, [sessionId]);
  // [END]

  // [START] Auto-create session when first message is sent
  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionId) return sessionId;
    const session = await createPingpongSession({
      left_model: left.repoId,
      left_name: left.name,
      left_persona: left.persona,
      right_model: right.repoId,
      right_name: right.name,
      right_persona: right.persona,
    });
    setSessionId(session.id);
    setSessions((prev) => [session, ...prev]);
    return session.id;
  }, [sessionId, left, right]);
  // [END]

  // [START] Load session from history
  const loadSession = useCallback(async (session: PingpongSession) => {
    setLeft({ repoId: session.left_model, name: session.left_name, persona: session.left_persona, messages: [] });
    setRight({ repoId: session.right_model, name: session.right_name, persona: session.right_persona, messages: [] });
    setSessionId(session.id);
    setShowHistory(false);

    const msgs = await loadPingpongMessages(session.id);
    const display: DisplayMessage[] = [];
    const leftMsgs: ChatWireMessage[] = [];
    const rightMsgs: ChatWireMessage[] = [];

    for (const m of msgs) {
      display.push({ speaker: m.speaker, role: m.role, content: m.content, side: m.side });
      if (m.side === "user") {
        leftMsgs.push({ role: "user", content: m.content });
        rightMsgs.push({ role: "user", content: m.content });
      } else if (m.side === "left") {
        leftMsgs.push({ role: m.role, content: m.content });
        rightMsgs.push({ role: "user", content: `[${m.speaker}]: ${m.content}` });
      } else {
        rightMsgs.push({ role: m.role, content: m.content });
        leftMsgs.push({ role: "user", content: `[${m.speaker}]: ${m.content}` });
      }
    }

    setTimeline(display);
    setLeft((prev) => ({ ...prev, messages: leftMsgs }));
    setRight((prev) => ({ ...prev, messages: rightMsgs }));
  }, []);
  // [END]

  const stopAll = () => {
    autoRef.current = false;
    setAutoMode(false);
    abortRef.current?.abort();
    setStreaming(false);
    setStreamingSide(null);
    setStreamingText("");
  };

  const buildSystemPrompt = (slot: ModelSlot, otherSlot: ModelSlot): string => {
    const myName = slot.name || "AI";
    const otherName = otherSlot.name || "상대방";
    const parts: string[] = [];
    parts.push(`당신의 이름은 "${myName}"입니다. 절대로 자신을 "${otherName}"이라고 부르지 마세요.`);
    if (slot.persona) {
      parts.push(`당신의 역할: ${slot.persona}`);
    }
    parts.push(`당신은 지금 "${otherName}"${otherSlot.persona ? ` (${otherSlot.persona})` : ""}과(와) 대화 중입니다.`);
    parts.push(`[${otherName}]: 로 시작하는 메시지는 ${otherName}이 한 말입니다. 그 내용에 직접 반응하세요.`);
    parts.push("규칙:");
    parts.push(`1. 당신은 "${myName}"입니다. 항상 ${myName}의 입장에서 말하세요.`);
    parts.push("2. 상대방의 의견에 동의하거나 반박하며 대화를 이어가세요.");
    parts.push("3. 2-3문장으로 짧게 답하세요. 튜토리얼이나 목록을 쓰지 마세요.");
    parts.push("4. 사용자가 쓴 언어와 같은 언어로 답하세요.");
    return parts.join("\n");
  };

  const generateResponse = async (targetSide: "left" | "right", extraMessages?: ChatWireMessage[]): Promise<string> => {
    const slot = targetSide === "left" ? left : right;
    const otherSlot = targetSide === "left" ? right : left;
    if (!slot.repoId) return "";

    const sysPrompt = buildSystemPrompt(slot, otherSlot);
    const msgs: ChatWireMessage[] = [
      { role: "system", content: sysPrompt },
      ...slot.messages,
      ...(extraMessages ?? []),
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
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        useToastsStore.getState().push({ kind: "error", message: (e as Error).message });
      }
      return "";
    } finally {
      setStreaming(false);
      setStreamingSide(null);
      setStreamingText("");
    }

    if (full) {
      full = cleanModelOutput(full);
      const assistantMsg: ChatWireMessage = { role: "assistant", content: full };
      const setter = targetSide === "left" ? setLeft : setRight;
      setter((prev) => ({ ...prev, messages: [...prev.messages, assistantMsg] }));

      const speakerName = slot.name || slot.repoId.split("/").pop() || targetSide;
      const displayMsg: DisplayMessage = { speaker: speakerName, role: "assistant", content: full, side: targetSide };
      setTimeline((prev) => [...prev, displayMsg]);
      void persistMessage(displayMsg);
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
    await generateResponse(targetSide, [relayMsg]);
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

  // [START] @name targeting: "@짱구 ..." sends only to left, "@리나 ..." only to right
  const parseTarget = (text: string): { target: "both" | "left" | "right"; cleanText: string } => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName && text.toLowerCase().startsWith(`@${leftName}`)) {
      return { target: "left", cleanText: text.slice(leftName.length + 1).trim() };
    }
    if (rightName && text.toLowerCase().startsWith(`@${rightName}`)) {
      return { target: "right", cleanText: text.slice(rightName.length + 1).trim() };
    }
    return { target: "both", cleanText: text };
  };
  // [END]

  const sendUserMessage = async () => {
    const text = userInput.trim();
    if (!text) return;
    setUserInput("");

    await ensureSession();

    const { target, cleanText } = parseTarget(text);
    const userMsg: ChatWireMessage = { role: "user", content: cleanText || text };

    const displayMsg: DisplayMessage = { speaker: t("pingpong.you"), role: "user", content: text, side: "user" };
    setTimeline((prev) => [...prev, displayMsg]);
    void persistMessage(displayMsg);

    if (target === "both" || target === "left") {
      setLeft((prev) => ({ ...prev, messages: [...prev.messages, userMsg] }));
    }
    if (target === "both" || target === "right") {
      setRight((prev) => ({ ...prev, messages: [...prev.messages, userMsg] }));
    }

    if (target === "both" && left.repoId && right.repoId) {
      // [START] Sequential: left → right → auto-continue passing responses directly
      const leftResponse = await generateResponse("left");
      if (leftResponse) {
        const leftName = left.name || left.repoId.split("/").pop() || "Left";
        const rightName = right.name || right.repoId.split("/").pop() || "Right";
        const relayToRight: ChatWireMessage = {
          role: "user",
          content: `[${leftName}]: ${leftResponse}`,
        };
        setRight((prev) => ({ ...prev, messages: [...prev.messages, relayToRight] }));
        const rightResponse = await generateResponse("right", [relayToRight]);

        if (rightResponse) {
          autoRef.current = true;
          setAutoMode(true);
          let lastLeft = leftResponse;
          let lastRight = rightResponse;
          try {
            while (autoRef.current) {
              const toLeft: ChatWireMessage = { role: "user", content: `[${rightName}]: ${lastRight}` };
              setLeft((prev) => ({ ...prev, messages: [...prev.messages, toLeft] }));
              lastLeft = await generateResponse("left", [toLeft]);
              if (!lastLeft || !autoRef.current) break;

              const toRight: ChatWireMessage = { role: "user", content: `[${leftName}]: ${lastLeft}` };
              setRight((prev) => ({ ...prev, messages: [...prev.messages, toRight] }));
              lastRight = await generateResponse("right", [toRight]);
              if (!lastRight || !autoRef.current) break;
            }
          } catch { /* cancelled */ }
          finally {
            autoRef.current = false;
            setAutoMode(false);
          }
        }
      }
      // [END]
    } else {
      if ((target === "left") && left.repoId) {
        await generateResponse("left");
      }
      if ((target === "right") && right.repoId) {
        await generateResponse("right");
      }
    }
  };

  const clearAll = () => {
    stopAll();
    setLeft((prev) => ({ ...prev, messages: [] }));
    setRight((prev) => ({ ...prev, messages: [] }));
    setTimeline([]);
    setSessionId(null);
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
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className={`p-1.5 rounded-md transition ${showHistory ? "text-ovo-accent bg-ovo-nav-active" : "text-ovo-muted hover:text-ovo-text"}`}
          title={t("pingpong.history")}
        >
          <History className="w-4 h-4" />
        </button>
      </header>

      {/* History panel */}
      {showHistory && (
        <div className="rounded-xl bg-ovo-surface border border-ovo-border p-3 max-h-48 overflow-y-auto">
          <div className="text-xs font-semibold text-ovo-text mb-2">{t("pingpong.history")}</div>
          {sessions.length === 0 ? (
            <p className="text-[11px] text-ovo-muted">{t("pingpong.no_history")}</p>
          ) : (
            <ul className="space-y-1">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => void loadSession(s)}
                    className={`flex-1 text-left px-2 py-1.5 rounded transition truncate ${
                      sessionId === s.id ? "bg-ovo-accent/10 text-ovo-accent" : "text-ovo-text hover:bg-ovo-nav-active-hover"
                    }`}
                  >
                    {s.title}
                    <span className="text-[10px] text-ovo-muted ml-2">
                      {new Date(s.updated_at).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      await deletePingpongSession(s.id);
                      setSessions((prev) => prev.filter((x) => x.id !== s.id));
                      if (sessionId === s.id) clearAll();
                    }}
                    className="p-1 text-ovo-muted hover:text-rose-500 transition shrink-0"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Model selectors with name + persona */}
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start">
        <div className="space-y-1.5">
          <select
            value={left.repoId}
            onChange={(e) => setLeft((prev) => ({
              ...prev, repoId: e.target.value,
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
            type="text" value={left.name}
            onChange={(e) => setLeft((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={t("pingpong.name_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-xs text-ovo-accent font-semibold focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          />
          <input
            type="text" value={left.persona}
            onChange={(e) => setLeft((prev) => ({ ...prev, persona: e.target.value }))}
            placeholder={t("pingpong.persona_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-[11px] text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          />
        </div>

        <div className="flex items-center justify-center pt-2">
          <span className="text-xs font-bold text-ovo-muted">VS</span>
        </div>

        <div className="space-y-1.5">
          <select
            value={right.repoId}
            onChange={(e) => setRight((prev) => ({
              ...prev, repoId: e.target.value,
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
            type="text" value={right.name}
            onChange={(e) => setRight((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={t("pingpong.name_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-xs text-ovo-accent font-semibold focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          />
          <input
            type="text" value={right.persona}
            onChange={(e) => setRight((prev) => ({ ...prev, persona: e.target.value }))}
            placeholder={t("pingpong.persona_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-[11px] text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          />
        </div>
      </div>

      {/* Timeline + controls */}
      <div className="flex-1 flex gap-2 min-h-0">
        <div className="flex-1 rounded-xl bg-ovo-surface border border-ovo-border overflow-y-auto p-4 space-y-3 min-h-0">
          {timeline.length === 0 && !streaming && (
            <div className="flex flex-col items-center justify-center h-full text-sm text-ovo-muted gap-2">
              <ArrowLeftRight className="w-8 h-8" />
              {t("pingpong.empty")}
              {left.name && right.name && (
                <span className="text-[11px]">
                  {t("pingpong.at_hint", { left: left.name, right: right.name })}
                </span>
              )}
            </div>
          )}
          {timeline.map((msg, i) => (
            <div key={i} className={`flex gap-2 ${msg.side === "user" ? "justify-center" : msg.side === "left" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[75%] rounded-lg px-3 py-2 text-xs ${
                msg.side === "user"
                  ? "bg-sky-500/10 border border-sky-500/30 text-center"
                  : msg.side === "left"
                    ? "bg-ovo-accent/10 border border-ovo-accent/20"
                    : "bg-emerald-500/10 border border-emerald-500/20"
              }`}>
                <div className={`font-semibold text-[11px] mb-1 ${
                  msg.side === "user" ? "text-sky-400" : msg.side === "left" ? "text-ovo-accent" : "text-emerald-400"
                }`}>
                  {msg.speaker}
                </div>
                <div className="whitespace-pre-wrap text-ovo-text leading-relaxed">{msg.content}</div>
              </div>
            </div>
          ))}
          {streaming && streamingText && (
            <div className={`flex gap-2 ${streamingSide === "left" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[75%] rounded-lg px-3 py-2 text-xs ${
                streamingSide === "left" ? "bg-ovo-accent/10 border border-ovo-accent/20" : "bg-emerald-500/10 border border-emerald-500/20"
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

        {/* Controls */}
        <div className="flex flex-col items-center justify-center gap-2 shrink-0">
          <button type="button" disabled={streaming || !left.messages.length || !right.repoId}
            onClick={() => void pushToSide("left")}
            className="p-2 rounded-lg bg-ovo-surface border border-ovo-border text-ovo-muted hover:text-ovo-accent transition disabled:opacity-30"
            title={t("pingpong.push_right")}>
            <ArrowRight className="w-4 h-4" />
          </button>

          {autoMode ? (
            <button type="button" onClick={stopAll}
              className="p-2 rounded-lg bg-rose-500/20 border border-rose-500/40 text-rose-400 hover:brightness-110 transition"
              title={t("pingpong.stop")}>
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button type="button"
              disabled={streaming || !left.repoId || !right.repoId || timeline.length === 0}
              onClick={() => void startAuto()}
              className="p-2 rounded-lg bg-ovo-accent/20 border border-ovo-accent/40 text-ovo-accent hover:brightness-110 transition disabled:opacity-30"
              title={t("pingpong.auto")}>
              <Play className="w-4 h-4" />
            </button>
          )}

          <button type="button" disabled={streaming || !right.messages.length || !left.repoId}
            onClick={() => void pushToSide("right")}
            className="p-2 rounded-lg bg-ovo-surface border border-ovo-border text-ovo-muted hover:text-ovo-accent transition disabled:opacity-30"
            title={t("pingpong.push_left")}>
            <ArrowLeft className="w-4 h-4" />
          </button>

          <div className="border-t border-ovo-border w-6 my-1" />

          <button type="button" onClick={clearAll} disabled={streaming}
            className="p-2 rounded-lg bg-ovo-surface border border-ovo-border text-ovo-muted hover:text-rose-500 transition disabled:opacity-30"
            title={t("pingpong.clear")}>
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* User input — always enabled during streaming so user can intervene */}
      <div className="flex gap-2">
        <div className="flex items-center gap-1.5 text-sky-400 shrink-0">
          <User className="w-4 h-4" />
        </div>
        <input
          type="text" value={userInput}
          onChange={(e) => setUserInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (streaming) { stopAll(); } else { void sendUserMessage(); }
            }
          }}
          placeholder={
            streaming
              ? t("pingpong.intervene_hint")
              : left.name && right.name
                ? t("pingpong.user_placeholder_named", { left: left.name, right: right.name })
                : t("pingpong.user_placeholder")
          }
          disabled={!left.repoId && !right.repoId}
          className="flex-1 px-3 py-2.5 rounded-lg bg-ovo-surface border border-ovo-border text-sm text-ovo-text placeholder:text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent disabled:opacity-40"
        />
        {streaming ? (
          <button onClick={stopAll}
            className="px-4 py-2.5 rounded-lg bg-rose-500 text-white hover:brightness-110 transition">
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button disabled={!userInput.trim()}
            onClick={() => void sendUserMessage()}
            className="px-4 py-2.5 rounded-lg bg-ovo-accent text-white disabled:opacity-40 hover:brightness-110 transition">
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
// [END]
