import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listModels } from "../lib/api";
import { useSidecarStore } from "../store/sidecar";
import type { OvoModel, QuantizationConfig } from "../types/ovo";

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

export function ModelsPane() {
  const { t } = useTranslation();
  const status = useSidecarStore((s) => s.status);
  const [models, setModels] = useState<OvoModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      <div className="h-full flex items-center justify-center text-sm text-[#8B4432]">
        {t(`sidecar.status.${status.health}`)}…
      </div>
    );
  }

  if (loading) {
    return <div className="p-6 text-sm text-[#8B4432]">{t("common.loading")}</div>;
  }

  if (error) {
    return (
      <div className="p-6 text-sm text-rose-600">
        {t("common.error")}: {error}
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-[#8B4432]">
        {t("models.empty")}
      </div>
    );
  }

  return (
    <div className="p-6 overflow-auto">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold text-[#2C1810]">{t("models.title")}</h2>
        <span className="text-xs text-[#8B4432]">{t("models.count", { count: models.length })}</span>
      </div>
      <ul className="grid gap-2">
        {models.map((m) => (
          <li
            key={`${m.source}:${m.repo_id}:${m.revision}`}
            className="p-3 rounded-lg bg-white/70 border border-[#E8CFBB] flex items-center gap-4"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-[#2C1810] truncate">{m.repo_id}</div>
              <div className="text-[11px] text-[#8B4432] mt-0.5 flex gap-3">
                <span>{t(`models.source.${m.source}`)}</span>
                {formatArchitecture(m.architecture) && (
                  <span>{formatArchitecture(m.architecture)}</span>
                )}
                {formatQuantization(m.quantization) && (
                  <span>{formatQuantization(m.quantization)}</span>
                )}
              </div>
            </div>
            <div className="text-xs text-[#8B4432] tabular-nums shrink-0">
              {formatSize(m.size_bytes)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
