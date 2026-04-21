import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import {
  listModels,
  searchModels,
  searchImageModels,
  startDownload,
  startDownloadFromUrl,
  getDownload,
  getSystemInfo,
  listDownloads,
  deleteModel,
  cancelDownload,
  type SystemInfo,
} from "../lib/api";
import { RecommendedModels } from "../components/FitOverview";
import { Trash2, Loader2, Zap, Star, Gem } from "lucide-react";
import type { HfSearchResult, DownloadTask } from "../lib/api";
import { DownloadCell } from "../components/DownloadCell";
import {
  IMAGE_MODEL_CATALOG,
  catalogByCategory,
  type CatalogModel,
} from "../lib/image_model_catalog";
import { isImageGenModel, isChatCapableModel } from "../lib/models";
import { useSidecarStore } from "../store/sidecar";
import { useModelPerfStore } from "../store/model_perf";
import { FitOverview } from "../components/FitOverview";
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
  if (mins < 1) return i18n.t("models_pane.relative.just_now");
  if (mins < 60) return i18n.t("models_pane.relative.minutes_ago", { minutes: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return i18n.t("models_pane.relative.hours_ago", { hours });
  const days = Math.floor(hours / 24);
  return i18n.t("models_pane.relative.days_ago", { days });
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
  onDelete: (repoId: string) => void | Promise<void>;
  /** "mlx" = chat / code LLM search, "image" = text-to-image search */
  kind?: "mlx" | "image";
  /** Optional curated list rendered above the HF search box */
  catalog?: readonly CatalogModel[];
}

function HfDownloadSection({
  installedRepoIds,
  ports,
  onDownloadDone,
  onDelete,
  kind = "mlx",
  catalog,
}: HfDownloadSectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<HfSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  // [START] URL download input
  const [urlInput, setUrlInput] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  // [END]
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

  // [START] Polling loop — tick every 1.5 s, poll all "pending" | "downloading" tasks.
  // Uses a ref to read the latest tasks snapshot inside the interval callback so
  // the effect only re-runs when ports change (not on every task state update).
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const onDownloadDoneRef = useRef(onDownloadDone);
  onDownloadDoneRef.current = onDownloadDone;

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);

    pollRef.current = setInterval(() => {
      const currentTasks = tasksRef.current;
      const runningTasks = Object.values(currentTasks).filter(
        (tk) => tk.status === "pending" || tk.status === "downloading",
      );
      if (runningTasks.length === 0) return;

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
              onDownloadDoneRef.current();
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
  }, [ports, t]);
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
      const searchFn = kind === "image" ? searchImageModels : searchModels;
      searchFn(query.trim(), 25, ports)
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
  }, [query, ports, kind]);
  // [END]

  // [START] Phase 7 — cancel handler shared by search + catalog rows
  async function handleCancel(task: DownloadTask) {
    try {
      await cancelDownload(task.task_id, ports);
      setTasks((prev) => ({
        ...prev,
        [task.repo_id]: { ...task, cancel_requested: true },
      }));
      useToastsStore.getState().push({
        kind: "info",
        message: t("models.download.cancel_sent"),
      });
    } catch (e) {
      useToastsStore.getState().push({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
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

          {/* [START] Phase 7 — curated catalog (image tab only) */}
          {catalog && catalog.length > 0 && (
            <div className="mb-3">
              {(["official", "community"] as const).map((cat) => {
                const entries = catalogByCategory()[cat].filter((e) =>
                  catalog.some((c) => c.repo_id === e.repo_id),
                );
                if (entries.length === 0) return null;
                return (
                  <section key={cat} className="mb-3">
                    <h4 className="text-[10px] font-semibold uppercase tracking-wide text-ovo-muted mb-1.5">
                      {t(`image.header.catalog_${cat}`)}
                    </h4>
                    <ul className="grid gap-1">
                      {entries.map((entry) => {
                        const installed = installedRepoIds.has(entry.repo_id);
                        const task = tasks[entry.repo_id] ?? null;
                        return (
                          <li
                            key={entry.repo_id}
                            className="flex items-start gap-3 px-3 py-2 rounded-lg bg-ovo-surface border border-ovo-border"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-ovo-text truncate">
                                  {entry.name}
                                </span>
                                <span className="text-[10px] text-ovo-muted font-mono">
                                  {entry.size_hint}
                                </span>
                              </div>
                              <div className="text-[11px] text-ovo-muted mt-0.5">
                                {entry.description}
                              </div>
                              <div className="text-[10px] font-mono text-ovo-muted/60 mt-0.5 truncate">
                                {entry.repo_id}
                              </div>
                            </div>
                            <DownloadCell
                              repoId={entry.repo_id}
                              task={task ?? undefined}
                              already={installed}
                              onDownload={handleDownload}
                              onCancel={handleCancel}
                              onDelete={onDelete}
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
          {/* [END] */}

          {/* Search input */}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("models.download.search_placeholder")}
            className="w-full px-3 py-2 rounded-lg bg-ovo-surface border border-ovo-border text-sm text-ovo-text placeholder:text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent mb-2"
          />

          {/* [START] URL download input */}
          <div className="flex gap-2 mb-3">
            <input
              type="url"
              value={urlInput}
              onChange={(e) => { setUrlInput(e.target.value); setUrlError(null); }}
              placeholder="https://huggingface.co/org/model or org/model"
              className="flex-1 px-3 py-1.5 rounded-lg bg-ovo-surface border border-ovo-border text-xs text-ovo-text placeholder:text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent"
            />
            <button
              disabled={!urlInput.trim() || urlLoading}
              onClick={async () => {
                setUrlLoading(true);
                setUrlError(null);
                try {
                  const task = await startDownloadFromUrl(urlInput.trim(), ports);
                  if (task.status === "error") {
                    setUrlError(task.error ?? "Invalid URL");
                  } else {
                    setTasks((prev) => ({ ...prev, [task.repo_id]: task }));
                    setUrlInput("");
                    onDownloadDone();
                  }
                } catch (e) {
                  setUrlError(e instanceof Error ? e.message : String(e));
                } finally {
                  setUrlLoading(false);
                }
              }}
              className="px-3 py-1.5 rounded-lg bg-ovo-accent text-white text-xs font-medium disabled:opacity-40 hover:brightness-110 transition-all"
            >
              {urlLoading ? "..." : "↓ URL"}
            </button>
          </div>
          {urlError && (
            <p className="text-xs text-rose-500 px-1 -mt-2 mb-2">{urlError}</p>
          )}
          {/* [END] */}

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

                    {/* Action area — shared cell shows progress / cancel / delete */}
                    {isErr ? (
                      <button
                        type="button"
                        onClick={() => handleRetry(r.repo_id)}
                        className="text-[11px] text-rose-500 hover:text-rose-400 shrink-0 transition"
                      >
                        {t("common.retry")}
                      </button>
                    ) : (
                      <DownloadCell
                        repoId={r.repo_id}
                        task={task ?? undefined}
                        already={installed || Boolean(isDone)}
                        onDownload={handleDownload}
                        onCancel={handleCancel}
                        onDelete={onDelete}
                      />
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
      message: i18n.t("models_pane.mounted_toast", {
        repoId: repoId.split("/").pop() ?? repoId,
      }),
    });
  }
  // [END]
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  // [START] 4-tab layout: installed + fit + general(download+recs) + image(download)
  const [activeTab, setActiveTab] = useState<"installed" | "fit" | "general" | "image">("installed");
  // Set of repo_ids currently being deleted (rmtree can take seconds on big
  // models — UI dims the row + spins the trash icon so the click registers).
  const [deleting, setDeleting] = useState<Set<string>>(new Set());
  // [END]

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

  // [START] Phase 7 — force-delete model (HF + LM Studio). Confirm dialog,
  // then refreshes the list so the row disappears on success.
  async function handleDeleteModel(repoId: string) {
    if (!window.confirm(t("models.download.confirm_delete", { repo: repoId }))) return;
    // [START] Phase 7 — immediate visual feedback while rmtree runs.
    setDeleting((prev) => new Set(prev).add(repoId));
    useToastsStore.getState().push({
      kind: "info",
      message: t("models.download.delete_progress", { repo: repoId }),
    });
    try {
      await deleteModel(repoId, true, status.ports);
      useToastsStore.getState().push({
        kind: "info",
        message: t("models.download.delete_done", { repo: repoId }),
      });
      refreshModels();
    } catch (e) {
      useToastsStore.getState().push({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(repoId);
        return next;
      });
    }
    // [END]
  }
  // [END]

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
    getSystemInfo(status.ports).then((info) => {
      if (!cancelled) setSys(info);
    }).catch(() => {});
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

  // [START] Phase 7 — split models by tab (general LLM vs image-gen).
  // `filteredModels` drives the installed list + recommendations row; the
  // HF search + curated catalog are also swapped per tab.
  const imageModels = models.filter(isImageGenModel);
  const chatModels = models.filter(isChatCapableModel);
  const filteredModels = activeTab === "image" ? imageModels : chatModels;
  // [END]

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
    { label: t("models.rec.fastest"), Icon: Zap, model: fastest },
    { label: t("models.rec.most_used"), Icon: Star, model: mostUsed },
    { label: t("models.rec.best_value"), Icon: Gem, model: bestValue },
  ].filter((r) => r.model !== null);
  // [END]

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-ovo-text">{t("models.title")}</h2>
        <span className="text-xs text-ovo-muted">
          {t("models.count", { count: models.length })}
        </span>
      </div>

      {/* [START] 4-tab switcher */}
      <div className="flex flex-wrap rounded-md border border-ovo-border bg-ovo-surface p-0.5 mb-4 gap-0.5">
        {(["installed", "fit", "general", "image"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`px-2.5 py-1 text-xs rounded transition ${
              activeTab === tab
                ? "bg-ovo-accent text-ovo-accent-ink"
                : "text-ovo-muted hover:text-ovo-text"
            }`}
          >
            {t(`models.tab_${tab}`)}
            {tab === "installed" && (
              <span className="ml-1 font-mono tabular-nums text-[10px] opacity-70">
                {models.length}
              </span>
            )}
          </button>
        ))}
      </div>
      {/* [END] */}

      {/* [START] General tab — HF download + recommended models */}
      {activeTab === "general" && (
        <>
          <HfDownloadSection
            installedRepoIds={installedRepoIds}
            ports={status.ports}
            onDownloadDone={refreshModels}
            onDelete={handleDeleteModel}
            kind="mlx"
          />
          {sys && <RecommendedModels sys={sys} installed={models} />}
        </>
      )}
      {/* [END] */}

      {/* [START] Image tab — image model download */}
      {activeTab === "image" && (
        <HfDownloadSection
          installedRepoIds={installedRepoIds}
          ports={status.ports}
          onDownloadDone={refreshModels}
          onDelete={handleDeleteModel}
          kind="image"
          catalog={IMAGE_MODEL_CATALOG}
        />
      )}
      {/* [END] */}

      {/* [START] Fit tab — hardware fit only (no recommendations) */}
      {activeTab === "fit" && <FitOverview hideRecommendations />}
      {/* [END] */}

      {/* [START] Installed tab — recs + all installed models */}
      {activeTab === "installed" && (
        <>
          {recs.length > 0 && (
            <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
              {recs.map((r) =>
                r.model ? (
                  <button
                    key={r.label}
                    type="button"
                    onClick={() => r.model && void mountModel(r.model.repo_id)}
                    className="text-left p-3 rounded-lg bg-ovo-surface border border-ovo-border hover:bg-ovo-surface-solid transition text-center"
                    title={r.model.repo_id}
                  >
                    <r.Icon className="w-4 h-4 text-ovo-accent mx-auto mb-1" aria-hidden />
                    <div className="text-[10px] uppercase tracking-wide text-ovo-muted">{r.label}</div>
                    <div className="text-sm text-ovo-text truncate font-medium mt-1">
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
        </>
      )}
      {activeTab === "installed" && (filteredModels.length === 0 ? (
        <div className="flex items-center justify-center text-sm text-ovo-muted py-8">
          {t("models.empty")}
        </div>
      ) : (
        <ul className="grid gap-2">
          {filteredModels.map((m) => {
            const agg = perfStats[m.repo_id] ?? null;
            const isDeleting = deleting.has(m.repo_id);
            return (
            <li
              key={`${m.source}:${m.repo_id}:${m.revision}`}
              onClick={() => !isDeleting && void mountModel(m.repo_id)}
              className={`p-3 rounded-lg bg-ovo-surface border border-ovo-border flex items-center gap-4 transition ${
                isDeleting
                  ? "opacity-50 cursor-wait"
                  : "cursor-pointer hover:bg-ovo-surface-solid"
              }`}
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
                  {/* [START] Phase 7 — image generation badge */}
                  {m.capabilities?.includes("image_gen") && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/30 shrink-0">
                      🎨 {t("models.capability.image_gen")}
                    </span>
                  )}
                  {/* [END] */}
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
              {/* [START] Phase 7 — delete installed model */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!isDeleting) void handleDeleteModel(m.repo_id);
                }}
                disabled={isDeleting}
                className="p-1 rounded bg-transparent text-ovo-muted hover:bg-rose-500 hover:text-white transition shrink-0 disabled:opacity-40"
                title={t("models.download.delete_btn")}
              >
                {isDeleting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" aria-hidden />
                )}
              </button>
              {/* [END] */}
            </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}
