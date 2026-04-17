import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listModels, searchModels, startDownload, getDownload, listDownloads } from "../lib/api";
import type { HfSearchResult, DownloadTask } from "../lib/api";
import { useSidecarStore } from "../store/sidecar";
import { useModelPerfStore } from "../store/model_perf";
import { useSessionsStore } from "../store/sessions";
import { useToastsStore } from "../store/toasts";
import type { OvoModel, QuantizationConfig } from "../types/ovo";

// [START] Perf badge helpers — inline copy of the ModelSelector badge so the
// ModelsPane list can surface speed/recency info at a glance.
function perfColor(tps: number): string {
  if (tps >= 30) return "text-emerald-500";
  if (tps >= 15) return "text-amber-500";
  return "text-ovo-muted";
}

function relativeTime(epochMs: number): string {
  const diff = Math.max(0, Date.now() - epochMs);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "방금";
  if (mins < 60) return `${mins}분 전`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  return `${days}일 전`;
}
// [END]

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// [START] defensive formatters — HF config.json quantization is a nested object (layer → config), architecture may be a string[]
function isQuantizationConfig(v: unknown): v is QuantizationConfig {
  return typeof v === "object" && v !== null;
}

function formatQuantization(q: OvoModel["quantization"]): string | null {
  if (q == null) return null;
  if (typeof q === "string") return q;
  if (isQuantizationConfig(q)) {
    const bits = typeof q.bits === "number" ? `Q${q.bits}` : null;
    const group = typeof q.group_size === "number" ? `g${q.group_size}` : null;
    return [bits, group].filter(Boolean).join(" ") || null;
  }
  return null;
}

function formatArchitecture(a: OvoModel["architecture"]): string | null {
  if (a == null) return null;
  if (typeof a === "string") return a;
  if (Array.isArray(a)) return a.join(", ") || null;
  return null;
}
// [END]

// [START] HF Download section — search, download, poll, refresh installed list
function formatCount(n: number | undefined): string {
  if (n == null) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

interface HfDownloadSectionProps {
  installedRepoIds: Set<string>;
  ports: ReturnType<typeof useSidecarStore.getState>["status"]["ports"];
  onDownloadDone: () => void;
}

function HfDownloadSection({ installedRepoIds, ports, onDownloadDone }: HfDownloadSectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HfSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // tasks keyed by repo_id for fast lookup
  const [tasks, setTasks] = useState<Record<string, DownloadTask>>({});
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // [START] Initial load — pick up tasks from previous session
  useEffect(() => {
    listDownloads(ports)
      .then((list) => {
        const map: Record<string, DownloadTask> = {};
        for (const task of list) {
          map[task.repo_id] = task;
        }
        setTasks(map);
      })
      .catch(() => {
        // non-fatal — sidecar may not have any tasks yet
      });
  }, [ports]);
  // [END]

  // [START] Polling loop — tick every 1.5 s, poll all "pending" | "downloading" tasks
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);

    const runningTasks = Object.values(tasks).filter(
      (t) => t.status === "pending" || t.status === "downloading",
    );
    if (runningTasks.length === 0) return;

    pollRef.current = setInterval(() => {
      void Promise.all(
        runningTasks.map((task) =>
          getDownload(task.task_id, ports).then((updated) => {
            setTasks((prev) => ({ ...prev, [updated.repo_id]: updated }));
            if (updated.status === "done") {
              useToastsStore.getState().push({
                kind: "success",
                message: t("models.download.download_done", {
                  repo: updated.repo_id.split("/").pop() ?? updated.repo_id,
                }),
              });
              onDownloadDone();
            } else if (updated.status === "error") {
              useToastsStore.getState().push({
                kind: "error",
                message: t("models.download.download_error", { error: updated.error ?? "unknown" }),
              });
            }
          }).catch(() => {
            // swallow transient poll errors
          }),
        ),
      );
    }, 1500);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [tasks, ports, t, onDownloadDone]);
  // [END]

  // [START] Debounced search — 300 ms after last keystroke
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setSearchError(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      setSearching(true);
      setSearchError(null);
      searchModels(query.trim(), 25, ports)
        .then((res) => {
          setResults(res);
        })
        .catch((e: unknown) => {
          setSearchError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setSearching(false));
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, ports]);
  // [END]

  function handleDownload(repoId: string) {
    startDownload(repoId, ports)
      .then((task) => {
        setTasks((prev) => ({ ...prev, [repoId]: task }));
        useToastsStore.getState().push({
          kind: "info",
          message: t("models.download.download_started", {
            repo: repoId.split("/").pop() ?? repoId,
          }),
        });
      })
      .catch((e: unknown) => {
        useToastsStore.getState().push({
          kind: "error",
          message: t("models.download.download_error", {
            error: e instanceof Error ? e.message : String(e),
          }),
        });
      });
  }

  function handleRetry(repoId: string) {
    setTasks((prev) => {
      const next = { ...prev };
      delete next[repoId];
      return next;
    });
    handleDownload(repoId);
  }

  return (
    <div className="mb-6">
      {/* Section header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 mb-3 group"
      >
        <svg
          className="w-4 h-4 text-ovo-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <span className="text-sm font-semibold text-ovo-text">
          {t("models.download.section_title")}
        </span>
        <svg
          className={`w-3.5 h-3.5 text-ovo-muted ml-auto transition-transform ${open ? "" : "-rotate-90"}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div>
          {/* Tip */}
          <p className="text-[11px] text-ovo-muted mb-2 leading-relaxed">
            {t("models.download.tip")}
          </p>

          {/* Search input */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("models.download.search_placeholder")}
            className="w-full px-3 py-2 rounded-lg bg-ovo-surface border border-ovo-border text-sm text-ovo-text placeholder:text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent mb-3"
          />

          {/* Results */}
          {searching && (
            <p className="text-xs text-ovo-muted px-1">{t("common.loading")}</p>
          )}
          {searchError && (
            <p className="text-xs text-rose-600 px-1">{searchError}</p>
          )}
          {!searching && !searchError && query.trim() && results.length === 0 && (
            <p className="text-xs text-ovo-muted px-1">{t("models.download.empty_results")}</p>
          )}
          {results.length > 0 && (
            <ul className="grid gap-1.5">
              {results.map((r) => {
                const installed = installedRepoIds.has(r.repo_id);
                const task = tasks[r.repo_id] ?? null;
                const isRunning = task && (task.status === "pending" || task.status === "downloading");
                const isDone = task && task.status === "done";
                const isErr = task && task.status === "error";

                return (
                  <li
                    key={r.repo_id}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-ovo-surface border border-ovo-border"
                  >
                    {/* repo id + badges */}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono text-ovo-text truncate">{r.repo_id}</div>
                      <div className="flex gap-2 mt-0.5 flex-wrap">
                        {r.downloads != null && r.downloads > 0 && (
                          <span className="text-[10px] text-ovo-muted">
                            ↓ {formatCount(r.downloads)}
                          </span>
                        )}
                        {r.likes != null && r.likes > 0 && (
                          <span className="text-[10px] text-ovo-muted">
                            ♥ {formatCount(r.likes)}
                          </span>
                        )}
                        {isErr && (
                          <span className="text-[10px] text-rose-500 truncate max-w-[180px]">
                            {t("models.download.download_error", { error: task.error ?? "unknown" })}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Action button */}
                    {installed || isDone ? (
                      <span className="text-[11px] text-ovo-muted shrink-0">
                        {t("models.download.installed")}
                      </span>
                    ) : isRunning ? (
                      <span className="text-[11px] text-ovo-muted shrink-0 animate-pulse">
                        {t("models.download.downloading")}
                      </span>
                    ) : isErr ? (
                      <button
                        type="button"
                        onClick={() => handleRetry(r.repo_id)}
                        className="text-[11px] text-rose-500 hover:text-rose-400 shrink-0 transition"
                      >
                        {t("common.retry")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleDownload(r.repo_id)}
                        className="text-[11px] px-2 py-1 rounded bg-ovo-accent text-white hover:opacity-90 shrink-0 transition"
                      >
                        {t("models.download.download_btn")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
// [END]

export function ModelsPane() {
  const { t } = useTranslation();
  const status = useSidecarStore((s) => s.status);
  const perfStats = useModelPerfStore((s) => s.stats);
  const [models, setModels] = useState<OvoModel[]>([]);

  // [START] Auto-mount on click — sets repo_id as the current session's
  // model_ref (or creates a fresh session with it if none exists).
  async function mountModel(repoId: string): Promise<void> {
    const { currentSessionId, setSessionModel, createSession } =
      useSessionsStore.getState();
    if (currentSessionId) {
      await setSessionModel(currentSessionId, repoId);
    } else {
      await createSession({ model_ref: repoId });
    }
    useToastsStore.getState().push({
      kind: "success",
      message: `${repoId.split("/").pop() ?? repoId} 마운트됨`,
    });
  }
  // [END]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refreshModels() {
    if (status.health !== "healthy") return;
    setLoading(true);
    setError(null);
    listModels(status.ports)
      .then((resp) => {
        setModels(resp.models);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        setLoading(false);
      });
  }

  useEffect(() => {
    if (status.health !== "healthy") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listModels(status.ports)
      .then((resp) => {
        if (!cancelled) setModels(resp.models);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status.health, status.ports]);

  if (status.health !== "healthy") {
    return (
      <div className="h-full flex items-center justify-center text-sm text-ovo-muted">
        {t(`sidecar.status.${status.health}`)}…
      </div>
    );
  }

  if (loading) {
    return <div className="p-6 text-sm text-ovo-muted">{t("common.loading")}</div>;
  }

  if (error) {
    return (
      <div className="p-6 text-sm text-rose-600">
        {t("common.error")}: {error}
      </div>
    );
  }

  const installedRepoIds = new Set(models.map((m) => m.repo_id));

  // [START] Recommendations — compute top models per dimension using perf stats
  const rankedModels = models.filter((m) => (perfStats[m.repo_id]?.runs ?? 0) >= 1);
  const fastest = rankedModels.reduce<OvoModel | null>((best, m) => {
    const tps = perfStats[m.repo_id]?.avg_tokens_per_sec ?? 0;
    const bestTps = best ? perfStats[best.repo_id]?.avg_tokens_per_sec ?? 0 : -1;
    return tps > bestTps ? m : best;
  }, null);
  const mostUsed = rankedModels.reduce<OvoModel | null>((best, m) => {
    const runs = perfStats[m.repo_id]?.runs ?? 0;
    const bestRuns = best ? perfStats[best.repo_id]?.runs ?? 0 : -1;
    return runs > bestRuns ? m : best;
  }, null);
  const bestValue = rankedModels.reduce<OvoModel | null>((best, m) => {
    const tps = perfStats[m.repo_id]?.avg_tokens_per_sec ?? 0;
    const gb = Math.max(1, m.size_bytes / 1024 ** 3);
    const score = tps / gb;
    const bestScore = best
      ? (perfStats[best.repo_id]?.avg_tokens_per_sec ?? 0) /
        Math.max(1, best.size_bytes / 1024 ** 3)
      : -1;
    return score > bestScore ? m : best;
  }, null);
  const recs = [
    { label: t("models.rec.fastest"), icon: "🏆", model: fastest },
    { label: t("models.rec.most_used"), icon: "⭐", model: mostUsed },
    { label: t("models.rec.best_value"), icon: "💎", model: bestValue },
  ].filter((r) => r.model !== null);
  // [END]

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-ovo-text">{t("models.title")}</h2>
        <span className="text-xs text-ovo-muted">{t("models.count", { count: models.length })}</span>
      </div>

      {/* [START] HF Download section — always rendered at the top when healthy */}
      <HfDownloadSection
        installedRepoIds={installedRepoIds}
        ports={status.ports}
        onDownloadDone={refreshModels}
      />
      {/* [END] */}

      {/* [START] Recommendations row — only rendered if at least one model has perf data */}
      {recs.length > 0 && (
        <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-2">
          {recs.map((r) =>
            r.model ? (
              <button
                key={r.label}
                type="button"
                onClick={() => r.model && void mountModel(r.model.repo_id)}
                className="text-left p-3 rounded-lg bg-ovo-surface border border-ovo-border flex flex-col gap-1 hover:bg-ovo-surface-solid transition"
                title={r.model.repo_id}
              >
                <div className="text-[10px] uppercase tracking-wide text-ovo-muted flex items-center gap-1">
                  <span aria-hidden>{r.icon}</span>
                  <span>{r.label}</span>
                </div>
                <div className="text-sm text-ovo-text truncate font-medium">
                  {r.model.repo_id.split("/").pop() ?? r.model.repo_id}
                </div>
                <div className={`text-[11px] font-mono ${perfColor(perfStats[r.model.repo_id]?.avg_tokens_per_sec ?? 0)}`}>
                  {(perfStats[r.model.repo_id]?.avg_tokens_per_sec ?? 0).toFixed(1)} t/s
                </div>
              </button>
            ) : null,
          )}
        </div>
      )}
      {/* [END] */}

      {models.length === 0 ? (
        <div className="flex items-center justify-center text-sm text-ovo-muted py-8">
          {t("models.empty")}
        </div>
      ) : (
        <ul className="grid gap-2">
          {models.map((m) => {
            const agg = perfStats[m.repo_id] ?? null;
            return (
            <li
              key={`${m.source}:${m.repo_id}:${m.revision}`}
              onClick={() => void mountModel(m.repo_id)}
              className="p-3 rounded-lg bg-ovo-surface border border-ovo-border flex items-center gap-4 cursor-pointer hover:bg-ovo-surface-solid transition"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="text-sm font-medium text-ovo-text truncate">{m.repo_id}</div>
                  {/* [START] capability badges — makes vision/audio models
                      visually distinct from text-only LLMs at a glance */}
                  {m.capabilities?.includes("vision") && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-sky-500/15 text-sky-400 border border-sky-500/30 shrink-0">
                      👁 {t("models.capability.vision")}
                    </span>
                  )}
                  {m.capabilities?.includes("audio") && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-fuchsia-500/15 text-fuchsia-400 border border-fuchsia-500/30 shrink-0">
                      🎧 {t("models.capability.audio")}
                    </span>
                  )}
                  {/* [END] */}
                </div>
                <div className="text-[11px] text-ovo-muted mt-0.5 flex gap-3 flex-wrap">
                  <span>{t(`models.source.${m.source}`)}</span>
                  {formatArchitecture(m.architecture) && (
                    <span>{formatArchitecture(m.architecture)}</span>
                  )}
                  {formatQuantization(m.quantization) && (
                    <span>{formatQuantization(m.quantization)}</span>
                  )}
                  {/* [START] Perf summary — only rendered when model has been used */}
                  {agg && (
                    <>
                      <span className={`font-mono ${perfColor(agg.avg_tokens_per_sec)}`}>
                        {agg.avg_tokens_per_sec.toFixed(1)} t/s
                      </span>
                      <span>
                        {t("models.perf.runs", { count: agg.runs })}
                      </span>
                      <span>
                        {t("models.perf.last_used", { when: relativeTime(agg.last_used_at) })}
                      </span>
                    </>
                  )}
                  {/* [END] */}
                </div>
              </div>
              <div className="text-xs text-ovo-muted tabular-nums shrink-0">
                {formatSize(m.size_bytes)}
              </div>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
