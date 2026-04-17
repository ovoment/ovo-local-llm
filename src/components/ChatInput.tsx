import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Send, Square, Plus, Upload, Link as LinkIcon } from "lucide-react";
import type { ChatAttachment, ModelCapability } from "../types/ovo";
import { AttachmentChip } from "./AttachmentChip";

interface Props {
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  // [START] streaming send mode props
  allowTypeDuringStreaming?: boolean;
  queueCount?: number;
  // [END]
  // [START] Phase B — model capabilities gate attach accept types
  modelCapabilities?: ModelCapability[];
  // [END]
  // [START] left slot — optional button rendered before the attach (+) button, inside the same card row
  leftSlot?: ReactNode;
  // [END]
}

// [START] imperative handle — lets parent (ChatPane) push files dropped onto the pane
export interface ChatInputHandle {
  addFiles: (files: File[]) => void;
}
// [END]

function readImagePreview(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/")) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput(
  { onSend, onStop, streaming, disabled, allowTypeDuringStreaming = false, queueCount = 0, modelCapabilities = [], leftSlot },
  ref,
) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [urlMode, setUrlMode] = useState(false);
  const [urlValue, setUrlValue] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setUrlMode(false);
        setUrlValue("");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  useEffect(() => {
    if (urlMode) urlInputRef.current?.focus();
  }, [urlMode]);

  // [START] textarea disabled logic — allow typing during streaming for queue/interrupt modes
  const textareaDisabled = disabled || (streaming && !allowTypeDuringStreaming);
  const canSubmit = (value.trim().length > 0 || attachments.length > 0) && !disabled && (allowTypeDuringStreaming || !streaming);
  // [END]

  // [START] Phase B — dynamic file accept based on model capabilities
  const hasVision = modelCapabilities.includes("vision");
  const hasAudio = modelCapabilities.includes("audio");
  const fileAccept = hasVision && hasAudio
    ? "image/*,audio/*"
    : hasVision
      ? "image/*"
      : hasAudio
        ? "audio/*"
        : "*/*";
  // Attach button disabled when model is text-only (no vision, no audio)
  const attachSupported = hasVision || hasAudio;
  // [END]

  const submit = () => {
    if (!canSubmit) return;
    onSend(value.trim(), attachments);
    setValue("");
    setAttachments([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPickFiles = () => {
    setMenuOpen(false);
    fileInputRef.current?.click();
  };

  // [START] shared attach routine — used by both file picker and external (drag-drop) callers
  const appendFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const next: ChatAttachment[] = await Promise.all(
      files.map(async (file) => ({
        kind: "file" as const,
        id: genId(),
        file,
        previewDataUrl: await readImagePreview(file),
      })),
    );
    setAttachments((prev) => [...prev, ...next]);
  };
  // [END]

  const onFilesSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await appendFiles(files);
  };

  // [START] expose addFiles to parent (ChatPane drop zone)
  useImperativeHandle(ref, () => ({ addFiles: (files) => void appendFiles(files) }), []);
  // [END]

  const onConfirmUrl = () => {
    const url = urlValue.trim();
    if (!url) return;
    setAttachments((prev) => [...prev, { kind: "url", id: genId(), url }]);
    setUrlValue("");
    setUrlMode(false);
    setMenuOpen(false);
  };

  const onUrlKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onConfirmUrl();
    } else if (e.key === "Escape") {
      setUrlMode(false);
      setUrlValue("");
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="p-3 bg-ovo-surface border-t border-ovo-border">
      {/* [START] queue badge — shown when messages are waiting */}
      {queueCount > 0 && (
        <div className="mb-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-ovo-bg border border-ovo-border text-xs text-ovo-muted">
          <span className="inline-flex gap-0.5" aria-hidden>
            <span className="w-1 h-1 rounded-full bg-ovo-accent animate-bounce [animation-delay:-0.3s]" />
            <span className="w-1 h-1 rounded-full bg-ovo-accent animate-bounce [animation-delay:-0.15s]" />
            <span className="w-1 h-1 rounded-full bg-ovo-accent animate-bounce" />
          </span>
          {t("chat.queue_badge", { count: queueCount })}
        </div>
      )}
      {/* [END] */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} onRemove={removeAttachment} />
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        {leftSlot}
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={disabled || !attachSupported}
            aria-label={attachSupported ? t("chat.attach") : t("chat.attach_unsupported")}
            title={attachSupported ? t("chat.attach") : t("chat.attach_unsupported")}
            className="h-[40px] w-[40px] rounded-lg bg-ovo-surface-solid border border-ovo-border text-ovo-muted hover:bg-ovo-bg hover:text-ovo-text disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition"
          >
            <Plus className="w-4 h-4" aria-hidden />
          </button>
          {menuOpen && (
            <div className="absolute z-20 bottom-full mb-1 left-0 min-w-[220px] rounded-lg bg-ovo-surface-solid border border-ovo-border shadow-lg py-1">
              <button
                type="button"
                onClick={onPickFiles}
                className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-ovo-text hover:bg-ovo-bg transition"
              >
                <Upload className="w-4 h-4 text-ovo-muted" aria-hidden />
                {t("chat.attach_file")}
              </button>
              {urlMode ? (
                <div className="px-3 py-2 flex items-center gap-2">
                  <LinkIcon className="w-4 h-4 text-ovo-muted shrink-0" aria-hidden />
                  <input
                    ref={urlInputRef}
                    type="url"
                    value={urlValue}
                    onChange={(e) => setUrlValue(e.target.value)}
                    onKeyDown={onUrlKeyDown}
                    placeholder={t("chat.url_placeholder")}
                    className="flex-1 min-w-0 text-sm bg-transparent border-0 border-b border-ovo-border focus:border-ovo-accent focus:outline-none text-ovo-text placeholder:text-ovo-muted py-1"
                  />
                  <button
                    type="button"
                    onClick={onConfirmUrl}
                    className="text-xs text-ovo-accent hover:text-ovo-accent-hover"
                  >
                    OK
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setUrlMode(true)}
                  className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-ovo-text hover:bg-ovo-bg transition"
                >
                  <LinkIcon className="w-4 h-4 text-ovo-muted" aria-hidden />
                  {t("chat.attach_url")}
                </button>
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={fileAccept}
            onChange={onFilesSelected}
            className="hidden"
          />
        </div>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("chat.placeholder")}
          rows={1}
          disabled={textareaDisabled}
          className="flex-1 resize-none max-h-40 min-h-[40px] px-3 py-2 rounded-lg bg-ovo-surface-solid border border-ovo-border text-sm text-ovo-text placeholder:text-ovo-muted focus:outline-none focus:border-ovo-accent focus:ring-1 focus:ring-ovo-accent disabled:opacity-50"
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label={t("chat.stop")}
            className="h-[40px] px-3 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-sm flex items-center gap-1.5 transition"
          >
            <Square className="w-3.5 h-3.5 fill-current" aria-hidden />
            {t("chat.stop")}
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            aria-label={t("chat.send")}
            className="h-[40px] px-3 rounded-lg bg-ovo-accent hover:bg-ovo-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-ovo-accent-ink text-sm flex items-center gap-1.5 transition"
          >
            <Send className="w-3.5 h-3.5" aria-hidden />
            {t("chat.send")}
          </button>
        )}
      </div>
    </div>
  );
});
