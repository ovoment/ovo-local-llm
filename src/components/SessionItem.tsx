import { useRef, useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Pin, PinOff, Pencil, Trash2 } from "lucide-react";
import type { Session } from "../types/ovo";
import { useSessionsStore } from "../store/sessions";

// [START] Context micro-dot: 4px circle color-coded by usage ratio
const FALLBACK_MAX_CONTEXT = 8192;

function getContextDotColor(tokens: number, maxContext: number | null): string {
  const max = maxContext ?? FALLBACK_MAX_CONTEXT;
  if (max <= 0) return "bg-gray-400";
  const ratio = tokens / max;
  if (ratio >= 0.75) return "bg-red-500";
  if (ratio >= 0.5) return "bg-yellow-400";
  return "bg-green-500";
}
// [END]

// [START] Context menu state type
interface ContextMenuState {
  x: number;
  y: number;
}
// [END]

interface SessionItemProps {
  session: Session;
  isActive: boolean;
  /** max_context from model overrides; null = unknown */
  maxContext: number | null;
}

export function SessionItem({ session, isActive, maxContext }: SessionItemProps) {
  const { t } = useTranslation();
  const { selectSession, renameSession, togglePinned, deleteSession } =
    useSessionsStore();

  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(session.title);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // [START] Close context menu on outside click or Esc
  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
        setConfirmDelete(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        setConfirmDelete(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu]);
  // [END]

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renaming) {
      setDraftTitle(session.title);
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [renaming, session.title]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
    setConfirmDelete(false);
  }, []);

  const handleClick = useCallback(() => {
    if (!renaming) selectSession(session.id);
  }, [renaming, selectSession, session.id]);

  // [START] Inline rename commit / cancel
  const commitRename = useCallback(async () => {
    const trimmed = draftTitle.trim();
    if (trimmed && trimmed !== session.title) {
      await renameSession(session.id, trimmed);
    }
    setRenaming(false);
  }, [draftTitle, renameSession, session.id, session.title]);

  const cancelRename = useCallback(() => {
    setDraftTitle(session.title);
    setRenaming(false);
  }, [session.title]);
  // [END]

  const handleMenuRename = () => {
    setMenu(null);
    setRenaming(true);
  };

  const handleMenuPin = async () => {
    setMenu(null);
    await togglePinned(session.id);
  };

  const handleMenuDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setMenu(null);
    setConfirmDelete(false);
    deleteSession(session.id);
  };

  const dotColor = getContextDotColor(session.context_tokens, maxContext);

  // Shorten model_ref for badge display (take last path segment)
  const modelBadge = session.model_ref
    ? session.model_ref.split("/").pop() ?? session.model_ref
    : null;

  return (
    <>
      {/* [START] Session row */}
      <div
        role="button"
        tabIndex={0}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDoubleClick={() => !renaming && setRenaming(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !renaming) selectSession(session.id);
        }}
        className={`group relative flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer select-none text-sm transition-colors ${
          isActive
            ? "bg-[#F4D4B8] text-[#2C1810]"
            : "text-[#5C3828] hover:bg-[#F4D4B8]/60"
        }`}
      >
        {/* Pin indicator */}
        {session.pinned && (
          <Pin className="w-3 h-3 text-[#D97757] shrink-0" aria-hidden />
        )}

        {/* Title or inline rename input */}
        <div className="flex-1 min-w-0">
          {renaming ? (
            <input
              ref={inputRef}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") cancelRename();
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-white/80 border border-[#D97757] rounded px-1 py-0.5 text-[#2C1810] text-sm outline-none"
            />
          ) : (
            <span className="block truncate">{session.title}</span>
          )}
        </div>

        {/* Right side: context dot + model badge */}
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Context micro-dot — 4px */}
          {/* TODO R.6: replace FALLBACK_MAX_CONTEXT with lookup via src/db/model_overrides.ts */}
          <span
            className={`inline-block w-1 h-1 rounded-full ${dotColor}`}
            title={`${session.context_tokens} tokens`}
            aria-hidden
          />
          {modelBadge && (
            <span className="text-[10px] text-[#C78D73] truncate max-w-[60px]">
              {modelBadge}
            </span>
          )}
        </div>
      </div>
      {/* [END] */}

      {/* [START] Context menu */}
      {menu && (
        <div
          ref={menuRef}
          style={{ top: menu.y, left: menu.x }}
          className="fixed z-50 min-w-[140px] bg-white border border-[#E8CFBB] rounded-lg shadow-lg py-1 text-sm text-[#2C1810]"
        >
          <button
            onClick={handleMenuRename}
            className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-[#FAF3E7] transition-colors"
          >
            <Pencil className="w-3.5 h-3.5 text-[#8B4432]" aria-hidden />
            {t("recents.rename")}
          </button>
          <button
            onClick={handleMenuPin}
            className="flex items-center gap-2 w-full px-3 py-1.5 hover:bg-[#FAF3E7] transition-colors"
          >
            {session.pinned ? (
              <PinOff className="w-3.5 h-3.5 text-[#8B4432]" aria-hidden />
            ) : (
              <Pin className="w-3.5 h-3.5 text-[#8B4432]" aria-hidden />
            )}
            {session.pinned ? t("recents.unpin") : t("recents.pin")}
          </button>
          <div className="h-px bg-[#E8CFBB] my-1" />
          <button
            onClick={handleMenuDelete}
            className={`flex items-center gap-2 w-full px-3 py-1.5 transition-colors ${
              confirmDelete
                ? "bg-red-50 text-red-600 hover:bg-red-100"
                : "hover:bg-[#FAF3E7] text-red-500"
            }`}
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden />
            {confirmDelete ? t("recents.confirm_delete") : t("recents.delete")}
          </button>
        </div>
      )}
      {/* [END] */}
    </>
  );
}
