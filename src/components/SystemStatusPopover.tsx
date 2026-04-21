// [START] SystemStatusPopover — inline expandable panel showing sidecar status,
// context indicator, and (conditionally) the session trash button.
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { SidecarIndicator } from "./SidecarIndicator";
import { ContextIndicator } from "./ContextIndicator";
import { useSessionsStore } from "../store/sessions";
import type { NavKey } from "./Sidebar";

interface SystemStatusPopoverProps {
  open: boolean;
  active: NavKey;
}

export function SystemStatusPopover({ open, active }: SystemStatusPopoverProps) {
  const { t } = useTranslation();
  const clearCurrentMessages = useSessionsStore((s) => s.clearCurrentMessages);
  const hasMessages = useSessionsStore((s) => s.messages.length > 0);

  if (!open) return null;

  return (
    <div className="mx-2 mb-2 bg-ovo-surface rounded-lg border border-ovo-border p-3 flex flex-col gap-2">
      {/* Sidecar status row */}
      <SidecarIndicator />

      {/* Divider */}
      <div className="h-px bg-ovo-border" aria-hidden="true" />

      {/* Context token ring + reset dropdown row */}
      <div className="px-1">
        <ContextIndicator />
      </div>

      {/* Tool mode moved to ChatPane input bar */}

      {/* Divider + trash button — only when chat tab is active and session has messages */}
      {active === "chat" && hasMessages && (
        <>
          <div className="h-px bg-ovo-border" aria-hidden="true" />
          <button
            type="button"
            onClick={() => void clearCurrentMessages()}
            className="flex items-center gap-2 w-full px-1 py-1 rounded-md text-ovo-muted hover:bg-ovo-surface-solid/60 hover:text-ovo-text transition text-xs"
            aria-label={t("chat.clear")}
            title={t("chat.clear")}
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden />
            <span>{t("chat.clear")}</span>
          </button>
        </>
      )}
    </div>
  );
}
// [END]
