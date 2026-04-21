// [START] PingpongPane — two named models with personas, history, @targeting, attachments.
import React, { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftRight, ArrowRight, ArrowLeft, Play, Square, Send,
  Loader2, User, Trash2, History, Plus, Paperclip, Code2, Link,
} from "lucide-react";
import { useSidecarStore } from "../store/sidecar";
import { useToastsStore } from "../store/toasts";
import { listModels, streamChat, cleanModelOutput, type ChatWireMessage, type ChatContentPart } from "../lib/api";
import { normalizeReasoning } from "../lib/messageSegments";
import { isChatCapableModel } from "../lib/models";
import { extractAttachmentText, formatAttachedFileBlock } from "../lib/fileExtraction";
import type { ChatAttachment } from "../types/ovo";
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

// [START] Strip ALL thinking from pingpong — display only the actual answer
const THINKING_MARKERS = /(?:Here's a thinking process|Let me think|Thinking process|Analysis:|1\.\s+\*\*Analyze|I need to|My thought process|The user is asking|I should|I will)/im;
const META_NOISE = /(?:✅|Check constraints|Self-Correction|Verification|Proceeds|Ready\.|Done\.|Note:|Final Check|All good|Output matches|All constraints|Let's count|Draft|Revised)/i;

function stripThinkForDisplay(text: string): string {
  const normalized = normalizeReasoning(text);
  let stripped = normalized
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*/g, "")
    .replace(/<\/?think>/g, "")
    .trim();

  if (!THINKING_MARKERS.test(stripped)) return stripped || text;

  const paragraphs = stripped.split(/\n\n+/);
  const clean: string[] = [];
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i].trim();
    if (!p || p.length < 15) continue;
    const hasKorean = /[\uac00-\ud7af]/.test(p);
    const hasMeta = META_NOISE.test(p);
    const hasThinkMarker = THINKING_MARKERS.test(p);
    const isNumberedStep = /^\d+\.\s+\*\*/.test(p);
    if (hasKorean && !hasMeta && !hasThinkMarker && !isNumberedStep) {
      clean.unshift(p);
    } else if (clean.length > 0) {
      break;
    }
  }
  return clean.length > 0 ? clean.join("\n\n") : stripped || text;
}
// [END]

function stripThinkForStreaming(text: string): string {
  if (THINKING_MARKERS.test(text)) {
    const stripped = stripThinkForDisplay(text);
    if (stripped === text || THINKING_MARKERS.test(stripped)) {
      return "💭 ...";
    }
    return stripped;
  }
  return stripThinkForDisplay(text);
}

function renderBubbleContent(text: string): React.ReactNode {
  const parts = text.split(/(```[\s\S]*?```)/g);
  return parts.map((part, i) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const inner = part.slice(3, -3);
      const langMatch = inner.match(/^(\w+)\n/);
      const lang = langMatch ? langMatch[1] : "";
      const code = langMatch ? inner.slice(langMatch[0].length) : inner.replace(/^\n/, "");
      const lines = code.split("\n");
      return (
        <div key={i} className="my-2 rounded-lg overflow-hidden border border-ovo-border">
          <div className="flex items-center justify-between px-3 py-1 bg-[#1e1e1e] border-b border-ovo-border">
            <span className="text-[10px] text-neutral-400 font-mono">{lang || "code"}</span>
            <span className="text-[10px] text-neutral-500">{lines.length} lines</span>
          </div>
          <div className="bg-[#1e1e1e] p-2 overflow-x-auto">
            <table className="border-collapse text-[11px] font-mono leading-relaxed">
              <tbody>
                {lines.map((line, li) => (
                  <tr key={li}>
                    <td className="pr-3 text-right text-neutral-600 select-none align-top w-[1%] whitespace-nowrap">{li + 1}</td>
                    <td className="text-neutral-200 whitespace-pre-wrap break-all">{line || " "}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }
    return part ? <span key={i} className="whitespace-pre-wrap">{part}</span> : null;
  });
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

  // [START] Attachment state
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [codeInput, setCodeInput] = useState<string | null>(null);
  const [urlInput, setUrlInput] = useState(false);
  const [urlValue, setUrlValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const preReadTexts = useRef<Record<string, string>>({});
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

  // [START] Attachment handlers
  function genId(): string {
    return typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function readPreview(file: File): Promise<string | null> {
    if (!file.type.startsWith("image/")) return Promise.resolve(null);
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  async function handleFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList);
    for (const f of files) {
      const id = genId();
      const preview = await readPreview(f);
      setAttachments((prev) => [...prev, { kind: "file", id, file: f, previewDataUrl: preview }]);
      if (!f.type.startsWith("image/")) {
        try {
          const ext = await extractAttachmentText(f);
          if (ext.kind !== "skipped" && ext.text.trim()) {
            preReadTexts.current[id] = formatAttachedFileBlock(ext);
          } else {
            const raw = await f.text().catch(() => "");
            if (raw.trim()) preReadTexts.current[id] = `[${f.name}]\n${raw}`;
          }
        } catch {
          const raw = await f.text().catch(() => "");
          if (raw.trim()) preReadTexts.current[id] = `[${f.name}]\n${raw}`;
        }
      }
    }
    setShowAttachMenu(false);
  }

  function handleCodeSubmit() {
    if (!codeInput?.trim()) return;
    const id = genId();
    const blob = new Blob([codeInput], { type: "text/plain" });
    const file = new File([blob], "code.txt", { type: "text/plain" });
    preReadTexts.current[id] = `\`\`\`\n${codeInput}\n\`\`\``;
    setAttachments((prev) => [...prev, { kind: "file", id, file, previewDataUrl: null }]);
    setCodeInput(null);
  }

  function handleUrlSubmit() {
    if (!urlValue.trim()) return;
    setAttachments((prev) => [...prev, { kind: "url", id: genId(), url: urlValue.trim() }]);
    setUrlValue("");
    setUrlInput(false);
    setShowAttachMenu(false);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    delete preReadTexts.current[id];
  }

  async function buildAttachmentWire(text: string, atts: ChatAttachment[]): Promise<string | ChatContentPart[]> {
    if (atts.length === 0) return text;

    const MAX_ATTACH_CHARS = 8000;
    const parts: ChatContentPart[] = [];
    let fullText = text;

    for (const a of atts) {
      if (a.kind === "url") {
        parts.push({ type: "image_url", image_url: { url: a.url } });
        continue;
      }
      if (a.kind === "file") {
        if (a.file.type.startsWith("image/")) {
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(a.file);
          });
          parts.push({ type: "image_url", image_url: { url: dataUrl } });
        } else {
          let cached = preReadTexts.current[a.id] ?? "";
          if (cached.length > MAX_ATTACH_CHARS) {
            cached = cached.slice(0, MAX_ATTACH_CHARS) + "\n… [truncated]";
          }
          if (cached) {
            fullText = fullText ? `${fullText}\n\n${cached}` : cached;
          }
        }
      }
    }

    if (parts.length === 0) return fullText;
    parts.unshift({ type: "text", text: fullText });
    return parts;
  }
  // [END]

  // [START] Close attach menu on outside click
  useEffect(() => {
    if (!showAttachMenu) return;
    function handleOutside(e: MouseEvent) {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setShowAttachMenu(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [showAttachMenu]);
  // [END]

  const stopAll = () => {
    autoRef.current = false;
    setAutoMode(false);
    abortRef.current?.abort();
    setStreaming(false);
    setStreamingSide(null);
    setStreamingText("");
  };

  const topicRef = useRef("");

  const buildSystemPrompt = (slot: ModelSlot, otherSlot: ModelSlot): string => {
    const myName = slot.name || "AI";
    const otherName = otherSlot.name || "상대방";
    const topic = topicRef.current;
    return `너는 "${myName}"이다.${slot.persona ? ` ${slot.persona}.` : ""} "${otherName}"과 "${topic}"에 대해 토론 중이다. 반드시 "${topic}"에 대해서만 이야기하라. 다른 주제 절대 금지. 즉시 의견을 말하라. 2-3문장. 생각 과정, 분석, thinking process를 절대 출력하지 마라. 답변만 출력하라.`;
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
      full = stripThinkForDisplay(cleanModelOutput(full));
      const assistantMsg: ChatWireMessage = { role: "assistant", content: full };
      const setter = targetSide === "left" ? setLeft : setRight;
      setter((prev) => ({ ...prev, messages: [...prev.messages, assistantMsg] }));

      const speakerName = slot.name || slot.repoId.split("/").pop() || targetSide;
      const MAX_BUBBLE = 300;
      if (full.length > MAX_BUBBLE) {
        const paragraphs = full.split(/\n\n+/);
        let chunk = "";
        const chunks: string[] = [];
        for (const p of paragraphs) {
          if (chunk && (chunk.length + p.length) > MAX_BUBBLE) {
            chunks.push(chunk.trim());
            chunk = p;
          } else {
            chunk = chunk ? `${chunk}\n\n${p}` : p;
          }
        }
        if (chunk.trim()) chunks.push(chunk.trim());
        if (chunks.length < 2) {
          const mid = Math.ceil(full.length / 2);
          const breakAt = full.lastIndexOf(". ", mid);
          const splitAt = breakAt > full.length * 0.3 ? breakAt + 1 : mid;
          chunks.length = 0;
          chunks.push(full.slice(0, splitAt).trim(), full.slice(splitAt).trim());
        }
        for (const c of chunks) {
          const msg: DisplayMessage = { speaker: speakerName, role: "assistant", content: c, side: targetSide };
          setTimeline((prev) => [...prev, msg]);
          void persistMessage(msg);
        }
      } else {
        const displayMsg: DisplayMessage = { speaker: speakerName, role: "assistant", content: full, side: targetSide };
        setTimeline((prev) => [...prev, displayMsg]);
        void persistMessage(displayMsg);
      }
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
    if (!text && attachments.length === 0) return;
    setUserInput("");

    // [START] Stop auto mode + current stream on user intervention
    if (autoRef.current || streaming) {
      stopAll();
      await new Promise((r) => setTimeout(r, 500));
    }
    // [END]

    await ensureSession();

    const { target, cleanText } = parseTarget(text);
    topicRef.current = cleanText || text;
    // [START] Build wire content with attachments
    const content = await buildAttachmentWire(cleanText || text, attachments);
    const userMsg: ChatWireMessage = { role: "user", content };
    setAttachments([]);
    preReadTexts.current = {};
    // [END]

    // [START] Build display content with attachment previews
    let displayContent = text;
    for (const a of attachments) {
      if (a.kind === "file") {
        if (a.file.name === "code.txt") {
          const codeText = await a.file.text();
          displayContent = `${displayContent}\n\`\`\`\n${codeText}\n\`\`\``.trim();
        } else if (a.file.type === "text/plain" || a.file.name.endsWith(".txt") || a.file.name.endsWith(".md")) {
          const codeText = await a.file.text();
          displayContent = `${displayContent}\n📎 ${a.file.name}\n\`\`\`\n${codeText}\n\`\`\``.trim();
        } else {
          displayContent = `${displayContent}\n📎 ${a.file.name}`.trim();
        }
      } else if (a.kind === "url") {
        displayContent = `${displayContent}\n🔗 ${a.url}`.trim();
      }
    }
    const attachNames = attachments.map((a) => a.kind === "file" ? (a.file.name === "code.txt" ? "" : a.file.name) : a.kind === "url" ? a.url : "").filter(Boolean);
    const speaker = attachNames.length > 0 ? attachNames.join(", ") : t("pingpong.you");
    const displayMsg: DisplayMessage = { speaker, role: "user", content: displayContent, side: "user" };
    // [END]
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
      // userMsg passed as extraMessages since React state hasn't re-rendered yet
      const leftResponse = await generateResponse("left", [userMsg]);
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
          const originalTopic = cleanText || text;
          try {
            while (autoRef.current) {
              await new Promise((r) => setTimeout(r, 1000));
              if (!autoRef.current) break;
              const toLeft: ChatWireMessage = { role: "user", content: `[주제 리마인드: ${originalTopic}]\n[${rightName}]: ${lastRight}` };
              setLeft((prev) => ({ ...prev, messages: [...prev.messages, toLeft] }));
              lastLeft = await generateResponse("left", [toLeft]);
              if (!lastLeft || !autoRef.current) break;

              await new Promise((r) => setTimeout(r, 1000));
              if (!autoRef.current) break;
              const toRight: ChatWireMessage = { role: "user", content: `[주제 리마인드: ${originalTopic}]\n[${leftName}]: ${lastLeft}` };
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
        await generateResponse("left", [userMsg]);
      }
      if ((target === "right") && right.repoId) {
        await generateResponse("right", [userMsg]);
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
            {models.map((m, i) => (
              <option key={`${m.repo_id}-${i}`} value={m.repo_id}>{m.repo_id.split("/").pop()}</option>
            ))}
          </select>
          <input
            type="text" value={left.name}
            onChange={(e) => setLeft((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={t("pingpong.name_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-xs text-ovo-accent font-semibold focus:outline-none focus:ring-1 focus:ring-ovo-accent"
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
            {models.map((m, i) => (
              <option key={`${m.repo_id}-${i}`} value={m.repo_id}>{m.repo_id.split("/").pop()}</option>
            ))}
          </select>
          <input
            type="text" value={right.name}
            onChange={(e) => setRight((prev) => ({ ...prev, name: e.target.value }))}
            placeholder={t("pingpong.name_placeholder")}
            className="w-full px-2.5 py-1 rounded-lg bg-ovo-surface border border-ovo-border text-xs text-ovo-accent font-semibold focus:outline-none focus:ring-1 focus:ring-ovo-accent"
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
                <div className="text-ovo-text leading-relaxed">{renderBubbleContent(msg.content)}</div>
              </div>
            </div>
          ))}
          {streaming && streamingText && (() => {
            const displayText = stripThinkForStreaming(streamingText);
            const isThinking = !displayText || displayText === "💭 ...";
            return (
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
                  {isThinking
                    ? <div className="text-ovo-muted text-[11px] italic">{t("pingpong.typing")}</div>
                    : <div className="text-ovo-text leading-relaxed">{renderBubbleContent(displayText)}</div>
                  }
                </div>
              </div>
            );
          })()}
          {streaming && !streamingText && (
            <div className={`flex gap-2 ${streamingSide === "left" ? "justify-start" : "justify-end"}`}>
              <div className={`rounded-lg px-3 py-2 text-xs ${
                streamingSide === "left" ? "bg-ovo-accent/10 border border-ovo-accent/20" : "bg-emerald-500/10 border border-emerald-500/20"
              }`}>
                <div className="flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin text-ovo-muted" />
                  <span className="text-[11px] text-ovo-muted">{t("pingpong.typing")}</span>
                </div>
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

      {/* [START] User input with attachments */}
      <div className="flex flex-col gap-1.5">
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2">
            {attachments.map((a) => (
              <div key={a.id} className="flex items-center gap-1 px-2 py-1 rounded-md bg-ovo-chip border border-ovo-border text-xs text-ovo-text">
                {a.kind === "file" && a.file.type.startsWith("image/") && a.previewDataUrl && (
                  <img src={a.previewDataUrl} className="w-6 h-6 rounded object-cover" />
                )}
                {a.kind === "file" && <Paperclip className="w-3 h-3 text-ovo-muted" />}
                {a.kind === "url" && <Link className="w-3 h-3 text-ovo-muted" />}
                <span className="truncate max-w-[120px]">
                  {a.kind === "file" ? a.file.name : a.kind === "url" ? a.url : ""}
                </span>
                <button onClick={() => removeAttachment(a.id)} className="text-ovo-muted hover:text-rose-500 ml-1">&times;</button>
              </div>
            ))}
          </div>
        )}

        {/* URL inline input */}
        {urlInput && (
          <div className="flex gap-2 px-2">
            <input
              type="text"
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleUrlSubmit(); if (e.key === "Escape") { setUrlInput(false); setUrlValue(""); } }}
              placeholder="URL을 입력하세요..."
              autoFocus
              className="flex-1 px-2 py-1.5 rounded-md bg-ovo-surface border border-ovo-border text-xs text-ovo-text focus:outline-none focus:ring-1 focus:ring-ovo-accent"
            />
            <button onClick={handleUrlSubmit} disabled={!urlValue.trim()} className="px-3 py-1.5 text-xs rounded-md bg-ovo-accent text-white disabled:opacity-40">추가</button>
            <button onClick={() => { setUrlInput(false); setUrlValue(""); }} className="px-3 py-1.5 text-xs rounded-md bg-ovo-border text-ovo-text">취소</button>
          </div>
        )}

        {/* Input row */}
        <div className="flex gap-2">
          <div className="flex items-center gap-1.5 text-sky-400 shrink-0 relative" ref={attachMenuRef}>
            <User className="w-4 h-4" />
            <button
              type="button"
              onClick={() => setShowAttachMenu((v) => !v)}
              className="p-1 rounded hover:bg-ovo-nav-active transition text-ovo-muted hover:text-ovo-accent"
              title="첨부"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
            {showAttachMenu && (
              <div className="absolute bottom-full left-0 mb-2 bg-ovo-surface border border-ovo-border rounded-lg shadow-lg py-1 z-50 min-w-[140px]">
                <button
                  type="button"
                  onClick={() => { fileInputRef.current?.click(); }}
                  className="w-full px-3 py-1.5 text-left text-xs text-ovo-text hover:bg-ovo-nav-active flex items-center gap-2"
                >
                  <Paperclip className="w-3.5 h-3.5" /> 파일 첨부
                </button>
                <button
                  type="button"
                  onClick={() => { setCodeInput(""); setShowAttachMenu(false); }}
                  className="w-full px-3 py-1.5 text-left text-xs text-ovo-text hover:bg-ovo-nav-active flex items-center gap-2"
                >
                  <Code2 className="w-3.5 h-3.5" /> 코드
                </button>
                <button
                  type="button"
                  onClick={() => { setUrlInput(true); setShowAttachMenu(false); }}
                  className="w-full px-3 py-1.5 text-left text-xs text-ovo-text hover:bg-ovo-nav-active flex items-center gap-2"
                >
                  <Link className="w-3.5 h-3.5" /> URL
                </button>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,.pdf,.hwp,.hwpx,.docx,.xlsx,.pptx,.txt,.md,.csv,.json"
              className="hidden"
              onChange={(e) => { if (e.target.files) void handleFiles(e.target.files); e.target.value = ""; }}
            />
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
            <button disabled={!userInput.trim() && attachments.length === 0}
              onClick={() => void sendUserMessage()}
              className="px-4 py-2.5 rounded-lg bg-ovo-accent text-white disabled:opacity-40 hover:brightness-110 transition">
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Code paste modal */}
      {codeInput !== null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setCodeInput(null)}>
          <div className="bg-ovo-surface border border-ovo-border rounded-xl p-4 w-[500px] max-h-[60vh] flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-ovo-text">코드 붙여넣기</h3>
            <textarea
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              placeholder="소스 코드를 붙여넣으세요..."
              className="flex-1 min-h-[200px] p-3 rounded-lg bg-ovo-bg border border-ovo-border text-xs font-mono text-ovo-text resize-none focus:outline-none focus:ring-1 focus:ring-ovo-accent"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setCodeInput(null)} className="px-3 py-1.5 text-xs rounded-md bg-ovo-border text-ovo-text hover:brightness-110 transition">취소</button>
              <button onClick={handleCodeSubmit} disabled={!codeInput?.trim()} className="px-3 py-1.5 text-xs rounded-md bg-ovo-accent text-white disabled:opacity-40 hover:brightness-110 transition">추가</button>
            </div>
          </div>
        </div>
      )}
      {/* [END] */}
    </div>
  );
}
// [END]
