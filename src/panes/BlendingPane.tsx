// [START] BlendingPane — model blending GUI with method selection + progress.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Blend, Play, Square, Trash2, Loader2 } from "lucide-react";
import { useSidecarStore } from "../store/sidecar";
import { useToastsStore } from "../store/toasts";
import { listModels } from "../lib/api";
import { isChatCapableModel } from "../lib/models";
import {
  startBlend, getBlendProgress, listBlendedModels, deleteBlendedModel,
  type BlendRun, type BlendedModel,
} from "../lib/blending";
import type { OvoModel } from "../types/ovo";

const METHODS = ["slerp", "linear", "ties", "dare"] as const;

export function BlendingPane() {
  const { t } = useTranslation();
  const ports = useSidecarStore((s) => s.status.ports);
  const health = useSidecarStore((s) => s.status.health);

  const [models, setModels] = useState<OvoModel[]>([]);
  const [blended, setBlended] = useState<BlendedModel[]>([]);
  const [modelA, setModelA] = useState("");
  const [modelB, setModelB] = useState("");
  const [method, setMethod] = useState<string>("slerp");
  const [weightB, setWeightB] = useState(0.5);
  const [name, setName] = useState("");
  const [starting, setStarting] = useState(false);

  const [activeRun, setActiveRun] = useState<BlendRun | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = async () => {
    try {
      const bm = await listBlendedModels(ports);
      setBlended(bm);
    } catch { /* sidecar may be down */ }
  };

  useEffect(() => {
    if (health !== "healthy") return;
    void listModels(ports).then((r) => setModels(r.models.filter(isChatCapableModel))).catch(() => {});
    void refresh();
  }, [health, ports]);

  useEffect(() => {
    if (!activeRun || (activeRun.status !== "running" && activeRun.status !== "pending")) return;
    pollRef.current = setInterval(async () => {
      try {
        const updated = await getBlendProgress(activeRun.run_id, ports);
        setActiveRun(updated);
        if (updated.status === "done" || updated.status === "error" || updated.status === "cancelled") {
          if (pollRef.current) clearInterval(pollRef.current);
          await refresh();
          useToastsStore.getState().push({
            kind: updated.status === "done" ? "success" : "error",
            message: updated.status === "done"
              ? t("blending.blend_done", { name: updated.name })
              : updated.error ?? "Blend failed",
          });
        }
      } catch { /* swallow */ }
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeRun?.run_id, activeRun?.status, ports, t]);

  const handleStart = async () => {
    if (!name.trim() || !modelA || !modelB) return;
    setStarting(true);
    try {
      const result = await startBlend(name.trim(), method, [
        { repo_id: modelA, weight: 1 - weightB },
        { repo_id: modelB, weight: weightB },
      ], ports);
      const run = await getBlendProgress(result.run_id, ports);
      setActiveRun(run);
      useToastsStore.getState().push({ kind: "info", message: t("blending.blend_started", { name: name.trim() }) });
    } catch (e) {
      useToastsStore.getState().push({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setStarting(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  };

  if (health !== "healthy") {
    return (
      <div className="h-full flex items-center justify-center text-sm text-ovo-muted">
        {t(`sidecar.status.${health}`)}…
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <header className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-ovo-text flex items-center gap-2">
          <Blend className="w-5 h-5 text-ovo-accent" />
          {t("blending.title")}
        </h2>
        <span className="text-xs text-ovo-muted">{t("blending.subtitle")}</span>
      </header>

      {/* Active run progress */}
      {activeRun && (activeRun.status === "running" || activeRun.status === "pending") && (
        <div className="p-4 rounded-xl bg-ovo-accent/10 border border-ovo-accent/30 mb-5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-ovo-text flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin text-ovo-accent" />
              {activeRun.name} ({activeRun.method})
            </div>
            <button
              type="button"
              onClick={async () => {
                const { cancelBlend } = await import("../lib/blending");
                await cancelBlend(activeRun.run_id, ports);
                setActiveRun(null);
              }}
              className="text-xs text-rose-500"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="w-full h-2 rounded-full bg-ovo-border overflow-hidden mb-1">
            <div
              className="h-full bg-ovo-accent rounded-full transition-all"
              style={{ width: `${Math.round(activeRun.progress * 100)}%` }}
            />
          </div>
          <div className="text-[11px] text-ovo-muted text-right">
            {Math.round(activeRun.progress * 100)}% · {Math.round(activeRun.elapsed_seconds)}s
          </div>
        </div>
      )}

      {/* Blend form */}
      <div className="space-y-3 mb-6">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("blending.name_placeholder")}
          className="w-full px-3 py-2 rounded-lg bg-ovo-surface border border-ovo-border text-sm text-ovo-text placeholder:text-ovo-muted focus:outline-none focus:ring-1 focus:ring-ovo-accent"
        />

        <div className="grid grid-cols-2 gap-3">
          <select
            value={modelA}
            onChange={(e) => setModelA(e.target.value)}
            className="px-3 py-2 rounded-lg bg-ovo-surface border border-ovo-border text-sm text-ovo-text focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          >
            <option value="">{t("blending.select_model_a")}</option>
            {models.map((m) => (
              <option key={m.repo_id} value={m.repo_id}>{m.repo_id.split("/").pop()}</option>
            ))}
          </select>
          <select
            value={modelB}
            onChange={(e) => setModelB(e.target.value)}
            className="px-3 py-2 rounded-lg bg-ovo-surface border border-ovo-border text-sm text-ovo-text focus:outline-none focus:ring-1 focus:ring-ovo-accent"
          >
            <option value="">{t("blending.select_model_b")}</option>
            {models.map((m) => (
              <option key={m.repo_id} value={m.repo_id}>{m.repo_id.split("/").pop()}</option>
            ))}
          </select>
        </div>

        {/* Method selector */}
        <div className="inline-flex rounded-md border border-ovo-border bg-ovo-surface p-0.5">
          {METHODS.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMethod(m)}
              className={`px-3 py-1 text-xs rounded uppercase transition ${
                method === m ? "bg-ovo-accent text-ovo-accent-ink" : "text-ovo-muted hover:text-ovo-text"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Weight slider */}
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-ovo-muted w-8 text-right">{Math.round((1 - weightB) * 100)}%</span>
          <input
            type="range"
            min={0} max={100} value={Math.round(weightB * 100)}
            onChange={(e) => setWeightB(Number(e.target.value) / 100)}
            className="flex-1 accent-ovo-accent"
          />
          <span className="text-[11px] text-ovo-muted w-8">{Math.round(weightB * 100)}%</span>
        </div>
        <div className="flex justify-between text-[10px] text-ovo-muted px-10">
          <span>{modelA ? modelA.split("/").pop() : "Model A"}</span>
          <span>{modelB ? modelB.split("/").pop() : "Model B"}</span>
        </div>

        <button
          disabled={!name.trim() || !modelA || !modelB || modelA === modelB || starting}
          onClick={() => void handleStart()}
          className="w-full px-4 py-2.5 rounded-lg bg-ovo-accent text-white text-sm font-medium disabled:opacity-40 hover:brightness-110 transition flex items-center justify-center gap-2"
        >
          {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {t("blending.start_blend")}
        </button>
      </div>

      {/* Method descriptions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-6">
        {METHODS.map((m) => (
          <div key={m} className={`p-3 rounded-lg border text-left transition ${
            method === m ? "bg-ovo-accent/10 border-ovo-accent/30" : "bg-ovo-surface border-ovo-border"
          }`}>
            <div className="text-[10px] uppercase tracking-wide text-ovo-accent mb-1">{m}</div>
            <div className="text-xs text-ovo-muted">{t(`blending.method_${m}_desc`)}</div>
          </div>
        ))}
      </div>

      {/* Blended models list */}
      {blended.length > 0 && (
        <>
          <h3 className="text-sm font-semibold text-ovo-text mb-3">{t("blending.my_models")}</h3>
          <ul className="space-y-2">
            {blended.map((bm) => (
              <li key={bm.name} className="p-3 rounded-lg bg-ovo-surface border border-ovo-border flex items-center gap-3">
                <Blend className="w-4 h-4 text-ovo-accent shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-ovo-text">{bm.name}</div>
                  <div className="text-[11px] text-ovo-muted">
                    {bm.method.toUpperCase()} · {bm.sources.map((s) => s.repo_id.split("/").pop()).join(" + ")} · {formatSize(bm.size_bytes)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(t("blending.confirm_delete", { name: bm.name }))) return;
                    await deleteBlendedModel(bm.name, ports);
                    await refresh();
                  }}
                  className="p-1.5 rounded text-ovo-muted hover:text-rose-500 transition"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
// [END]
