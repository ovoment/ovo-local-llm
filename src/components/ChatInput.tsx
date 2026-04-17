import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Send, Square, Plus, Upload, Link as LinkIcon } from "lucide-react";
import type { ChatAttachment } from "../types/ovo";
import { AttachmentChip } from "./AttachmentChip";

interface Props {
  onSend: (text: string, attachments: ChatAttachment[]) => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
}

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

export function ChatInput({ onSend, onStop, streaming, disabled }: Props) {
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

  const canSubmit = (value.trim().length > 0 || attachments.length > 0) && !streaming && !disabled;

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

  const onFilesSelected = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
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
    <div className="p-3 bg-white/60 border-t border-[#E8CFBB]">
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {attachments.map((a) => (
            <AttachmentChip key={a.id} attachment={a} onRemove={removeAttachment} />
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            disabled={disabled}
            aria-label={t("chat.attach")}
            title={t("chat.attach")}
            className="h-[40px] w-[40px] rounded-lg bg-white border border-[#E8CFBB] text-[#8B4432] hover:bg-[#FAF3E7] hover:text-[#2C1810] disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center transition"
          >
            <Plus className="w-4 h-4" aria-hidden />
          </button>
          {menuOpen && (
            <div className="absolute z-20 bottom-full mb-1 left-0 min-w-[220px] rounded-lg bg-white border border-[#E8CFBB] shadow-lg py-1">
              <button
                type="button"
                onClick={onPickFiles}
                className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-[#2C1810] hover:bg-[#FAF3E7] transition"
              >
                <Upload className="w-4 h-4 text-[#8B4432]" aria-hidden />
                {t("chat.attach_file")}
              </button>
              {urlMode ? (
                <div className="px-3 py-2 flex items-center gap-2">
                  <LinkIcon className="w-4 h-4 text-[#8B4432] shrink-0" aria-hidden />
                  <input
                    ref={urlInputRef}
                    type="url"
                    value={urlValue}
                    onChange={(e) => setUrlValue(e.target.value)}
                    onKeyDown={onUrlKeyDown}
                    placeholder={t("chat.url_placeholder")}
                    className="flex-1 min-w-0 text-sm bg-transparent border-0 border-b border-[#E8CFBB] focus:border-[#D97757] focus:outline-none text-[#2C1810] placeholder:text-[#B89888] py-1"
                  />
                  <button
                    type="button"
                    onClick={onConfirmUrl}
                    className="text-xs text-[#D97757] hover:text-[#B85D3F]"
                  >
                    OK
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setUrlMode(true)}
                  className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-[#2C1810] hover:bg-[#FAF3E7] transition"
                >
                  <LinkIcon className="w-4 h-4 text-[#8B4432]" aria-hidden />
                  {t("chat.attach_url")}
                </button>
              )}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="*/*"
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
          disabled={disabled}
          className="flex-1 resize-none max-h-40 min-h-[40px] px-3 py-2 rounded-lg bg-white border border-[#E8CFBB] text-sm text-[#2C1810] placeholder:text-[#B89888] focus:outline-none focus:border-[#D97757] focus:ring-1 focus:ring-[#D97757] disabled:opacity-50"
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
            className="h-[40px] px-3 rounded-lg bg-[#D97757] hover:bg-[#B85D3F] disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm flex items-center gap-1.5 transition"
          >
            <Send className="w-3.5 h-3.5" aria-hidden />
            {t("chat.send")}
          </button>
        )}
      </div>
    </div>
  );
}
