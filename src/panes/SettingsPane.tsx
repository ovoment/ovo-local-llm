import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageToggle } from "../components/LanguageToggle";
import { useSidecarStore } from "../store/sidecar";
import { useChatSettingsStore } from "../store/chat_settings";
import { useModelOverridesStore } from "../store/model_overrides";
import { listModels } from "../lib/api";
import type { CompactStrategy, ModelContextOverride, OvoModel } from "../types/ovo";
import type { StreamingSendMode } from "../store/chat_settings";

// [START] SettingsPane — language/ports + context management (R.6)

// ── Streaming send mode radio ─────────────────────────────────────────────────
const STREAMING_SEND_MODES: StreamingSendMode[] = ["queue", "interrupt", "block"];

function streamingModeLabel(m: StreamingSendMode): string {
  if (m === "queue") return "settings.chat_input.mode_queue_label";
  if (m === "interrupt") return "settings.chat_input.mode_interrupt_label";
  return "settings.chat_input.mode_block_label";
}

function streamingModeHelp(m: StreamingSendMode): string {
  if (m === "queue") return "settings.chat_input.mode_queue_help";
  if (m === "interrupt") return "settings.chat_input.mode_interrupt_help";
  return "settings.chat_input.mode_block_help";
}

// ── Compact strategy radio ────────────────────────────────────────────────────
const STRATEGIES: CompactStrategy[] = ["auto", "manual", "warn_only"];

function strategyKey(s: CompactStrategy): string {
  if (s === "auto") return "settings.context.strategy_auto";
  if (s === "manual") return "settings.context.strategy_manual";
  return "settings.context.strategy_warn_only";
}

// ── New-override inline form ──────────────────────────────────────────────────
interface AddRowProps {
  models: OvoModel[];
  overrides: Record<string, ModelContextOverride>;
  globalThreshold: number;
  onAdd: (input: Omit<ModelContextOverride, "updated_at">) => Promise<void>;
  onCancel: () => void;
}

function AddOverrideRow({ models, overrides, globalThreshold, onAdd, onCancel }: AddRowProps) {
  const { t } = useTranslation();
  const available = models.filter((m) => !overrides[m.repo_id]);

  const [repoId, setRepoId] = useState<string>(available[0]?.repo_id ?? "");
  const [maxContext, setMaxContext] = useState<number>(
    available[0]?.max_context ?? 8192,
  );
  const [threshold, setThreshold] = useState<number>(globalThreshold);

  // Update maxContext default when repoId changes
  function handleRepoChange(id: string) {
    setRepoId(id);
    const m = models.find((x) => x.repo_id === id);
    setMaxContext(m?.max_context ?? 8192);
  }

  async function handleSave() {
    if (!repoId) return;
    await onAdd({ repo_id: repoId, max_context: maxContext, warn_threshold: threshold });
  }

  if (available.length === 0) return null;

  return (
    <tr className="bg-[#FAF3E7]">
      <td className="px-3 py-2">
        <select
          value={repoId}
          onChange={(e) => handleRepoChange(e.target.value)}
          className="text-xs border border-[#E8CFBB] rounded px-2 py-1 bg-white text-[#2C1810] w-full"
        >
          {available.map((m) => (
            <option key={m.repo_id} value={m.repo_id}>
              {m.repo_id}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <input
          type="number"
          min={512}
          max={200000}
          step={512}
          value={maxContext}
          onChange={(e) => setMaxContext(Number(e.target.value))}
          className="text-xs border border-[#E8CFBB] rounded px-2 py-1 bg-white text-[#2C1810] w-24 font-mono"
        />
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-20 accent-[#D97757]"
          />
          <span className="text-xs text-[#8B4432] w-8">{Math.round(threshold * 100)}%</span>
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleSave()}
            className="text-xs px-2 py-1 rounded bg-[#D97757] text-white hover:bg-[#8B4432] transition"
          >
            {t("common.save")}
          </button>
          <button
            onClick={onCancel}
            className="text-xs px-2 py-1 rounded bg-[#E8CFBB] text-[#2C1810] hover:bg-[#D97757] hover:text-white transition"
          >
            {t("common.cancel")}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Main pane ─────────────────────────────────────────────────────────────────
export function SettingsPane() {
  const { t } = useTranslation();
  const ports = useSidecarStore((s) => s.status.ports);

  // Chat settings store
  const defaultStrategy = useChatSettingsStore((s) => s.default_strategy);
  const globalWarnThreshold = useChatSettingsStore((s) => s.global_warn_threshold);
  const streamingSendMode = useChatSettingsStore((s) => s.streaming_send_mode);
  const setDefaultStrategy = useChatSettingsStore((s) => s.setDefaultStrategy);
  const setGlobalWarnThreshold = useChatSettingsStore((s) => s.setGlobalWarnThreshold);
  const setStreamingSendMode = useChatSettingsStore((s) => s.setStreamingSendMode);

  // Model overrides store
  const overrides = useModelOverridesStore((s) => s.overrides);
  const upsertOverride = useModelOverridesStore((s) => s.upsert);
  const removeOverride = useModelOverridesStore((s) => s.remove);

  // [START] model list cache for override table
  const [models, setModels] = useState<OvoModel[]>([]);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    listModels(ports)
      .then((res) => setModels(res.models))
      .catch((err) => console.warn("SettingsPane: failed to fetch models", err));
  }, [ports]);
  // [END]

  const [addingRow, setAddingRow] = useState(false);

  // [START] inline threshold editor state for existing overrides
  const [editingThreshold, setEditingThreshold] = useState<Record<string, number>>({});

  function getDisplayThreshold(repoId: string): number {
    return editingThreshold[repoId] ?? overrides[repoId]?.warn_threshold ?? globalWarnThreshold;
  }

  async function handleSaveOverrideThreshold(repoId: string) {
    const override = overrides[repoId];
    if (!override) return;
    const newThreshold = editingThreshold[repoId];
    if (newThreshold === undefined) return;
    await upsertOverride({ repo_id: repoId, max_context: override.max_context, warn_threshold: newThreshold });
    setEditingThreshold((prev) => { const n = { ...prev }; delete n[repoId]; return n; });
  }

  async function handleSaveOverrideMaxContext(repoId: string, maxContext: number) {
    const override = overrides[repoId];
    if (!override) return;
    await upsertOverride({ repo_id: repoId, max_context: maxContext, warn_threshold: override.warn_threshold });
  }
  // [END]

  const overrideList = Object.values(overrides);

  return (
    <div className="p-6 max-w-2xl">
      <h2 className="text-lg font-semibold text-[#2C1810] mb-6">{t("nav.settings")}</h2>

      <section className="flex items-center justify-between py-3 border-b border-[#E8CFBB]">
        <label className="text-sm text-[#2C1810]">{t("settings.language")}</label>
        <LanguageToggle />
      </section>

      <section className="py-3 border-b border-[#E8CFBB]">
        <div className="text-sm text-[#2C1810] mb-2">{t("settings.ports")}</div>
        <dl className="grid grid-cols-3 gap-2 text-xs">
          <div className="bg-white/60 rounded p-2 border border-[#E8CFBB]">
            <dt className="text-[#8B4432]">{t("sidecar.ports.ollama")}</dt>
            <dd className="font-mono text-[#2C1810]">{ports.ollama}</dd>
          </div>
          <div className="bg-white/60 rounded p-2 border border-[#E8CFBB]">
            <dt className="text-[#8B4432]">{t("sidecar.ports.openai")}</dt>
            <dd className="font-mono text-[#2C1810]">{ports.openai}</dd>
          </div>
          <div className="bg-white/60 rounded p-2 border border-[#E8CFBB]">
            <dt className="text-[#8B4432]">{t("sidecar.ports.native")}</dt>
            <dd className="font-mono text-[#2C1810]">{ports.native}</dd>
          </div>
        </dl>
      </section>

      {/* [START] Chat input section — streaming send mode */}
      <section className="py-4 border-b border-[#E8CFBB]">
        <h3 className="text-sm font-semibold text-[#2C1810] mb-4">
          {t("settings.chat_input.section_title")}
        </h3>
        <div className="flex flex-col gap-3">
          {STREAMING_SEND_MODES.map((m) => (
            <label key={m} className="flex flex-col gap-0.5 cursor-pointer">
              <div className="flex items-center gap-2">
                <input
                  type="radio"
                  name="streaming_send_mode"
                  value={m}
                  checked={streamingSendMode === m}
                  onChange={() => setStreamingSendMode(m)}
                  className="accent-[#D97757]"
                />
                <span className="text-sm text-[#2C1810]">{t(streamingModeLabel(m))}</span>
              </div>
              <p className="ml-5 text-xs text-[#8B4432]">{t(streamingModeHelp(m))}</p>
            </label>
          ))}
        </div>
      </section>
      {/* [END] */}

      {/* [START] Context management section (R.6) */}
      <section className="py-4 border-b border-[#E8CFBB]">
        <h3 className="text-sm font-semibold text-[#2C1810] mb-4">
          {t("settings.context.section_title")}
        </h3>

        {/* Compact strategy radio */}
        <div className="mb-5">
          <div className="text-xs font-medium text-[#8B4432] mb-2">
            {t("settings.context.strategy_label")}
          </div>
          <div className="flex flex-col gap-2">
            {STRATEGIES.map((s) => (
              <label key={s} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="compact_strategy"
                  value={s}
                  checked={defaultStrategy === s}
                  onChange={() => setDefaultStrategy(s)}
                  className="accent-[#D97757]"
                />
                <span className="text-sm text-[#2C1810]">{t(strategyKey(s))}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Global warn threshold slider */}
        <div className="mb-5">
          <div className="text-xs font-medium text-[#8B4432] mb-2">
            {t("settings.context.global_threshold_label")}
            <span className="ml-2 font-mono text-[#D97757]">
              {Math.round(globalWarnThreshold * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={globalWarnThreshold}
            onChange={(e) => setGlobalWarnThreshold(Number(e.target.value))}
            className="w-full max-w-xs accent-[#D97757]"
          />
          <div className="flex justify-between text-[10px] text-[#8B4432] max-w-xs mt-1">
            <span>50%</span>
            <span>95%</span>
          </div>
        </div>

        {/* Model override table */}
        <div>
          <div className="text-xs font-medium text-[#8B4432] mb-2">
            {t("settings.context.overrides_title")}
          </div>

          <div className="overflow-x-auto rounded border border-[#E8CFBB]">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-[#E8CFBB]/40 text-[#8B4432]">
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.context.overrides_column_repo")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.context.overrides_column_max_context")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.context.overrides_column_threshold")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.context.overrides_column_action")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E8CFBB]">
                {/* Auto-detected rows — models without overrides */}
                {models
                  .filter((m) => !overrides[m.repo_id])
                  .map((m) => (
                    <tr key={m.repo_id} className="bg-white/40">
                      <td className="px-3 py-2 font-mono text-[#8B4432] truncate max-w-[180px]">
                        {m.repo_id}
                      </td>
                      <td className="px-3 py-2 font-mono text-[#8B4432]">
                        {m.max_context ?? "—"}
                        <span className="ml-1 text-[10px] text-[#8B4432]/60">
                          ({t("settings.context.overrides_auto_detected")})
                        </span>
                      </td>
                      <td className="px-3 py-2 text-[#8B4432]/60">
                        {Math.round(globalWarnThreshold * 100)}%
                      </td>
                      <td className="px-3 py-2 text-[#8B4432]/40">—</td>
                    </tr>
                  ))}

                {/* Override rows — editable */}
                {overrideList.map((ov) => (
                  <tr key={ov.repo_id} className="bg-white">
                    <td className="px-3 py-2 font-mono text-[#2C1810] truncate max-w-[180px]">
                      {ov.repo_id}
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={512}
                        max={200000}
                        step={512}
                        defaultValue={ov.max_context}
                        onBlur={(e) =>
                          void handleSaveOverrideMaxContext(ov.repo_id, Number(e.target.value))
                        }
                        className="text-xs border border-[#E8CFBB] rounded px-2 py-1 bg-white text-[#2C1810] w-24 font-mono"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="range"
                          min={0.5}
                          max={0.95}
                          step={0.05}
                          value={getDisplayThreshold(ov.repo_id)}
                          onChange={(e) =>
                            setEditingThreshold((prev) => ({
                              ...prev,
                              [ov.repo_id]: Number(e.target.value),
                            }))
                          }
                          onMouseUp={() => void handleSaveOverrideThreshold(ov.repo_id)}
                          onTouchEnd={() => void handleSaveOverrideThreshold(ov.repo_id)}
                          className="w-20 accent-[#D97757]"
                        />
                        <span className="text-xs text-[#8B4432] w-8">
                          {Math.round(getDisplayThreshold(ov.repo_id) * 100)}%
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => {
                          if (window.confirm(t("settings.context.overrides_confirm_delete"))) {
                            void removeOverride(ov.repo_id);
                          }
                        }}
                        className="text-xs px-2 py-1 rounded bg-[#E8CFBB] text-[#2C1810] hover:bg-rose-100 hover:text-rose-700 transition"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}

                {/* Add row inline form */}
                {addingRow && (
                  <AddOverrideRow
                    models={models}
                    overrides={overrides}
                    globalThreshold={globalWarnThreshold}
                    onAdd={async (input) => {
                      await upsertOverride(input);
                      setAddingRow(false);
                    }}
                    onCancel={() => setAddingRow(false)}
                  />
                )}

                {/* Empty state */}
                {overrideList.length === 0 && models.length === 0 && !addingRow && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-3 py-4 text-center text-xs text-[#8B4432]/60"
                    >
                      {t("settings.context.overrides_empty")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {!addingRow && (
            <button
              onClick={() => setAddingRow(true)}
              className="mt-3 text-xs px-3 py-1.5 rounded bg-[#E8CFBB] text-[#2C1810] hover:bg-[#D97757] hover:text-white transition"
            >
              {t("settings.context.overrides_add")}
            </button>
          )}
        </div>
      </section>
      {/* [END] */}
    </div>
  );
}
