import { open } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { useProjectContextStore } from "../store/project_context";

// [START] Phase 6.1 — ProjectContextSection
// Shown in SettingsPane before the "컨텍스트 관리" section.
// Lets the user pick a project folder; OVO scans it for CLAUDE.md / AGENTS.md / GEMINI.md
// and injects enabled files into the system prompt at send time.
// Phase 6.2: adds custom MD file list (any absolute path on disk).

const CONTEXT_FILENAMES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"] as const;

export function ProjectContextSection() {
  const { t } = useTranslation();

  const project_path = useProjectContextStore((s) => s.project_path);
  const enabled_files = useProjectContextStore((s) => s.enabled_files);
  const loaded_files = useProjectContextStore((s) => s.loaded_files);
  const loading = useProjectContextStore((s) => s.loading);
  const setProjectPath = useProjectContextStore((s) => s.setProjectPath);
  const setFileEnabled = useProjectContextStore((s) => s.setFileEnabled);
  const rescan = useProjectContextStore((s) => s.rescan);
  // [START] Phase 6.2 — custom file state + actions
  const custom_files = useProjectContextStore((s) => s.custom_files);
  const loaded_custom_files = useProjectContextStore((s) => s.loaded_custom_files);
  const addCustomFile = useProjectContextStore((s) => s.addCustomFile);
  const removeCustomFile = useProjectContextStore((s) => s.removeCustomFile);
  // [END]

  // [START] folder picker — uses @tauri-apps/plugin-dialog
  async function handlePickFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string" && selected.length > 0) {
      await setProjectPath(selected);
    }
  }
  // [END]

  async function handleClearFolder() {
    await setProjectPath(null);
  }

  // [START] derive per-filename display info
  function fileInfo(name: string): { found: boolean; size_bytes: number } {
    const f = loaded_files.find((x) => x.name === name);
    return f ? { found: true, size_bytes: f.size_bytes } : { found: false, size_bytes: 0 };
  }
  // [END]

  // [START] total chars + rough token estimate (length/3, Korean-friendly)
  const standardChars = loaded_files
    .filter((f) => enabled_files[f.name] !== false)
    .reduce((acc, f) => acc + f.content.length, 0);
  const customChars = loaded_custom_files.reduce((acc, f) => acc + f.content.length, 0);
  const totalChars = standardChars + customChars;
  const tokenEstimate = Math.round(totalChars / 3);
  // [END]

  // [START] Phase 6.1b — custom path picker: pick a folder, we read every
  // *.md / *.markdown inside it. Multiple folders can be added.
  async function handleAddCustomFile() {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string" && selected.length > 0) {
      await addCustomFile(selected);
    }
  }
  // [END]

  return (
    <section className="py-4 border-b border-ovo-border">
      {/* Header */}
      <h3 className="text-sm font-semibold text-ovo-text mb-1">
        {t("settings.project_context.section_title")}
      </h3>
      <p className="text-xs text-ovo-muted mb-4">
        {t("settings.project_context.description")}
      </p>

      {/* [START] folder picker row — inline [path] [btn] [btn] [btn] */}
      {project_path ? (
        <div className="flex items-center gap-2 mb-4">
          <code className="flex-1 min-w-0 text-[11px] font-mono text-ovo-text bg-ovo-chip border border-ovo-border rounded px-2 py-1.5 truncate">
            {project_path}
          </code>
          <button
            type="button"
            onClick={() => void handlePickFolder()}
            className="shrink-0 text-xs px-2.5 py-1 rounded bg-ovo-border text-ovo-text hover:bg-ovo-accent hover:text-white transition"
          >
            {t("settings.project_context.change_folder")}
          </button>
          <button
            type="button"
            onClick={() => void handleClearFolder()}
            className="shrink-0 text-xs px-2.5 py-1 rounded bg-ovo-border text-ovo-text hover:bg-rose-100 hover:text-rose-700 transition"
          >
            {t("settings.project_context.clear_folder")}
          </button>
          <button
            type="button"
            onClick={() => void rescan()}
            disabled={loading}
            className="shrink-0 text-xs px-2.5 py-1 rounded bg-ovo-border text-ovo-text hover:bg-ovo-accent hover:text-white transition disabled:opacity-40"
          >
            {t("settings.project_context.rescan")}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3 mb-4">
          <button
            type="button"
            onClick={() => void handlePickFolder()}
            className="text-xs px-3 py-1.5 rounded bg-ovo-accent text-white hover:bg-ovo-accent-hover transition"
          >
            {t("settings.project_context.pick_folder")}
          </button>
          <span className="text-xs text-ovo-muted">
            {t("settings.project_context.no_folder")}
          </span>
        </div>
      )}
      {/* [END] */}

      {/* [START] Standard files — inline single-row layout:
          [ ] CLAUDE.md (없음) / [ ] AGENTS.md (N B) / [ ] GEMINI.md (없음) */}
      {project_path && (
        <div className="flex items-center gap-2 flex-wrap mb-3 text-xs">
          {CONTEXT_FILENAMES.map((name, idx) => {
            const info = fileInfo(name);
            const checked = enabled_files[name] !== false;
            return (
              <span key={name} className="flex items-center gap-1">
                {idx > 0 && <span className="text-ovo-muted mx-1">/</span>}
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setFileEnabled(name, e.target.checked)}
                  className="accent-ovo-accent"
                  disabled={!info.found}
                />
                <span className={`font-mono ${info.found ? "text-ovo-text" : "text-ovo-muted"}`}>
                  {name}
                </span>
                <span className="text-ovo-muted">
                  {info.found
                    ? `(${info.size_bytes.toLocaleString()} B)`
                    : t("settings.project_context.not_found")}
                </span>
              </span>
            );
          })}
        </div>
      )}
      {/* [END] */}
      {/* [END] */}

      {/* [START] Phase 6.1b — custom MD directories subsection
          Header row: "추가 MD파일"  on left, "+ 경로추가" button on right.
          Each path = a folder; all *.md inside are auto-loaded. */}
      <div className="mt-4">
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-xs font-semibold text-ovo-text">
            {t("settings.project_context.custom_title")}
          </h4>
          <button
            type="button"
            onClick={() => void handleAddCustomFile()}
            className="text-xs px-2.5 py-1 rounded bg-ovo-border text-ovo-text hover:bg-ovo-accent hover:text-white transition"
          >
            {t("settings.project_context.custom_add")}
          </button>
        </div>
        <p className="text-[11px] text-ovo-muted mb-2">
          {t("settings.project_context.custom_hint")}
        </p>

        {custom_files.length === 0 ? (
          <p className="text-xs text-ovo-muted mb-2">
            {t("settings.project_context.custom_empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-1.5 mb-2">
            {custom_files.map((path) => {
              const loaded = loaded_custom_files.find((f) => f.path === path);
              const sizeLabel = loaded
                ? t("settings.project_context.detected", {
                    size: loaded.size_bytes.toLocaleString(),
                  })
                : "…";
              // Truncate long paths for display: show last ~50 chars
              const displayPath =
                path.length > 52 ? `…${path.slice(path.length - 50)}` : path;

              return (
                <div
                  key={path}
                  className="flex items-center gap-2 bg-ovo-chip border border-ovo-border rounded px-2 py-1.5"
                >
                  <code className="flex-1 text-[11px] font-mono text-ovo-text truncate min-w-0">
                    {displayPath}
                  </code>
                  <span className="text-[10px] text-ovo-muted shrink-0">{sizeLabel}</span>
                  <button
                    type="button"
                    onClick={() => removeCustomFile(path)}
                    title={t("settings.project_context.custom_remove")}
                    className="shrink-0 text-[11px] px-1.5 py-0.5 rounded text-ovo-muted hover:bg-rose-100 hover:text-rose-700 transition"
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}

      </div>
      {/* [END] */}

      {/* [START] total size / token estimate preview */}
      {totalChars > 0 && (
        <p className="text-xs text-ovo-muted mt-3">
          {t("settings.project_context.total_size", {
            size: totalChars.toLocaleString(),
            tokens: tokenEstimate.toLocaleString(),
          })}
        </p>
      )}
      {/* [END] */}
    </section>
  );
}
// [END]
