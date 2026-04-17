// [START] Phase 6.2b — MCP Servers Settings section
// Collapsible section in SettingsPane that lets users manage MCP server configs.
// Config format matches Claude Desktop's claude_desktop_config.json for copy-paste parity.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useMcpStore } from "../store/mcp";
import { useToastsStore } from "../store/toasts";
import { useProjectContextStore } from "../store/project_context";
import { MCP_PRESETS, expandArgs, type McpPreset } from "../lib/mcp_presets";

const LS_KEY_MCP_OPEN = "ovo:settings_mcp_open";

// ── Status dot ────────────────────────────────────────────────────────────────

interface StatusDotProps {
  running: boolean;
  error?: string;
}

function StatusDot({ running, error }: StatusDotProps) {
  if (error) {
    return (
      <span
        className="inline-block w-2 h-2 rounded-full bg-rose-500 shrink-0"
        title={error}
      />
    );
  }
  if (running) {
    return <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 shrink-0" />;
  }
  return <span className="inline-block w-2 h-2 rounded-full bg-ovo-muted/40 shrink-0" />;
}

// ── Tool count badge with tooltip ────────────────────────────────────────────

interface ToolBadgeProps {
  tools: Array<{ name: string; description?: string }>;
  label: string;
}

function ToolBadge({ tools, label }: ToolBadgeProps) {
  const tooltipText = tools.map((t) => t.name).join(", ");
  if (tools.length === 0) return null;
  return (
    <span
      title={tooltipText}
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-ovo-chip border border-ovo-border text-ovo-muted cursor-default"
    >
      {label}
    </span>
  );
}

// ── Add server form ───────────────────────────────────────────────────────────

interface AddServerFormProps {
  onAdd: (cfg: { name: string; command: string; args: string[]; env: Record<string, string> }) => Promise<void>;
  onCancel: () => void;
}

function AddServerForm({ onAdd, onCancel }: AddServerFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsRaw, setArgsRaw] = useState("");
  const [envRaw, setEnvRaw] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // [START] parse env — KEY=VALUE per line → Record<string, string>
  function parseEnv(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      if (k) result[k] = v;
    }
    return result;
  }
  // [END]

  async function handleSubmit() {
    if (!name.trim() || !command.trim()) return;
    setSubmitting(true);
    try {
      const args = argsRaw
        .split(",")
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      const env = parseEnv(envRaw);
      await onAdd({ name: name.trim(), command: command.trim(), args, env });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // [START] add server form — matches Claude Desktop JSON shape: { command, args, env }
    <div className="mt-3 p-3 rounded border border-ovo-border bg-ovo-chip flex flex-col gap-2">
      {/* name */}
      <div className="flex flex-col gap-0.5">
        <label className="text-[11px] font-medium text-ovo-muted">
          {t("settings.mcp.name_label")}
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="text-xs border border-ovo-border rounded px-2 py-1 bg-ovo-surface-solid text-ovo-text"
          placeholder="my-filesystem-server"
        />
      </div>

      {/* command */}
      <div className="flex flex-col gap-0.5">
        <label className="text-[11px] font-medium text-ovo-muted">
          {t("settings.mcp.command_label")}
        </label>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          className="text-xs font-mono border border-ovo-border rounded px-2 py-1 bg-ovo-surface-solid text-ovo-text"
          placeholder="npx"
        />
      </div>

      {/* args */}
      <div className="flex flex-col gap-0.5">
        <label className="text-[11px] font-medium text-ovo-muted">
          {t("settings.mcp.args_label")}
        </label>
        <input
          type="text"
          value={argsRaw}
          onChange={(e) => setArgsRaw(e.target.value)}
          className="text-xs font-mono border border-ovo-border rounded px-2 py-1 bg-ovo-surface-solid text-ovo-text"
          placeholder="@modelcontextprotocol/server-filesystem,/path/to/folder"
        />
        <p className="text-[10px] text-ovo-muted/60">{t("settings.mcp.example_hint")}</p>
      </div>

      {/* env */}
      <div className="flex flex-col gap-0.5">
        <label className="text-[11px] font-medium text-ovo-muted">
          {t("settings.mcp.env_label")}
        </label>
        <textarea
          value={envRaw}
          onChange={(e) => setEnvRaw(e.target.value)}
          rows={2}
          className="text-xs font-mono border border-ovo-border rounded px-2 py-1 bg-ovo-surface-solid text-ovo-text resize-none"
          placeholder={"GITHUB_TOKEN=ghp_...\nAPI_KEY=..."}
        />
      </div>

      {/* actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => void handleSubmit()}
          disabled={submitting || !name.trim() || !command.trim()}
          className="text-xs px-3 py-1.5 rounded bg-ovo-accent text-white hover:bg-ovo-accent-hover transition disabled:opacity-50"
        >
          {t("settings.mcp.save")}
        </button>
        <button
          onClick={onCancel}
          className="text-xs px-3 py-1.5 rounded bg-ovo-border text-ovo-text hover:bg-ovo-accent hover:text-white transition"
        >
          {t("settings.mcp.cancel")}
        </button>
      </div>
    </div>
    // [END]
  );
}

// ── npm registry search types + type-guard ───────────────────────────────────
// [START] npm search types — typed response from registry.npmjs.org/-/v1/search

interface NpmPackage {
  name: string;
  version: string;
  description: string;
  keywords: string[];
  links: { npm?: string };
}

interface NpmSearchObject {
  package: NpmPackage;
}

interface NpmSearchResponse {
  objects: NpmSearchObject[];
}

function isNpmPackage(v: unknown): v is NpmPackage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["name"] === "string" &&
    typeof o["version"] === "string"
  );
}

function isNpmSearchObject(v: unknown): v is NpmSearchObject {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return isNpmPackage(o["package"]);
}

function isNpmSearchResponse(v: unknown): v is NpmSearchResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o["objects"]) && o["objects"].every(isNpmSearchObject);
}

/** Returns true if the package looks like an MCP server. */
function isMcpRelated(pkg: NpmPackage): boolean {
  const name = pkg.name.toLowerCase();
  const keywords = (pkg.keywords ?? []).map((k) => k.toLowerCase());
  const combined = [name, ...keywords].join(" ");
  return (
    combined.includes("mcp") ||
    combined.includes("model-context") ||
    combined.includes("model context")
  );
}
// [END]

// ── MCP Search panel ──────────────────────────────────────────────────────────

interface McpSearchPanelProps {
  installedNames: Set<string>;
  onInstall: (name: string) => void;
}

function McpSearchPanel({ installedNames, onInstall }: McpSearchPanelProps) {
  // [START] MCP npm search panel — debounced fetch from registry.npmjs.org
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NpmPackage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    debounceRef.current = setTimeout(() => {
      // Proxy through Rust to bypass Tauri webview CORS — registry.npmjs.org
      // rejects the `tauri://` origin so a direct fetch returns empty.
      invoke<string>("npm_search", { query: trimmed, size: 20 })
        .then((raw) => {
          let data: unknown;
          try {
            data = JSON.parse(raw);
          } catch (err) {
            console.warn("npm_search: invalid JSON", err);
            setResults([]);
            setError(t("settings.mcp.search_error"));
            return;
          }
          if (!isNpmSearchResponse(data)) {
            setResults([]);
            return;
          }
          const filtered = data.objects
            .map((o) => o.package)
            .filter(isMcpRelated)
            .filter((pkg) => !installedNames.has(pkg.name));
          setResults(filtered);
        })
        .catch((err: unknown) => {
          // Surface the actual Rust error so the user can tell apart
          // "command not found" (needs app restart after Rust rebuild)
          // from a real network / registry failure.
          const msg = err instanceof Error ? err.message : String(err ?? "");
          console.warn("npm_search failed:", msg);
          setError(`${t("settings.mcp.search_error")} — ${msg}`);
        })
        .finally(() => setLoading(false));
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, installedNames, t]);

  function handleInstall(pkg: NpmPackage) {
    onInstall(pkg.name);
  }

  return (
    <div className="mt-1 flex flex-col gap-2">
      {/* search input */}
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("settings.mcp.search_placeholder")}
        className="text-xs border border-ovo-border rounded px-2 py-1.5 bg-ovo-surface-solid text-ovo-text placeholder:text-ovo-muted/50 focus:outline-none focus:ring-1 focus:ring-ovo-accent"
      />
      {/* tip */}
      <p className="text-[10px] text-ovo-muted/60 -mt-1">
        {t("settings.mcp.search_tip")}
      </p>

      {/* loading */}
      {loading && (
        <div className="flex items-center gap-1 py-2">
          <span className="w-1 h-1 rounded-full bg-ovo-muted animate-bounce [animation-delay:-0.3s]" />
          <span className="w-1 h-1 rounded-full bg-ovo-muted animate-bounce [animation-delay:-0.15s]" />
          <span className="w-1 h-1 rounded-full bg-ovo-muted animate-bounce" />
        </div>
      )}

      {/* error with retry */}
      {!loading && error && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-rose-500">{error}</span>
          <button
            type="button"
            onClick={() => setQuery((q) => q + " ")}
            className="text-[10px] px-2 py-0.5 rounded border border-ovo-border text-ovo-muted hover:bg-ovo-accent hover:text-white hover:border-ovo-accent transition"
          >
            {t("common.retry")}
          </button>
        </div>
      )}

      {/* no results */}
      {!loading && !error && query.trim() && results.length === 0 && (
        <p className="text-xs text-ovo-muted/60 py-1">
          {t("settings.mcp.search_empty")}
        </p>
      )}

      {/* results */}
      {!loading && !error && results.length > 0 && (
        <div className="flex flex-col gap-1">
          {results.map((pkg) => (
            <div
              key={pkg.name}
              className="flex items-start gap-2 px-3 py-2 rounded border border-ovo-border bg-ovo-chip"
            >
              {/* package name + version */}
              <div className="flex flex-col min-w-0 flex-1 gap-0.5">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-xs font-mono font-semibold text-ovo-text truncate">
                    {pkg.name}
                  </span>
                  <span className="text-[10px] px-1 py-0.5 rounded bg-ovo-border text-ovo-muted font-mono shrink-0">
                    {pkg.version}
                  </span>
                </div>
                {pkg.description && (
                  <span className="text-[10px] text-ovo-muted/80 line-clamp-2 break-words">
                    {pkg.description}
                  </span>
                )}
              </div>
              {/* install button */}
              <button
                type="button"
                onClick={() => handleInstall(pkg)}
                className="shrink-0 text-xs px-2.5 py-1 rounded bg-ovo-accent text-white hover:bg-ovo-accent-hover transition"
              >
                {t("settings.mcp.install_btn")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
  // [END]
}

// ── Main section component ────────────────────────────────────────────────────

export function McpServersSection() {
  const { t } = useTranslation();

  // [START] collapse state — default closed, persisted to localStorage
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_KEY_MCP_OPEN) === "true"; } catch { return false; }
  });

  function toggleExpanded() {
    setExpanded((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY_MCP_OPEN, String(next)); } catch { /* ignore */ }
      return next;
    });
  }
  // [END]

  // [START] add-form visibility
  const [showAddForm, setShowAddForm] = useState(false);
  // [END]

  // [START] search panel visibility
  const [showSearch, setShowSearch] = useState(false);
  // [END]

  // [START] Zustand selectors — no any/unknown at component boundary
  const servers = useMcpStore((s) => s.servers);
  const status = useMcpStore((s) => s.status);
  const addServer = useMcpStore((s) => s.addServer);
  const removeServer = useMcpStore((s) => s.removeServer);
  const startServer = useMcpStore((s) => s.startServer);
  const stopServer = useMcpStore((s) => s.stopServer);
  const refreshStatus = useMcpStore((s) => s.refreshStatus);
  // [END]

  // [START] polling — 2s interval only when section is expanded (saves wasted work)
  useEffect(() => {
    if (!expanded) return;
    void refreshStatus(); // immediate on expand
    const id = setInterval(() => void refreshStatus(), 2000);
    return () => clearInterval(id);
  }, [expanded, refreshStatus]);
  // [END]

  // [START] add server handler — auto-starts after adding
  async function handleAdd(cfg: { name: string; command: string; args: string[]; env: Record<string, string> }) {
    await addServer(cfg);
    setShowAddForm(false);
  }
  // [END]

  // [START] Quick-add preset handler — fills project_path token if needed.
  // For presets that declare env keys with an empty-string default (e.g. API
  // keys), prompt the user for each missing value before adding. Cancelling
  // any prompt aborts the add. Follow-up (Phase 6.4): replace prompt() with
  // an inline env editor so the same flow also covers post-add edits.
  const project_path = useProjectContextStore((s) => s.project_path);
  async function handleAddPreset(preset: McpPreset) {
    if (preset.requires?.includes("project_path") && !project_path) {
      // No project path set — still add, using empty string; user can edit later.
    }
    const args = expandArgs(preset.args_template, { project_path });
    const env: Record<string, string> = { ...preset.env };
    for (const [key, value] of Object.entries(env)) {
      if (value === "") {
        const input = window.prompt(`${preset.name} — ${key}`);
        if (input === null) return; // user cancelled
        env[key] = input;
      }
    }
    await addServer({
      name: preset.name,
      command: preset.command,
      args,
      env,
    });
  }
  // [END]

  // [START] handleInstallFromSearch — adds server via npx -y <package>
  function handleInstallFromSearch(pkgName: string) {
    void addServer({
      name: pkgName,
      command: "npx",
      args: ["-y", pkgName],
      env: {},
    });
    useToastsStore.getState().push({
      kind: "info",
      message: t("settings.mcp.install_started", { name: pkgName }),
    });
  }
  // [END]

  return (
    <section className="py-4 border-b border-ovo-border">
      {/* Header — always visible, clickable to collapse */}
      <button
        onClick={toggleExpanded}
        className="flex items-center gap-2 w-full text-left group"
        type="button"
      >
        <ChevronDown
          size={16}
          className={`text-ovo-accent transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`}
        />
        <h3 className="text-sm font-semibold text-ovo-text group-hover:text-ovo-accent transition-colors">
          {t("settings.mcp.section_title")}
        </h3>
      </button>

      {/* Description — always visible */}
      <p className="mt-1 ml-6 text-xs text-ovo-muted">
        {t("settings.mcp.description")}
      </p>

      {/* Collapsible body */}
      {expanded && (
        <div className="mt-3 ml-0 flex flex-col gap-2">

          {/* [START] Quick-add presets — one-click install for common servers.
              Hides a preset once it's been added (matched by name). */}
          {(() => {
            const installedNames = new Set(servers.map((s) => s.name));
            const available = MCP_PRESETS.filter((p) => !installedNames.has(p.name));
            if (available.length === 0) return null;
            return (
              <div className="mb-1">
                <p className="text-[11px] text-ovo-muted mb-1.5">
                  {t("settings.mcp.presets_hint")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {available.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => void handleAddPreset(preset)}
                      title={preset.description}
                      className="text-xs px-2.5 py-1 rounded bg-ovo-chip border border-ovo-chip-border text-ovo-text hover:bg-ovo-accent hover:text-ovo-accent-ink transition"
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
          {/* [END] */}

          {/* [START] MCP search panel — collapsible, between presets and server list */}
          <div>
            <button
              type="button"
              onClick={() => setShowSearch((prev) => !prev)}
              className="flex items-center gap-1 text-xs text-ovo-muted hover:text-ovo-accent transition"
            >
              <ChevronDown
                size={13}
                className={`transition-transform duration-200 ${showSearch ? "" : "-rotate-90"}`}
              />
              {t("settings.mcp.search_btn")}
            </button>
            {showSearch && (
              <div className="mt-2">
                <McpSearchPanel
                  installedNames={new Set(servers.map((s) => s.name))}
                  onInstall={handleInstallFromSearch}
                />
              </div>
            )}
          </div>
          {/* [END] */}

          {/* [START] server list */}
          {servers.length === 0 && !showAddForm ? (
            <p className="text-xs text-ovo-muted/60 py-2">
              {t("settings.mcp.empty")}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {servers.map((srv) => {
                const st = status[srv.server_id];
                const running = st?.running ?? false;
                const error = st?.error;
                const tools = st?.tools ?? [];
                const toolLabel = t("settings.mcp.tool_count", { count: tools.length });

                return (
                  <div
                    key={srv.server_id}
                    className="flex items-center gap-2 px-3 py-2 rounded border border-ovo-border bg-ovo-chip"
                  >
                    {/* status dot */}
                    <StatusDot running={running} error={error} />

                    {/* name */}
                    <span className="text-xs font-semibold text-ovo-text min-w-0 shrink-0 max-w-[100px] truncate">
                      {srv.name}
                    </span>

                    {/* command + args — monospace, truncated */}
                    <span
                      className="text-[10px] font-mono text-ovo-muted truncate flex-1 min-w-0"
                      title={[srv.command, ...srv.args].join(" ")}
                    >
                      {srv.command}
                      {srv.args.length > 0 ? " " + srv.args.join(" ") : ""}
                    </span>

                    {/* tool count badge */}
                    {tools.length > 0 && (
                      <ToolBadge tools={tools} label={toolLabel} />
                    )}

                    {/* start / stop button */}
                    <button
                      onClick={() =>
                        running
                          ? void stopServer(srv.server_id)
                          : void startServer(srv.server_id)
                      }
                      className="text-[10px] px-2 py-0.5 rounded border border-ovo-border text-ovo-muted hover:bg-ovo-accent hover:text-white hover:border-ovo-accent transition shrink-0"
                    >
                      {running ? t("settings.mcp.stop") : t("settings.mcp.start")}
                    </button>

                    {/* remove button */}
                    <button
                      onClick={() => {
                        if (window.confirm(t("settings.mcp.confirm_remove"))) {
                          void removeServer(srv.server_id);
                        }
                      }}
                      className="text-[10px] px-2 py-0.5 rounded border border-ovo-border text-ovo-muted hover:bg-rose-100 hover:text-rose-700 hover:border-rose-300 transition shrink-0"
                    >
                      {t("settings.mcp.remove")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {/* [END] */}

          {/* [START] add server form / button */}
          {showAddForm ? (
            <AddServerForm
              onAdd={handleAdd}
              onCancel={() => setShowAddForm(false)}
            />
          ) : (
            <button
              onClick={() => setShowAddForm(true)}
              className="self-start mt-1 text-xs px-3 py-1.5 rounded bg-ovo-border text-ovo-text hover:bg-ovo-accent hover:text-white transition"
            >
              {t("settings.mcp.add_server")}
            </button>
          )}
          {/* [END] */}

        </div>
      )}
    </section>
  );
}
// [END] Phase 6.2b
