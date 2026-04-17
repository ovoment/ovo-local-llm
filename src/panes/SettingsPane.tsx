import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Copy } from "lucide-react";
import { LanguageToggle } from "../components/LanguageToggle";
import { useThemeStore, type ThemeMode } from "../store/theme";
import { useSidecarStore } from "../store/sidecar";
import { useChatSettingsStore } from "../store/chat_settings";
import { useModelOverridesStore } from "../store/model_overrides";
import { usePetStore } from "../store/pet";
// [START] Phase 6.1 — Project Context section
import { ProjectContextSection } from "../components/ProjectContextSection";
// [END]
// [START] Phase 6.2b — MCP Servers section
import { McpServersSection } from "../components/McpServersSection";
// [END]
// [START] Phase 6.2c — tool-call approval mode store
import { useToolModeStore, type ToolMode } from "../store/tool_mode";
// [END]
import { useToastsStore } from "../store/toasts";
import { listModels } from "../lib/api";
import type { CompactStrategy, ModelContextOverride, OvoModel } from "../types/ovo";
import type { SidecarPorts } from "../types/sidecar";
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
    <tr className="bg-ovo-chip">
      <td className="px-3 py-2">
        <select
          value={repoId}
          onChange={(e) => handleRepoChange(e.target.value)}
          className="text-xs border border-ovo-border rounded px-2 py-1 bg-ovo-surface-solid text-ovo-text w-full"
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
          className="text-xs border border-ovo-border rounded px-2 py-1 bg-ovo-surface-solid text-ovo-text w-24 font-mono"
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
            className="w-20 accent-ovo-accent"
          />
          <span className="text-xs text-ovo-muted w-8">{Math.round(threshold * 100)}%</span>
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleSave()}
            className="text-xs px-2 py-1 rounded bg-ovo-accent text-white hover:bg-ovo-accent-hover transition"
          >
            {t("common.save")}
          </button>
          <button
            onClick={onCancel}
            className="text-xs px-2 py-1 rounded bg-ovo-border text-ovo-text hover:bg-ovo-accent hover:text-white transition"
          >
            {t("common.cancel")}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── Advanced / External Connections section ───────────────────────────────────

// [START] OvoServerSettings — shape of GET/PUT /ovo/settings relevant to default_model
interface OvoServerSettings {
  default_model?: string | null;
}
// [END]

// [START] CopyButton — copies text to clipboard and shows a toast
interface CopyButtonProps {
  text: string;
  label: string;
  copiedLabel: string;
  onCopied: () => void;
}

function CopyButton({ text, label, copiedLabel, onCopied }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      onCopied();
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => undefined);
  }

  return (
    <button
      onClick={handleCopy}
      title={copied ? copiedLabel : label}
      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-ovo-border text-ovo-text hover:bg-ovo-accent hover:text-white transition shrink-0"
    >
      <Copy size={10} />
      {copied ? copiedLabel : label}
    </button>
  );
}
// [END]

// [START] EndpointCard — one card per API flavor (Ollama / OpenAI / Native)
interface EndpointCardProps {
  name: string;
  baseUrl: string;
  snippets: Array<{ label: string; code: string }>;
  copyLabel: string;
  copiedLabel: string;
  onCopied: (text: string) => void;
}

function EndpointCard({ name, baseUrl, snippets, copyLabel, copiedLabel, onCopied }: EndpointCardProps) {
  return (
    <div className="bg-ovo-chip rounded border border-ovo-border p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ovo-text">{name}</span>
        <CopyButton
          text={baseUrl}
          label={copyLabel}
          copiedLabel={copiedLabel}
          onCopied={() => onCopied(baseUrl)}
        />
      </div>
      <code className="text-[10px] font-mono text-ovo-muted break-all">{baseUrl}</code>
      {snippets.map((s) => (
        <div key={s.label} className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-1">
            <span className="text-[10px] text-ovo-muted/70">{s.label}</span>
            <CopyButton
              text={s.code}
              label={copyLabel}
              copiedLabel={copiedLabel}
              onCopied={() => onCopied(s.code)}
            />
          </div>
          <pre className="text-[10px] font-mono text-ovo-text bg-ovo-surface rounded p-2 overflow-x-auto border border-ovo-border whitespace-pre-wrap break-all leading-relaxed">{s.code}</pre>
        </div>
      ))}
    </div>
  );
}
// [END]

// [START] AdvancedSection — collapsible LLM router dashboard
const LS_KEY = "ovo:settings_advanced_open";

interface AdvancedSectionProps {
  ports: SidecarPorts;
  models: OvoModel[];
}

function AdvancedSection({ ports, models }: AdvancedSectionProps) {
  const { t } = useTranslation();
  const pushToast = useToastsStore((s) => s.push);

  // Collapse state — default closed, persisted to localStorage
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_KEY) === "true"; } catch { return false; }
  });

  function toggleOpen() {
    setOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }

  // [START] Default model state — fetched from /ovo/settings on mount
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [settingsSaved, setSettingsSaved] = useState(false);
  const settingsFetchedRef = useRef(false);

  useEffect(() => {
    if (settingsFetchedRef.current) return;
    settingsFetchedRef.current = true;
    fetch(`http://127.0.0.1:${ports.native}/ovo/settings`)
      .then((r) => r.json() as Promise<OvoServerSettings>)
      .then((data) => {
        setDefaultModel(data.default_model ?? "");
      })
      .catch((err) => console.warn("AdvancedSection: failed to fetch /ovo/settings", err));
  }, [ports.native]);

  async function handleDefaultModelChange(repoId: string) {
    setDefaultModel(repoId);
    try {
      await fetch(`http://127.0.0.1:${ports.native}/ovo/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ default_model: repoId === "" ? null : repoId }),
      });
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 1500);
    } catch (err) {
      console.warn("AdvancedSection: failed to save default_model", err);
    }
  }
  // [END]

  // [START] Build curl snippets using current default_model or placeholder
  const modelId = defaultModel || "<model-id>";
  const ollamaBase = `http://localhost:${ports.ollama}`;
  const openaiBase = `http://localhost:${ports.openai}/v1`;
  const nativeBase = `http://localhost:${ports.native}`;

  const ollamaSnippets = [
    { label: "List models", code: `curl ${ollamaBase}/api/tags` },
    {
      label: "Generate (stream)",
      code: `curl -X POST ${ollamaBase}/api/generate \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"${modelId}","prompt":"Hello!","stream":true}'`,
    },
  ];

  const openaiSnippets = [
    { label: "List models", code: `curl ${openaiBase}/models` },
    {
      label: "Chat completions",
      code: `curl -X POST ${openaiBase}/chat/completions \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hello!"}]}'`,
    },
  ];

  const nativeSnippets = [
    { label: "List models", code: `curl ${nativeBase}/ovo/models` },
    {
      label: "Count tokens",
      code: `curl -X POST ${nativeBase}/ovo/count_tokens \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"${modelId}","messages":[{"role":"user","content":"Hello!"}]}'`,
    },
  ];
  // [END]

  function handleCopied(text: string) {
    void text;
    pushToast({ kind: "success", message: t("settings.advanced.endpoint_copied") });
  }

  const copyLabel = t("settings.advanced.endpoint_copy");
  const copiedLabel = t("settings.advanced.endpoint_copied");

  return (
    <section className="py-4 border-b border-ovo-border">
      {/* Header — always visible, clickable to collapse */}
      <button
        onClick={toggleOpen}
        className="flex items-center gap-2 w-full text-left group"
        type="button"
      >
        <ChevronDown
          size={16}
          className={`text-ovo-accent transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
        <h3 className="text-sm font-semibold text-ovo-text group-hover:text-ovo-accent transition-colors">
          {t("settings.advanced.section_title")}
        </h3>
      </button>

      {/* Description — always visible */}
      <p className="mt-1 ml-6 text-xs text-ovo-muted">
        {t("settings.advanced.description")}
      </p>

      {/* Collapsible body */}
      {open && (
        <div className="mt-4 flex flex-col gap-4">

          {/* (a) Default model selector */}
          {/* [START] default model selector — writes to /ovo/settings */}
          <div>
            <label className="text-xs font-medium text-ovo-muted mb-1 block">
              {t("settings.advanced.default_model_label")}
              {settingsSaved && (
                <span className="ml-2 text-ovo-accent">✓</span>
              )}
            </label>
            <select
              value={defaultModel}
              onChange={(e) => void handleDefaultModelChange(e.target.value)}
              className="text-xs border border-ovo-border rounded px-2 py-1.5 bg-ovo-surface-solid text-ovo-text w-full max-w-sm"
            >
              <option value="">{t("settings.advanced.default_model_auto")}</option>
              {models.map((m) => (
                <option key={m.repo_id} value={m.repo_id}>
                  {m.repo_id}
                </option>
              ))}
            </select>
          </div>
          {/* [END] */}

          {/* (b) 3 endpoint cards */}
          {/* [START] endpoint cards grid */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <EndpointCard
              name="Ollama"
              baseUrl={ollamaBase}
              snippets={ollamaSnippets}
              copyLabel={copyLabel}
              copiedLabel={copiedLabel}
              onCopied={handleCopied}
            />
            <EndpointCard
              name="OpenAI"
              baseUrl={openaiBase}
              snippets={openaiSnippets}
              copyLabel={copyLabel}
              copiedLabel={copiedLabel}
              onCopied={handleCopied}
            />
            <EndpointCard
              name="Native"
              baseUrl={nativeBase}
              snippets={nativeSnippets}
              copyLabel={copyLabel}
              copiedLabel={copiedLabel}
              onCopied={handleCopied}
            />
          </div>
          {/* [END] */}

          {/* (c) Tool integration guides */}
          {/* [START] tool guides — native <details> for zero-dependency collapse */}
          <details className="border border-ovo-border rounded bg-ovo-chip">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-ovo-text select-none list-none flex items-center gap-1">
              <ChevronDown size={12} className="text-ovo-accent" />
              {t("settings.advanced.guides_title")}
            </summary>
            <div className="px-3 pb-3 flex flex-col gap-3 pt-2">
              {(
                [
                  { key: "guide_cursor", label: "Cursor" },
                  { key: "guide_continue", label: "Continue.dev" },
                  { key: "guide_zed", label: "Zed" },
                  { key: "guide_generic", label: "OpenAI SDK" },
                ] as const
              ).map(({ key, label }) => (
                <div key={key}>
                  <div className="text-[10px] font-semibold text-ovo-muted mb-1">{label}</div>
                  <code className="text-[10px] font-mono text-ovo-text block bg-ovo-surface rounded p-2 border border-ovo-border whitespace-pre-wrap break-words leading-relaxed">
                    {t(`settings.advanced.${key}`)}
                  </code>
                </div>
              ))}
            </div>
          </details>
          {/* [END] */}

        </div>
      )}
    </section>
  );
}
// [END]

// [START] ToolModeSection — plan / ask / bypass tool-call approval mode.
// Mirrors Claude Code's defaultMode concept; bypass is the fastest default,
// ask surfaces a confirm() dialog per call, plan skips execution entirely.
const TOOL_MODES: ToolMode[] = ["bypass", "ask", "plan"];

function toolModeLabelKey(m: ToolMode): string {
  return `settings.tool_mode.mode_${m}_label`;
}

function toolModeHelpKey(m: ToolMode): string {
  return `settings.tool_mode.mode_${m}_help`;
}

function ToolModeSection() {
  const { t } = useTranslation();
  const mode = useToolModeStore((s) => s.mode);
  const setMode = useToolModeStore((s) => s.setMode);
  return (
    <section className="py-4 border-b border-ovo-border">
      <h3 className="text-sm font-semibold text-ovo-text mb-2">
        {t("settings.tool_mode.section_title")}
      </h3>
      <p className="text-xs text-ovo-muted mb-3">
        {t("settings.tool_mode.description")}
      </p>
      <div className="flex flex-col gap-2">
        {TOOL_MODES.map((m) => (
          <label key={m} className="flex flex-col gap-0.5 cursor-pointer">
            <div className="flex items-center gap-2">
              <input
                type="radio"
                name="tool_mode"
                value={m}
                checked={mode === m}
                onChange={() => setMode(m)}
                className="accent-ovo-accent"
              />
              <span className="text-sm text-ovo-text">{t(toolModeLabelKey(m))}</span>
            </div>
            <p className="ml-5 text-xs text-ovo-muted">{t(toolModeHelpKey(m))}</p>
          </label>
        ))}
      </div>
    </section>
  );
}
// [END]

// [START] ThemeSection — 3-button theme selector (system / light / dark)
const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

function ThemeSection() {
  const { t } = useTranslation();
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <section className="flex items-center justify-between py-3 border-b border-ovo-border">
      <label className="text-sm text-ovo-text">{t("settings.theme")}</label>
      <div className="inline-flex gap-1 rounded-md border border-ovo-border bg-ovo-surface p-0.5">
        {THEME_MODES.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`px-2.5 py-1 text-xs rounded transition ${
              mode === m
                ? "bg-ovo-accent text-ovo-accent-ink"
                : "text-ovo-muted hover:text-ovo-text"
            }`}
          >
            {t(`settings.themes.${m}`)}
          </button>
        ))}
      </div>
    </section>
  );
}
// [END]

// ── Main pane ─────────────────────────────────────────────────────────────────
export function SettingsPane() {
  const { t } = useTranslation();
  const ports = useSidecarStore((s) => s.status.ports);

  // Pet store
  const petEnabled = usePetStore((s) => s.pet_enabled);
  const setPetEnabled = usePetStore((s) => s.setPetEnabled);

  // Chat settings store
  const defaultStrategy = useChatSettingsStore((s) => s.default_strategy);
  const globalWarnThreshold = useChatSettingsStore((s) => s.global_warn_threshold);
  const streamingSendMode = useChatSettingsStore((s) => s.streaming_send_mode);
  const soundEnabled = useChatSettingsStore((s) => s.sound_enabled);
  const setSoundEnabled = useChatSettingsStore((s) => s.setSoundEnabled);
  const setDefaultStrategy = useChatSettingsStore((s) => s.setDefaultStrategy);
  const setGlobalWarnThreshold = useChatSettingsStore((s) => s.setGlobalWarnThreshold);
  const setStreamingSendMode = useChatSettingsStore((s) => s.setStreamingSendMode);
  // [START] Phase 6.4 — sampling parameters (T / top_p / rep. penalty / max tokens)
  const temperature = useChatSettingsStore((s) => s.temperature);
  const topP = useChatSettingsStore((s) => s.top_p);
  const repetitionPenalty = useChatSettingsStore((s) => s.repetition_penalty);
  const maxTokens = useChatSettingsStore((s) => s.max_tokens);
  const setTemperature = useChatSettingsStore((s) => s.setTemperature);
  const setTopP = useChatSettingsStore((s) => s.setTopP);
  const setRepetitionPenalty = useChatSettingsStore((s) => s.setRepetitionPenalty);
  const setMaxTokens = useChatSettingsStore((s) => s.setMaxTokens);
  const resetSampling = useChatSettingsStore((s) => s.resetSampling);
  // [END]

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
    <div className="h-full overflow-y-auto">
      <div className="p-6 max-w-2xl">
        <h2 className="text-lg font-semibold text-ovo-text mb-6">{t("nav.settings")}</h2>

      <section className="flex items-center justify-between py-3 border-b border-ovo-border">
        <label className="text-sm text-ovo-text">{t("settings.language")}</label>
        <LanguageToggle />
      </section>

      {/* [START] Theme selector — system / light / dark */}
      <ThemeSection />
      {/* [END] */}

      <AdvancedSection ports={ports} models={models} />

      {/* [START] Chat input section — streaming send mode */}
      <section className="py-4 border-b border-ovo-border">
        <h3 className="text-sm font-semibold text-ovo-text mb-4">
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
                  className="accent-ovo-accent"
                />
                <span className="text-sm text-ovo-text">{t(streamingModeLabel(m))}</span>
              </div>
              <p className="ml-5 text-xs text-ovo-muted">{t(streamingModeHelp(m))}</p>
            </label>
          ))}
        </div>
        {/* [START] Reply-complete sound toggle */}
        <label className="mt-4 flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={soundEnabled}
            onChange={(e) => setSoundEnabled(e.target.checked)}
            className="accent-ovo-accent"
          />
          <span className="text-sm text-ovo-text">{t("settings.chat_input.sound_label")}</span>
        </label>
        <p className="ml-6 text-xs text-ovo-muted">{t("settings.chat_input.sound_help")}</p>
        {/* [END] */}
      </section>
      {/* [END] */}

      {/* [START] Phase 6.4 — Sampling parameters section */}
      <section className="py-4 border-b border-ovo-border">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-ovo-text">
            {t("settings.sampling.section_title")}
          </h3>
          <button
            type="button"
            onClick={() => resetSampling()}
            className="text-[11px] px-2 py-1 rounded bg-ovo-surface-solid text-ovo-muted hover:text-ovo-text hover:bg-ovo-bg border border-ovo-border transition"
          >
            {t("settings.sampling.reset")}
          </button>
        </div>
        <p className="text-xs text-ovo-muted mb-4">
          {t("settings.sampling.description")}
        </p>
        <div className="flex flex-col gap-5">
          {/* Temperature */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-sm text-ovo-text">
                {t("settings.sampling.temperature")}
              </label>
              <span className="text-xs font-mono tabular-nums text-ovo-muted">
                {temperature.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={temperature}
              onChange={(e) => setTemperature(Number(e.target.value))}
              className="accent-ovo-accent"
            />
            <p className="text-[11px] text-ovo-muted">
              {t("settings.sampling.temperature_help")}
            </p>
          </div>

          {/* Top-p */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-sm text-ovo-text">
                {t("settings.sampling.top_p")}
              </label>
              <span className="text-xs font-mono tabular-nums text-ovo-muted">
                {topP.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={topP}
              onChange={(e) => setTopP(Number(e.target.value))}
              className="accent-ovo-accent"
            />
            <p className="text-[11px] text-ovo-muted">
              {t("settings.sampling.top_p_help")}
            </p>
          </div>

          {/* Repetition penalty */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-sm text-ovo-text">
                {t("settings.sampling.repetition_penalty")}
              </label>
              <span className="text-xs font-mono tabular-nums text-ovo-muted">
                {repetitionPenalty.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={1.5}
              step={0.01}
              value={repetitionPenalty}
              onChange={(e) => setRepetitionPenalty(Number(e.target.value))}
              className="accent-ovo-accent"
            />
            <p className="text-[11px] text-ovo-muted">
              {t("settings.sampling.repetition_penalty_help")}
            </p>
          </div>

          {/* Max tokens */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <label className="text-sm text-ovo-text">
                {t("settings.sampling.max_tokens")}
              </label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-ovo-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={maxTokens === null}
                    onChange={(e) => setMaxTokens(e.target.checked ? null : 2048)}
                    className="accent-ovo-accent"
                  />
                  <span>{t("settings.sampling.max_tokens_unlimited")}</span>
                </label>
                <span className="text-xs font-mono tabular-nums text-ovo-muted w-12 text-right">
                  {maxTokens === null ? "∞" : maxTokens}
                </span>
              </div>
            </div>
            <input
              type="range"
              min={128}
              max={16384}
              step={128}
              disabled={maxTokens === null}
              value={maxTokens ?? 2048}
              onChange={(e) => setMaxTokens(Number(e.target.value))}
              className="accent-ovo-accent disabled:opacity-40"
            />
            <p className="text-[11px] text-ovo-muted">
              {t("settings.sampling.max_tokens_help")}
            </p>
          </div>
        </div>
      </section>
      {/* [END] */}

      {/* [START] Phase 6.1 — Project Context section */}
      <ProjectContextSection />
      {/* [END] */}

      {/* [START] Phase 6.2b — MCP Servers section */}
      <McpServersSection />
      {/* [END] */}

      {/* [START] Phase 6.2c — tool-call approval mode */}
      <ToolModeSection />
      {/* [END] */}

      {/* [START] Context management section (R.6) */}
      <section className="py-4 border-b border-ovo-border">
        <h3 className="text-sm font-semibold text-ovo-text mb-4">
          {t("settings.context.section_title")}
        </h3>

        {/* Compact strategy radio */}
        <div className="mb-5">
          <div className="text-xs font-medium text-ovo-muted mb-2">
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
                  className="accent-ovo-accent"
                />
                <span className="text-sm text-ovo-text">{t(strategyKey(s))}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Global warn threshold slider */}
        <div className="mb-5">
          <div className="text-xs font-medium text-ovo-muted mb-2">
            {t("settings.context.global_threshold_label")}
            <span className="ml-2 font-mono text-ovo-accent">
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
            className="w-full max-w-xs accent-ovo-accent"
          />
          <div className="flex justify-between text-[10px] text-ovo-muted max-w-xs mt-1">
            <span>50%</span>
            <span>95%</span>
          </div>
        </div>

        {/* Model override table */}
        <div>
          <div className="text-xs font-medium text-ovo-muted mb-2">
            {t("settings.context.overrides_title")}
          </div>

          <div className="overflow-x-auto rounded border border-ovo-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-ovo-border/40 text-ovo-muted">
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
              <tbody className="divide-y divide-ovo-border">
                {/* Auto-detected rows — models without overrides */}
                {models
                  .filter((m) => !overrides[m.repo_id])
                  .map((m) => (
                    <tr key={m.repo_id} className="bg-ovo-chip">
                      <td className="px-3 py-2 font-mono text-ovo-muted truncate max-w-[180px]">
                        {m.repo_id}
                      </td>
                      <td className="px-3 py-2 font-mono text-ovo-muted">
                        {m.max_context ?? "—"}
                        <span className="ml-1 text-[10px] text-ovo-muted/60">
                          ({t("settings.context.overrides_auto_detected")})
                        </span>
                      </td>
                      <td className="px-3 py-2 text-ovo-muted/60">
                        {Math.round(globalWarnThreshold * 100)}%
                      </td>
                      <td className="px-3 py-2 text-ovo-muted/40">—</td>
                    </tr>
                  ))}

                {/* Override rows — editable */}
                {overrideList.map((ov) => (
                  <tr key={ov.repo_id} className="bg-ovo-surface-solid">
                    <td className="px-3 py-2 font-mono text-ovo-text truncate max-w-[180px]">
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
                        className="text-xs border border-ovo-border rounded px-2 py-1 bg-ovo-surface-solid text-ovo-text w-24 font-mono"
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
                          className="w-20 accent-ovo-accent"
                        />
                        <span className="text-xs text-ovo-muted w-8">
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
                        className="text-xs px-2 py-1 rounded bg-ovo-border text-ovo-text hover:bg-rose-100 hover:text-rose-700 transition"
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
                      className="px-3 py-4 text-center text-xs text-ovo-muted/60"
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
              className="mt-3 text-xs px-3 py-1.5 rounded bg-ovo-border text-ovo-text hover:bg-ovo-accent hover:text-white transition"
            >
              {t("settings.context.overrides_add")}
            </button>
          )}
        </div>
      </section>
      {/* [END] */}

      {/* [START] Phase 7 — Desktop Pet toggle */}
      <section className="py-4 border-b border-ovo-border">
        <h3 className="text-sm font-semibold text-ovo-text mb-4">
          {t("settings.pet.section_title")}
        </h3>
        <label className="flex flex-col gap-0.5 cursor-pointer">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={petEnabled}
              onChange={(e) => void setPetEnabled(e.target.checked)}
              className="accent-ovo-accent w-4 h-4"
            />
            <span className="text-sm text-ovo-text">{t("settings.pet.enable_label")}</span>
          </div>
          <p className="ml-6 text-xs text-ovo-muted">{t("settings.pet.enable_help")}</p>
        </label>
      </section>
      {/* [END] */}
      </div>
    </div>
  );
}
