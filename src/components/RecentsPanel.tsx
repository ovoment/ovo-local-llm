import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus, Search } from "lucide-react";
import { useSessionsStore } from "../store/sessions";
import { SessionItem } from "./SessionItem";

const STORAGE_KEY = "ovo:recents_expanded";

function loadExpanded(): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

// [START] RecentsPanel — collapsible session list with search, pinned/recent groups
export function RecentsPanel() {
  const { t } = useTranslation();
  const {
    sessions,
    currentSessionId,
    createSession,
    setSearchQuery,
    searchQuery,
  } = useSessionsStore();

  const [expanded, setExpanded] = useState<boolean>(loadExpanded);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [recentExpanded, setRecentExpanded] = useState(true);

  // Persist panel expand/collapse to localStorage
  const toggleExpanded = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, String(next));
      } catch {
        // storage unavailable, ignore
      }
      return next;
    });
  }, []);

  // Clear search on unmount
  useEffect(() => {
    return () => {
      setSearchQuery("");
    };
  }, [setSearchQuery]);

  const handleNewSession = useCallback(async () => {
    await createSession();
  }, [createSession]);

  const handleSearch = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
    },
    [setSearchQuery],
  );

  const pinnedSessions = sessions.filter((s) => s.pinned);
  const recentSessions = sessions.filter((s) => !s.pinned);
  const hasPinned = pinnedSessions.length > 0;

  return (
    <div className="border-t border-[#E8CFBB] flex flex-col">
      {/* [START] Panel header row */}
      <div className="flex items-center px-3 py-2 gap-1">
        <button
          onClick={toggleExpanded}
          className="flex items-center gap-1.5 flex-1 text-xs font-medium text-[#8B4432] hover:text-[#2C1810] transition-colors min-w-0"
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden />
          )}
          <span className="truncate">{t("recents.title")}</span>
        </button>
        <button
          onClick={handleNewSession}
          title={t("recents.new")}
          className="p-1 rounded hover:bg-[#F4D4B8] text-[#8B4432] hover:text-[#2C1810] transition-colors"
          aria-label={t("recents.new")}
        >
          <Plus className="w-3.5 h-3.5" aria-hidden />
        </button>
      </div>
      {/* [END] */}

      {/* [START] Collapsible body */}
      {expanded && (
        <div className="flex flex-col gap-1 pb-2">
          {/* Search input */}
          <div className="relative mx-3 mb-1">
            <Search
              className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[#C78D73]"
              aria-hidden
            />
            <input
              type="text"
              value={searchQuery}
              onChange={handleSearch}
              placeholder={t("recents.search_placeholder")}
              className="w-full pl-6 pr-2 py-1 text-xs bg-white/60 border border-[#E8CFBB] rounded-md text-[#2C1810] placeholder-[#C78D73] focus:outline-none focus:border-[#D97757] transition-colors"
            />
          </div>

          {/* Empty state */}
          {sessions.length === 0 && (
            <p className="px-4 text-xs text-[#C78D73] italic">
              {t("recents.empty")}
            </p>
          )}

          {/* [START] Pinned group */}
          {hasPinned && (
            <div>
              <button
                onClick={() => setPinnedExpanded((v) => !v)}
                className="flex items-center gap-1 w-full px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#C78D73] hover:text-[#8B4432] transition-colors"
              >
                {pinnedExpanded ? (
                  <ChevronDown className="w-3 h-3" aria-hidden />
                ) : (
                  <ChevronRight className="w-3 h-3" aria-hidden />
                )}
                {t("recents.pinned")}
              </button>
              {pinnedExpanded && (
                <ul className="px-2 flex flex-col gap-0.5">
                  {pinnedSessions.map((session) => (
                    <li key={session.id}>
                      <SessionItem
                        session={session}
                        isActive={session.id === currentSessionId}
                        maxContext={null}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {/* [END] */}

          {/* [START] Recent group */}
          {recentSessions.length > 0 && (
            <div>
              {hasPinned && (
                <button
                  onClick={() => setRecentExpanded((v) => !v)}
                  className="flex items-center gap-1 w-full px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#C78D73] hover:text-[#8B4432] transition-colors"
                >
                  {recentExpanded ? (
                    <ChevronDown className="w-3 h-3" aria-hidden />
                  ) : (
                    <ChevronRight className="w-3 h-3" aria-hidden />
                  )}
                  {t("recents.recent")}
                </button>
              )}
              {recentExpanded && (
                <ul className="px-2 flex flex-col gap-0.5">
                  {recentSessions.map((session) => (
                    <li key={session.id}>
                      <SessionItem
                        session={session}
                        isActive={session.id === currentSessionId}
                        maxContext={null}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {/* [END] */}
        </div>
      )}
      {/* [END] */}
    </div>
  );
}
