import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useSessionsStore } from "../store/sessions";
import { runCompact, resolveMaxContext, resolveWarnThreshold } from "../lib/compact";

// [START] ContextIndicator — SVG donut ring showing context usage for the
// current session. Color thresholds are dynamic based on resolveWarnThreshold.
// Uses shared resolveMaxContext / resolveWarnThreshold helpers from compact.ts.

const RADIUS = 13;
const STROKE_WIDTH = 3;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// [START] Dynamic color tiers — green < (threshold * 0.66), yellow < threshold,
// orange < threshold + (1-threshold)*0.5, red >= that.
function getColorClass(percent: number, threshold: number): string {
  const t = threshold * 100;
  const green = t * 0.66;
  const orange = t + (100 - t) * 0.5;
  if (percent < green) return "text-emerald-500";
  if (percent < t) return "text-amber-500";
  if (percent < orange) return "text-orange-500";
  return "text-rose-500";
}

function getStrokeColor(percent: number, threshold: number): string {
  const t = threshold * 100;
  const green = t * 0.66;
  const orange = t + (100 - t) * 0.5;
  if (percent < green) return "#10b981"; // emerald-500
  if (percent < t) return "#f59e0b"; // amber-500
  if (percent < orange) return "#f97316"; // orange-500
  return "#f43f5e"; // rose-500
}
// [END]

function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function ContextIndicator() {
  const { t } = useTranslation();

  const currentSessionId = useSessionsStore((s) => s.currentSessionId);
  const sessions = useSessionsStore((s) => s.sessions);
  const escapeToNewSession = useSessionsStore((s) => s.escapeToNewSession);
  const clearCurrentMessages = useSessionsStore((s) => s.clearCurrentMessages);

  // [START] Resolved per-model max_context and warn_threshold.
  // Re-resolved whenever modelRef changes.
  const [maxContext, setMaxContext] = useState<number>(8192);
  const [warnThreshold, setWarnThreshold] = useState<number>(0.75);

  const session = sessions.find((s) => s.id === currentSessionId);
  const modelRef = session?.model_ref ?? null;

  useEffect(() => {
    let cancelled = false;
    void resolveMaxContext(modelRef).then((val) => {
      if (!cancelled) setMaxContext(val);
    });
    setWarnThreshold(resolveWarnThreshold(modelRef));
    return () => { cancelled = true; };
  }, [modelRef]);
  // [END]

  const [showTooltip, setShowTooltip] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // [START] click-outside closes the Reset dropdown
  useEffect(() => {
    if (!dropdownOpen) return;
    function handleOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [dropdownOpen]);
  // [END]

  // Hide entirely when no session is active
  if (!currentSessionId) return null;
  if (!session) return null;

  const contextTokens = session.context_tokens;

  const progress = Math.min(contextTokens / maxContext, 1);
  const percent = Math.round(progress * 100);
  const remaining = 100 - percent;

  const strokeColor = getStrokeColor(percent, warnThreshold);
  const textColorClass = getColorClass(percent, warnThreshold);

  const dashOffset = CIRCUMFERENCE * (1 - progress);

  // [START] ring click = manual compact
  function handleRingClick() {
    if (!currentSessionId) return;
    void runCompact(currentSessionId, { strategy: "manual" });
  }
  // [END]

  async function handleEscape() {
    setDropdownOpen(false);
    await escapeToNewSession();
  }

  async function handleClear() {
    setDropdownOpen(false);
    await clearCurrentMessages();
  }

  return (
    <div className="flex items-center gap-2 relative select-none">
      {/* [START] SVG donut ring */}
      <div
        className="relative cursor-pointer"
        title=""
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onClick={handleRingClick}
      >
        <svg
          width="32"
          height="32"
          viewBox="0 0 32 32"
          aria-label={`${t("context.tooltip_remaining", { percent: remaining })}`}
        >
          {/* background track */}
          <circle
            cx="16"
            cy="16"
            r={RADIUS}
            fill="none"
            stroke={strokeColor}
            strokeWidth={STROKE_WIDTH}
            opacity={0.2}
          />
          {/* foreground progress */}
          <circle
            cx="16"
            cy="16"
            r={RADIUS}
            fill="none"
            stroke={strokeColor}
            strokeWidth={STROKE_WIDTH}
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
            strokeLinecap="round"
            transform="rotate(-90 16 16)"
          />
        </svg>

        {/* Tooltip */}
        {showTooltip && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-56 rounded-lg bg-[#2C1810] text-[#FAF3E7] text-[11px] p-3 shadow-lg pointer-events-none whitespace-pre-line">
            <p className="font-medium mb-1">
              {t("context.tooltip_remaining", { percent: remaining })}
            </p>
            <p className="opacity-80">
              {t("context.tooltip_usage", {
                used: formatNumber(contextTokens),
                total: formatNumber(maxContext),
              })}
            </p>
            <p className="opacity-60 mt-1">{t("context.tooltip_click_to_compact")}</p>
          </div>
        )}
      </div>
      {/* [END] */}

      {/* [START] token count label */}
      <span className={`text-[10px] tabular-nums font-medium ${textColorClass}`}>
        {formatNumber(contextTokens)}&thinsp;/&thinsp;{formatNumber(maxContext)}
        &nbsp;({percent}%)
      </span>
      {/* [END] */}

      {/* [START] Reset dropdown */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setDropdownOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-[#E8CFBB] text-[#2C1810] hover:bg-[#D97757] hover:text-white transition"
          aria-label={t("context.reset")}
          title={t("context.reset")}
        >
          <RotateCcw size={12} />
          <span>{t("context.reset")}</span>
        </button>

        {dropdownOpen && (
          <div className="absolute bottom-full right-0 mb-1 z-50 min-w-[160px] rounded-lg bg-white border border-[#E8CFBB] shadow-lg overflow-hidden">
            <button
              onClick={() => void handleEscape()}
              className="w-full text-left text-[12px] px-3 py-2 hover:bg-[#FAF3E7] text-[#2C1810] transition"
            >
              {t("context.escape_to_new")}
            </button>
            <button
              onClick={() => void handleClear()}
              className="w-full text-left text-[12px] px-3 py-2 hover:bg-[#FAF3E7] text-[#2C1810] transition"
            >
              {t("context.clear_messages")}
            </button>
          </div>
        )}
      </div>
      {/* [END] */}
    </div>
  );
}
