// [START] Phase 8 — Fit Overview card (llmfit Step 1).
// Sits at the top of ModelsPane: surfaces the host hardware and classifies
// each installed model by whether it comfortably runs, runs tight, or won't
// fit at all on this machine. Answers the recurring "should I download
// this?" / "why is this model crashing the app?" question at a glance.
//
// Step 1 is RAM-only scoring. Step 2 will add a curated catalog with
// quality / speed / context-length axes and pull everything into its own
// Fit pane.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Sparkles,
  Loader2,
  AlertCircle,
  Download,
  Check,
} from "lucide-react";
import {
  getSystemInfo,
  listModels,
  searchModels,
  startDownload,
  getDownload,
  type SystemInfo,
  type HfSearchResult,
} from "../lib/api";
import { useSidecarStore } from "../store/sidecar";
import { useToastsStore } from "../store/toasts";
import {
  assessFit,
  estimateModelBytes,
  formatBytes,
  scoreCatalogFit,
  classifyUseCase,
  detectExecutionMode,
  detectQuantLabel,
  estimateTokensPerSec,
  heuristicQuality,
  memoryUsagePct,
  parseParamsB,
  classifyModelTier,
  type FitTier,
  type ModelTier,
  type ScoreBreakdown,
} from "../lib/modelFit";
import {
  loadCatalog,
  isCatalogInstalled,
  type CuratedModel,
  type ModelKind,
} from "../lib/modelCatalog";
import type { OvoModel } from "../types/ovo";

// Style per tier — the human-readable label is fetched via i18n at render
// time so the same component localises cleanly.
// [START] Phase 5 — Tier badge colour tokens.
// Supported = cool emerald (trust), Experimental = warm amber (caution),
// Unknown = neutral ovo-muted. Applied via `border`+`bg`+`text` triplet so
// the badge reads clearly regardless of the surrounding row background.
const TIER_BADGE_STYLE: Record<ModelTier, string> = {
  supported:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-500",
  experimental:
    "border-amber-500/40 bg-amber-500/10 text-amber-500",
  unknown:
    "border-ovo-border bg-ovo-chip text-ovo-muted",
};
// [END]

const TIER_STYLE: Record<FitTier, { cls: string; dot: string }> = {
  perfect: {
    cls: "text-emerald-500 bg-emerald-500/10 border-emerald-500/30",
    dot: "bg-emerald-500",
  },
  good: {
    cls: "text-sky-500 bg-sky-500/10 border-sky-500/30",
    dot: "bg-sky-500",
  },
  tight: {
    cls: "text-amber-500 bg-amber-500/10 border-amber-500/30",
    dot: "bg-amber-500",
  },
  unfit: {
    cls: "text-rose-500 bg-rose-500/10 border-rose-500/30",
    dot: "bg-rose-500",
  },
  unknown: {
    cls: "text-ovo-muted bg-ovo-chip border-ovo-border",
    dot: "bg-ovo-muted",
  },
};

export function FitOverview({ hideRecommendations = false }: { hideRecommendations?: boolean } = {}) {
  const { t } = useTranslation();
  const sidecarHealth = useSidecarStore((s) => s.status.health);
  const ports = useSidecarStore((s) => s.status.ports);

  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [models, setModels] = useState<OvoModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (sidecarHealth !== "healthy") return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([getSystemInfo(ports), listModels(ports)])
      .then(([info, resp]) => {
        if (cancelled) return;
        setSys(info);
        setModels(resp.models);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sidecarHealth, ports]);

  const assessments = useMemo(() => {
    return models
      .map((m) => ({
        model: m,
        est: estimateModelBytes(m),
        fit: assessFit(m, sys),
      }))
      .sort((a, b) => b.fit.score - a.fit.score);
  }, [models, sys]);

  const tierCounts = useMemo(() => {
    const c: Record<FitTier, number> = {
      perfect: 0,
      good: 0,
      tight: 0,
      unfit: 0,
      unknown: 0,
    };
    for (const a of assessments) c[a.fit.tier] += 1;
    return c;
  }, [assessments]);

  if (sidecarHealth !== "healthy") {
    return (
      <section className="rounded-xl border border-ovo-border bg-ovo-surface px-4 py-3 text-xs text-ovo-muted">
        <div className="flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          <span>{t("models.fit.sidecar_offline")}</span>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* [START] HW spec banner */}
      {sys && (
        <div className="grid grid-cols-4 gap-3">
          <div className="p-3 rounded-lg bg-ovo-surface border border-ovo-border text-center">
            <Cpu className="w-4 h-4 text-ovo-accent mx-auto mb-1" />
            <div className="text-sm font-semibold text-ovo-text">{sys.cpu.brand || "Apple Silicon"}</div>
            <div className="text-[10px] text-ovo-muted">{sys.cpu.logical_cores} {t("models.fit.cores_unit")}</div>
          </div>
          <div className="p-3 rounded-lg bg-ovo-surface border border-ovo-border text-center">
            <Sparkles className="w-4 h-4 text-ovo-accent mx-auto mb-1" />
            <div className="text-sm font-semibold text-ovo-text">{sys.gpu.unified ? t("models.fit.unified_gpu") : "GPU"}</div>
            <div className="text-[10px] text-ovo-muted">{sys.gpu.kind || "Metal"}</div>
          </div>
          <div className="p-3 rounded-lg bg-ovo-surface border border-ovo-border text-center">
            <MemoryStick className="w-4 h-4 text-ovo-accent mx-auto mb-1" />
            <div className="text-sm font-semibold text-ovo-text">{formatBytes(sys.memory.total_bytes)}</div>
            <div className="text-[10px] text-ovo-muted">RAM</div>
          </div>
          <div className="p-3 rounded-lg bg-ovo-surface border border-ovo-border text-center">
            <HardDrive className="w-4 h-4 text-ovo-accent mx-auto mb-1" />
            <div className="text-sm font-semibold text-ovo-text">{formatBytes(sys.disk.free_bytes)}</div>
            <div className="text-[10px] text-ovo-muted">{t("models.fit.disk_free")}</div>
          </div>
        </div>
      )}
      {/* [END] */}

      {loading && (
        <div className="flex items-center gap-2 text-xs text-ovo-muted">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          {t("models.fit.scanning")}
        </div>
      )}

      {/* [START] 16GB Lite Mode banner */}
      {sys && sys.memory.total_bytes <= 17_179_869_184 && (
        <div className="px-4 py-2 rounded-lg text-xs text-amber-400 bg-amber-500/5 border border-amber-500/20 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span>
            {t("models.fit.lite_mode", "Lite Mode — 16GB RAM detected. Only 7B Q4 models are recommended. Disable extra features in Settings for best performance.")}
          </span>
        </div>
      )}
      {/* [END] */}
      {error && (
        <div className="px-4 py-2 rounded-lg text-xs text-rose-400 bg-rose-500/5 border border-rose-500/20">
          {error}
        </div>
      )}

      {/* [START] Tier summary bar */}
      {sys && assessments.length > 0 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-wrap text-[11px]">
            {(Object.entries(tierCounts) as Array<[FitTier, number]>)
              .filter(([, n]) => n > 0)
              .map(([tier, n]) => (
                <div key={tier} className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${TIER_STYLE[tier].dot}`} />
                  <span className="text-ovo-muted">
                    <span className="text-ovo-text font-semibold">{n}</span>{" "}
                    {t(`models.fit.tier.${tier}`)}
                  </span>
                </div>
              ))}
          </div>
          <span className="text-[10px] text-ovo-muted/60">
            {t("models.fit.mlx_notice", "MLX models run fastest on Apple Silicon")}
          </span>
        </div>
      )}
      {/* [END] */}

      {/* [START] Model fit list — full width, no scroll container */}
      {assessments.length === 0 && !loading ? (
        <div className="py-6 text-center text-xs text-ovo-muted">
          {t("models.fit.empty")}
          </div>
        ) : (
          <ul className="divide-y divide-ovo-border/40 rounded-lg border border-ovo-border overflow-hidden">
            {assessments.map(({ model, est, fit }) => {
              // [START] Phase 5 — llmfit-style row metadata.
              // Compute once per row; none of these helpers mutate so we can
              // cheaply call them inline without memoisation.
              const params = parseParamsB(model.repo_id);
              const paramsB = params?.totalB ?? 0;
              const activeB = params?.activeB ?? null;
              const quant = detectQuantLabel(model);
              const mode = detectExecutionMode(model, sys);
              const tps = estimateTokensPerSec(paramsB, activeB);
              const quality = heuristicQuality(paramsB, activeB);
              const memPct = memoryUsagePct(model, sys);
              const useCase = classifyUseCase(model);
              const tierInfo = classifyModelTier(model);
              const ctxK =
                typeof model.max_context === "number" && model.max_context > 0
                  ? `${Math.round(model.max_context / 1024)}k`
                  : "—";
              // [END]
              return (
                <li
                  key={model.repo_id}
                  className="flex flex-col gap-0.5 px-4 py-2 text-xs hover:bg-ovo-bg/40 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`px-1.5 py-0.5 rounded-full border text-[10px] font-semibold shrink-0 ${TIER_STYLE[fit.tier].cls}`}
                    >
                      {t(`models.fit.tier.${fit.tier}`)}
                    </span>
                    {/* [START] Phase 5 — OVO support tier badge. */}
                    <span
                      className={`px-1.5 py-0.5 rounded-full border text-[10px] font-semibold shrink-0 ${TIER_BADGE_STYLE[tierInfo.tier]}`}
                      title={t(tierInfo.reasonKey)}
                    >
                      {t(tierInfo.labelKey)}
                    </span>
                    {/* [END] */}
                    <span className="text-ovo-text truncate flex-1">
                      {model.repo_id.split("/").pop() ?? model.repo_id}
                    </span>
                    <span
                      className="px-1.5 py-0.5 rounded bg-ovo-chip text-[10px] text-ovo-muted shrink-0"
                      title={t("models.fit.tooltip.params")}
                    >
                      {paramsB > 0
                        ? activeB
                          ? `${paramsB}B · ${activeB}B act`
                          : `${paramsB}B`
                        : "?B"}
                    </span>
                    <span className="text-ovo-muted text-[10px] shrink-0">
                      {est !== null ? `~${formatBytes(est)}` : t("models.fit.size_unknown")}
                    </span>
                  </div>
                  {/* [START] Phase 5 — llmfit-style meta row.
                      Compact single line with the axes power users want to
                      scan: Score · tok/s · Quant · Mode · Mem% · Ctx · Use Case.
                      Falls back to dashes when we can't infer a value so the
                      columns stay aligned visually across rows. */}
                  <div className="pl-[68px] text-[10px] text-ovo-muted/80 flex items-center gap-2 flex-wrap">
                    <MetaChip label={t("models.fit.col.score")} value={quality.toString()} emphasis={scoreEmphasis(quality)} />
                    <MetaChip label={t("models.fit.col.tps")} value={tps > 0 ? `${tps}` : "—"} />
                    <MetaChip label={t("models.fit.col.quant")} value={quant} />
                    <MetaChip label={t("models.fit.col.mode")} value={mode} />
                    <MetaChip
                      label={t("models.fit.col.mem")}
                      value={memPct !== null ? `${memPct}%` : "—"}
                      emphasis={memEmphasis(memPct)}
                    />
                    <MetaChip label={t("models.fit.col.ctx")} value={ctxK} />
                    <MetaChip label={t("models.fit.col.use_case")} value={t(`models.fit.use_case.${useCase.toLowerCase()}`)} />
                  </div>
                  {/* [END] */}
                  <div className="pl-[68px] text-[10px] text-ovo-muted/70 truncate">
                    {t(fit.reasonKey, fit.reasonParams)}
                    <span className="opacity-60"> · {model.repo_id}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      {/* [END] */}

      {/* [START] Recommendations — full width, no card wrapper */}
      {sys && !hideRecommendations && (
        <RecommendedModels sys={sys} installed={models} />
      )}
      {/* [END] */}
    </div>
  );
}

// [START] RecommendedModels — catalog → ranked list of install suggestions.
// Catalog is loaded dynamically (remote → bundled fallback) so the app
// doesn't need a new release each time the maintainer curates a new model.
export function RecommendedModels({ sys, installed }: { sys: SystemInfo; installed: OvoModel[] }) {
  const { t } = useTranslation();
  const ports = useSidecarStore((s) => s.status.ports);
  const pushToast = useToastsStore((s) => s.push);
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  // [START] Download progress tracking
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  // [END]
  const [catalog, setCatalog] = useState<CuratedModel[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((models) => {
        if (cancelled) return;
        setCatalog(models);
      })
      .finally(() => {
        if (!cancelled) setCatalogLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const scored = useMemo(() => {
    return catalog
      .map((c) => ({
        catalog: c,
        installed: isCatalogInstalled(c, installed),
        score: scoreCatalogFit(c, sys),
      }))
      .sort((a, b) => b.score.overall - a.score.overall);
  }, [catalog, sys, installed]);

  // Hide completely unfittable picks unless nothing else would show.
  const visible = useMemo(() => {
    const fitted = scored.filter((s) => s.score.tier !== "unfit");
    return fitted.length >= 4 ? fitted : scored;
  }, [scored]);

  async function handleInstall(repo_id: string) {
    setInstalling((s) => new Set(s).add(repo_id));
    try {
      const task = await startDownload(repo_id, ports);
      pushToast({ kind: "success", message: t("models.fit.installing") + " " + repo_id });

      // [START] Poll download progress
      const pollId = setInterval(async () => {
        try {
          const status = await getDownload(task.task_id, ports);
          const total = status.total_bytes || 1;
          const downloaded = status.downloaded_bytes || 0;
          const pct = Math.round((downloaded / total) * 100);
          setDownloadProgress((prev) => ({ ...prev, [repo_id]: pct }));

          if (status.status === "done") {
            clearInterval(pollId);
            setInstalling((s) => { const n = new Set(s); n.delete(repo_id); return n; });
            setDownloadProgress((prev) => { const n = { ...prev }; delete n[repo_id]; return n; });
            pushToast({ kind: "success", message: repo_id + " ✅" });
          } else if (status.status === "error") {
            clearInterval(pollId);
            setInstalling((s) => { const n = new Set(s); n.delete(repo_id); return n; });
            setDownloadProgress((prev) => { const n = { ...prev }; delete n[repo_id]; return n; });
            pushToast({ kind: "error", message: status.error || "Download failed" });
          }
        } catch { /* poll failure — retry next tick */ }
      }, 2000);
      // [END]
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      setInstalling((s) => {
        const next = new Set(s);
        next.delete(repo_id);
        return next;
      });
    }
  }

  // [START] Phase 8 — Curated / Explore tabs.
  // Curated = the hand-picked catalog above. Explore = live HF search against
  // mlx-community (fetched lazily the first time the tab opens so we don't
  // hit HF on every ModelsPane mount).
  const [tab, setTab] = useState<"curated" | "explore">("curated");
  const [exploreResults, setExploreResults] = useState<HfSearchResult[] | null>(null);
  const [exploreLoading, setExploreLoading] = useState(false);
  const [exploreError, setExploreError] = useState<string | null>(null);

  // [START] Phase 8 Step 3d — filters.
  // `kindFilter` narrows to a single model kind (chat / code / reasoning /
  // vlm); null means all. `fitsOnly` hides entries that won't load on the
  // host. `hideInstalled` is handy once the user has a big library and
  // only wants to discover what they don't already own. All three filters
  // apply to both Curated and Explore tabs so the UX stays consistent.
  const [kindFilter, setKindFilter] = useState<ModelKind | null>(null);
  const [fitsOnly, setFitsOnly] = useState(false);
  const [hideInstalled, setHideInstalled] = useState(false);
  // [END]

  useEffect(() => {
    if (tab !== "explore" || exploreResults !== null) return;
    let cancelled = false;
    setExploreLoading(true);
    setExploreError(null);
    searchModels("mlx-community", 50, ports)
      .then((r) => {
        if (!cancelled) setExploreResults(r);
      })
      .catch((e) => {
        if (!cancelled) setExploreError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setExploreLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, exploreResults, ports]);
  // [END]

  // [START] Phase 8 Step 3d — apply filters to curated view.
  // `visible` above already drops unfit picks when there's a fuller list —
  // we still respect that, then layer user-driven filters on top. Explore
  // gets the same filter pipeline inside `ExploreList` (keyed by repo_id
  // heuristic for kind) so the bar affects both tabs identically.
  const filteredCurated = useMemo(() => {
    return visible.filter(({ catalog, installed, score }) => {
      if (kindFilter && catalog.kind !== kindFilter) return false;
      if (fitsOnly && score.tier === "unfit") return false;
      if (hideInstalled && installed) return false;
      return true;
    });
  }, [visible, kindFilter, fitsOnly, hideInstalled]);
  // [END]

  return (
    <div className="flex flex-col">
      {/* Tab bar */}
      <div className="flex border-b border-ovo-border px-2">
        <TabBtn active={tab === "curated"} onClick={() => setTab("curated")}>
          {t("models.fit.tab.curated")}
        </TabBtn>
        <TabBtn active={tab === "explore"} onClick={() => setTab("explore")}>
          {t("models.fit.tab.explore")}
        </TabBtn>
        <div className="flex-1" />
        <span className="self-end pb-1 text-[10px] text-ovo-muted">
          {tab === "curated"
            ? t("models.fit.recommended_hint")
            : t("models.fit.explore_hint")}
        </span>
      </div>

      {/* [START] Step 3d — filter chip row. */}
      <FilterBar
        kindFilter={kindFilter}
        fitsOnly={fitsOnly}
        hideInstalled={hideInstalled}
        onKind={setKindFilter}
        onFitsOnly={setFitsOnly}
        onHideInstalled={setHideInstalled}
      />
      {/* [END] */}

      {tab === "curated" ? (
        <CuratedList
          loading={catalogLoading}
          visible={filteredCurated}
          installing={installing}
          downloadProgress={downloadProgress}
          onInstall={handleInstall}
        />
      ) : (
        <ExploreList
          results={exploreResults}
          loading={exploreLoading}
          error={exploreError}
          sys={sys}
          installed={installed}
          installing={installing}
          kindFilter={kindFilter}
          fitsOnly={fitsOnly}
          hideInstalled={hideInstalled}
          onInstall={handleInstall}
        />
      )}
    </div>
  );
}

// [START] FilterBar — chip row of kind + toggle filters. Chips are sticky
// rather than dropdowns so the active filter is always visible at a
// glance (no "why is only half the list showing" moments).
const KIND_OPTIONS: ModelKind[] = ["chat", "code", "reasoning", "vlm"];

function FilterBar({
  kindFilter,
  fitsOnly,
  hideInstalled,
  onKind,
  onFitsOnly,
  onHideInstalled,
}: {
  kindFilter: ModelKind | null;
  fitsOnly: boolean;
  hideInstalled: boolean;
  onKind: (k: ModelKind | null) => void;
  onFitsOnly: (v: boolean) => void;
  onHideInstalled: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1.5 flex-wrap px-3 py-2 border-b border-ovo-border/40 text-[11px]">
      <Chip active={kindFilter === null} onClick={() => onKind(null)}>
        {t("models.fit.filter.all_kinds")}
      </Chip>
      {KIND_OPTIONS.map((k) => (
        <Chip key={k} active={kindFilter === k} onClick={() => onKind(k)}>
          {t(`models.fit.kind.${k}`)}
        </Chip>
      ))}
      <span className="w-px h-4 bg-ovo-border mx-1" />
      <Chip active={fitsOnly} onClick={() => onFitsOnly(!fitsOnly)}>
        {t("models.fit.filter.fits_only")}
      </Chip>
      <Chip active={hideInstalled} onClick={() => onHideInstalled(!hideInstalled)}>
        {t("models.fit.filter.hide_installed")}
      </Chip>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2 py-0.5 rounded-full border transition ${
        active
          ? "bg-ovo-accent/15 border-ovo-accent text-ovo-accent font-semibold"
          : "bg-ovo-surface border-ovo-border text-ovo-muted hover:text-ovo-text"
      }`}
    >
      {children}
    </button>
  );
}
// [END]

// [START] TabBtn — small pill tab used inside the recommendations header.
function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs border-b-2 -mb-px transition ${
        active
          ? "border-ovo-accent text-ovo-text font-semibold"
          : "border-transparent text-ovo-muted hover:text-ovo-text"
      }`}
    >
      {children}
    </button>
  );
}
// [END]

// [START] CuratedList — existing curated row renderer, factored out.
function CuratedList({
  loading,
  visible,
  installing,
  downloadProgress,
  onInstall,
}: {
  loading: boolean;
  visible: Array<{ catalog: CuratedModel; installed: boolean; score: ScoreBreakdown }>;
  installing: Set<string>;
  downloadProgress: Record<string, number>;
  onInstall: (repo_id: string) => void;
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="px-4 py-6 flex items-center justify-center gap-2 text-xs text-ovo-muted">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {t("models.fit.scanning")}
      </div>
    );
  }
  if (visible.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-ovo-muted">
        {t("models.fit.empty")}
      </div>
    );
  }
  return (
    <ul className="max-h-[360px] overflow-y-auto divide-y divide-ovo-border/40">
      {visible.map(({ catalog, installed, score }) => (
        <RecommendedRow
          key={catalog.repo_id}
          catalog={catalog}
          installed={installed}
          score={score}
          busy={installing.has(catalog.repo_id)}
          progress={downloadProgress[catalog.repo_id]}
          onInstall={() => onInstall(catalog.repo_id)}
        />
      ))}
    </ul>
  );
}
// [END]

// [START] ExploreList — live HF mlx-community results.
// Each hit carries a download count + tags but not a pre-curated quality
// score, so the row shows only the two dimensions we *do* know: estimated
// size + fit tier against this host. That keeps "Explore" honest: it's a
// discovery surface, not a benchmark leaderboard.
// [START] guessKind — best-effort classification for explore rows.
// Explore returns raw HF hits, not curated metadata, so we infer the kind
// from repo id tokens. Narrowest matches win.
function guessKind(repo_id: string): ModelKind {
  const id = repo_id.toLowerCase();
  if (/-vl|vision|-vl-|-vision-/.test(id)) return "vlm";
  if (/coder|code-|-code|codegen/.test(id)) return "code";
  if (/r1[-_]|reason|thinker|thinking|distill/.test(id)) return "reasoning";
  return "chat";
}
// [END]

function ExploreList({
  results,
  loading,
  error,
  sys,
  installed,
  installing,
  kindFilter,
  fitsOnly,
  hideInstalled,
  onInstall,
}: {
  results: HfSearchResult[] | null;
  loading: boolean;
  error: string | null;
  sys: SystemInfo;
  installed: OvoModel[];
  installing: Set<string>;
  kindFilter: ModelKind | null;
  fitsOnly: boolean;
  hideInstalled: boolean;
  onInstall: (repo_id: string) => void;
}) {
  const { t } = useTranslation();

  if (loading) {
    return (
      <div className="px-4 py-6 flex items-center justify-center gap-2 text-xs text-ovo-muted">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        {t("models.fit.explore_loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-4 py-3 text-xs text-rose-400 bg-rose-500/5">
        {error}
      </div>
    );
  }
  if (!results || results.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-ovo-muted">
        {t("models.fit.explore_empty")}
      </div>
    );
  }

  const installedIds = new Set(installed.map((m) => m.repo_id));

  // Apply filters *before* rendering so pagination / overflow behaves.
  const filtered = results.filter((r) => {
    if (kindFilter && guessKind(r.repo_id) !== kindFilter) return false;
    if (hideInstalled && installedIds.has(r.repo_id)) return false;
    if (fitsOnly) {
      const fakeModel = { repo_id: r.repo_id, size_bytes: 0 } as unknown as OvoModel;
      if (assessFit(fakeModel, sys).tier === "unfit") return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-ovo-muted">
        {t("models.fit.explore_empty")}
      </div>
    );
  }

  return (
    <ul className="max-h-[360px] overflow-y-auto divide-y divide-ovo-border/40">
      {filtered.map((r) => {
        const fakeModel = {
          repo_id: r.repo_id,
          size_bytes: 0,
        } as unknown as OvoModel;
        const est = (() => {
          const bytes = (fakeModel as unknown as { size_bytes: number }).size_bytes;
          if (bytes > 0) return bytes;
          // reuse modelFit.estimateModelBytes via a synthesized OvoModel
          // — it parses the repo id for params/quant.
          return null;
        })();
        const fit = assessFit(fakeModel, sys);
        return (
          <ExploreRow
            key={r.repo_id}
            hit={r}
            fit={fit}
            est={est}
            installed={installedIds.has(r.repo_id)}
            busy={installing.has(r.repo_id)}
            onInstall={() => onInstall(r.repo_id)}
          />
        );
      })}
    </ul>
  );
}

function ExploreRow({
  hit,
  fit,
  est,
  installed,
  busy,
  onInstall,
}: {
  hit: HfSearchResult;
  fit: import("../lib/modelFit").FitAssessment;
  est: number | null;
  installed: boolean;
  busy: boolean;
  onInstall: () => void;
}) {
  const { t } = useTranslation();
  const displayName = hit.repo_id.split("/").pop() ?? hit.repo_id;
  const bytes = fit.estimatedBytes ?? est;

  return (
    <li className="flex items-center gap-2 px-4 py-2 text-xs hover:bg-ovo-bg/40 transition-colors">
      <span
        className={`px-1.5 py-0.5 rounded-full border text-[10px] font-semibold shrink-0 ${TIER_STYLE[fit.tier].cls}`}
      >
        {t(`models.fit.tier.${fit.tier}`)}
      </span>
      <span className="text-ovo-text truncate flex-1" title={hit.repo_id}>
        {displayName}
      </span>
      {typeof hit.downloads === "number" && (
        <span className="text-ovo-muted text-[10px] shrink-0">
          ↓ {hit.downloads.toLocaleString()}
        </span>
      )}
      <span className="text-ovo-muted text-[10px] shrink-0">
        {bytes !== null ? `~${formatBytes(bytes)}` : t("models.fit.size_unknown")}
      </span>
      {installed ? (
        <span className="flex items-center gap-1 text-emerald-500 text-[10px] shrink-0">
          <Check className="w-3 h-3" />
          {t("models.fit.installed")}
        </span>
      ) : (
        <button
          type="button"
          onClick={onInstall}
          disabled={busy || fit.tier === "unfit"}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-ovo-accent/10 text-ovo-accent hover:bg-ovo-accent/20 disabled:opacity-40 disabled:cursor-not-allowed text-[10px] font-semibold shrink-0 transition"
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
          {busy ? t("models.fit.installing") : t("models.fit.install")}
        </button>
      )}
    </li>
  );
}
// [END]
// [END]

// [START] RecommendedRow — card-like row with 4-axis mini bar.
function RecommendedRow({
  catalog,
  installed,
  score,
  busy,
  progress,
  onInstall,
}: {
  catalog: CuratedModel;
  installed: boolean;
  score: ScoreBreakdown;
  busy: boolean;
  progress?: number;
  onInstall: () => void;
}) {
  const { t } = useTranslation();

  return (
    <li className="flex flex-col gap-1 px-4 py-2.5 text-xs hover:bg-ovo-bg/40 transition-colors">
      <div className="flex items-center gap-2">
        <span
          className={`px-1.5 py-0.5 rounded-full border text-[10px] font-semibold shrink-0 ${TIER_STYLE[score.tier].cls}`}
        >
          {t(`models.fit.tier.${score.tier}`)}
        </span>
        <span
          className="px-1.5 py-0.5 rounded bg-ovo-chip text-[10px] text-ovo-muted shrink-0"
        >
          {t(`models.fit.kind.${catalog.kind}`)}
        </span>
        <span className="text-ovo-text font-medium truncate flex-1">
          {catalog.name}
        </span>
        <span className="text-ovo-muted text-[10px] shrink-0">
          {catalog.paramsB}B
          {catalog.activeParamsB && ` · ${catalog.activeParamsB}B active`}
          {" · "}~{formatBytes(score.estimatedBytes)}
        </span>
        {installed ? (
          <span className="flex items-center gap-1 text-emerald-500 text-[10px] shrink-0">
            <Check className="w-3 h-3" />
            {t("models.fit.installed")}
          </span>
        ) : (
          <button
            type="button"
            onClick={onInstall}
            disabled={busy || score.tier === "unfit"}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-ovo-accent/10 text-ovo-accent hover:bg-ovo-accent/20 disabled:opacity-40 disabled:cursor-not-allowed text-[10px] font-semibold shrink-0 transition"
          >
            {busy ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Download className="w-3 h-3" />
            )}
            {busy
              ? progress !== undefined ? `${progress}%` : t("models.fit.installing")
              : t("models.fit.install")}
          </button>
        )}
      </div>
      <div className="text-[10px] text-ovo-muted/90">{catalog.description}</div>
      <div className="grid grid-cols-4 gap-2 mt-0.5">
        <ScoreBar label={t("models.fit.axis.quality")} value={score.quality} />
        <ScoreBar label={t("models.fit.axis.speed")} value={score.speed} />
        <ScoreBar label={t("models.fit.axis.context")} value={score.context} />
        <ScoreBar label={t("models.fit.axis.fit")} value={score.fit} />
      </div>
    </li>
  );
}

// [START] Phase 5 — MetaChip + emphasis helpers for the installed-model row.
// Colour-codes high/low values so the user doesn't have to read numbers to
// spot the outlier — red for "uh oh", green for "nice".
function MetaChip({
  label,
  value,
  emphasis = "neutral",
}: {
  label: string;
  value: string;
  emphasis?: "neutral" | "good" | "warn" | "bad";
}) {
  const valueClass =
    emphasis === "good"
      ? "text-emerald-400"
      : emphasis === "warn"
        ? "text-amber-400"
        : emphasis === "bad"
          ? "text-rose-400"
          : "text-ovo-text";
  return (
    <span className="inline-flex items-baseline gap-0.5 whitespace-nowrap">
      <span className="opacity-70">{label}</span>
      <span className={`font-mono ${valueClass}`}>{value}</span>
    </span>
  );
}

function scoreEmphasis(q: number): "neutral" | "good" | "warn" | "bad" {
  if (q >= 80) return "good";
  if (q >= 60) return "neutral";
  if (q >= 40) return "warn";
  return "bad";
}

function memEmphasis(pct: number | null): "neutral" | "good" | "warn" | "bad" {
  if (pct === null) return "neutral";
  if (pct <= 35) return "good";
  if (pct <= 70) return "neutral";
  if (pct <= 100) return "warn";
  return "bad";
}
// [END]

function ScoreBar({ label, value }: { label: string; value: number }) {
  // Bar colour shifts with the value so scores at a glance communicate "good"
  // without requiring the user to read the number.
  const colour =
    value >= 75 ? "bg-emerald-500" :
      value >= 55 ? "bg-sky-500" :
        value >= 35 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-baseline justify-between text-[9px] text-ovo-muted">
        <span className="truncate">{label}</span>
        <span className="text-ovo-text font-semibold">{value}</span>
      </div>
      <div className="h-1 rounded-full bg-ovo-chip overflow-hidden">
        <div
          className={`h-full ${colour} rounded-full transition-all`}
          style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
        />
      </div>
    </div>
  );
}
// [END]
// [END] Phase 8
