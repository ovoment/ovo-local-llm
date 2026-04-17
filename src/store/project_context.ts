import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

// [START] Phase 6.1 — Project Context store.
// Persists project_path + enabled_files to localStorage under "ovo:project_context".
// Scans for CLAUDE.md / AGENTS.md / GEMINI.md via Rust command read_project_context.
// Phase 6.2 additions:
//   - default_project_path: on first launch sets project_path to home dir
//   - custom_files: user-pinned absolute paths to any MD files

const LS_KEY = "ovo:project_context";

const CONTEXT_FILENAMES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md"] as const;
export type ContextFilename = (typeof CONTEXT_FILENAMES)[number];

export interface ProjectContextFile {
  name: ContextFilename;
  content: string;
  size_bytes: number;
}

// [START] Phase 6.2 — custom file entry (runtime, not persisted by default)
export interface CustomContextFile {
  path: string;
  name: string;
  content: string;
  size_bytes: number;
}
// [END]

// Shape returned by the Rust read_project_context command
interface RustProjectContextFile {
  name: string;
  content: string;
  size_bytes: number;
}
interface RustProjectContextResult {
  files: RustProjectContextFile[];
}

// Phase 6.1b — RustMdFileResult removed; read_md_dir is the only path in use.

interface PersistedState {
  project_path: string | null;
  enabled_files: Record<string, boolean>;
  // [START] Phase 6.2 — persisted custom file paths
  custom_files: string[];
  // [END]
}

interface ProjectContextState {
  project_path: string | null;
  enabled_files: Record<string, boolean>;
  loaded_files: ProjectContextFile[];
  loading: boolean;
  // [START] Phase 6.2 — custom file paths (persisted) + loaded entries (runtime)
  custom_files: string[];
  loaded_custom_files: CustomContextFile[];
  // [END]

  setProjectPath: (path: string | null) => Promise<void>;
  setFileEnabled: (name: string, enabled: boolean) => void;
  rescan: () => Promise<void>;
  getEffectivePrompt: () => string;
  load: () => void;
  // [START] Phase 6.2 — custom file actions
  addCustomFile: (path: string) => Promise<void>;
  removeCustomFile: (path: string) => void;
  // [END]
}

// [START] Default enabled state — all 3 filenames true
function defaultEnabled(): Record<string, boolean> {
  return Object.fromEntries(CONTEXT_FILENAMES.map((n) => [n, true]));
}
// [END]

// [START] Phase 6.2 — persist helper extended with custom_files
function persist(
  project_path: string | null,
  enabled_files: Record<string, boolean>,
  custom_files: string[],
): void {
  try {
    const payload: PersistedState = { project_path, enabled_files, custom_files };
    localStorage.setItem(LS_KEY, JSON.stringify(payload));
  } catch {
    // storage unavailable — silent
  }
}
// [END]

function readStorage(): Partial<PersistedState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<PersistedState>;
  } catch {
    return {};
  }
}

// [START] Phase 6.1b — each custom path is a DIRECTORY; load reads every
// *.md / *.markdown file inside it and returns one CustomContextFile per file.
interface RustMdDirResult {
  files: Array<{ name: string; path: string; content: string; size_bytes: number }>;
}

async function loadCustomDir(dirPath: string): Promise<CustomContextFile[]> {
  try {
    const result = await invoke<RustMdDirResult>("read_md_dir", { path: dirPath });
    return result.files.map((f) => ({
      path: f.path,
      name: f.name,
      content: f.content,
      size_bytes: f.size_bytes,
    }));
  } catch (e) {
    console.warn("project_context: failed to read dir", dirPath, e);
    return [];
  }
}
// [END]

export const useProjectContextStore = create<ProjectContextState>((set, get) => ({
  project_path: null,
  enabled_files: defaultEnabled(),
  loaded_files: [],
  loading: false,
  // [START] Phase 6.2 — initial custom file state
  custom_files: [],
  loaded_custom_files: [],
  // [END]

  // [START] load — hydrate from localStorage on app bootstrap
  // Phase 6.2: if no project_path stored, invoke default_project_path and auto-rescan
  load: () => {
    const stored = readStorage();
    const customFiles = Array.isArray(stored.custom_files) ? stored.custom_files : [];

    if (stored.project_path != null) {
      // Normal hydration — project already chosen previously
      set({
        project_path: stored.project_path,
        enabled_files: stored.enabled_files ?? defaultEnabled(),
        custom_files: customFiles,
      });
      void get().rescan();
    } else {
      // [START] Phase 6.2 — first launch: default to home dir
      void invoke<string>("default_project_path")
        .then((homePath) => {
          set({
            project_path: homePath,
            enabled_files: stored.enabled_files ?? defaultEnabled(),
            custom_files: customFiles,
          });
          persist(homePath, get().enabled_files, customFiles);
          return get().rescan();
        })
        .catch((e) => {
          console.warn("project_context: could not resolve default_project_path", e);
          set({
            enabled_files: stored.enabled_files ?? defaultEnabled(),
            custom_files: customFiles,
          });
        });
      // [END]
    }
  },
  // [END]

  // [START] setProjectPath — saves path and triggers an immediate rescan
  setProjectPath: async (path) => {
    const { enabled_files, custom_files } = get();
    set({ project_path: path, loaded_files: [] });
    persist(path, enabled_files, custom_files);
    if (path) {
      await get().rescan();
    }
  },
  // [END]

  // [START] setFileEnabled — toggle which files contribute to effective prompt
  setFileEnabled: (name, enabled) => {
    const next = { ...get().enabled_files, [name]: enabled };
    set({ enabled_files: next });
    persist(get().project_path, next, get().custom_files);
  },
  // [END]

  // [START] rescan — invoke Rust command and update loaded_files + re-read custom files
  rescan: async () => {
    const { project_path, custom_files } = get();
    set({ loading: true });

    try {
      // Standard files (CLAUDE.md / AGENTS.md / GEMINI.md)
      let loaded: ProjectContextFile[] = [];
      if (project_path) {
        const result = await invoke<RustProjectContextResult>("read_project_context", {
          projectPath: project_path,
        });
        loaded = result.files
          .filter((f): f is RustProjectContextFile =>
            (CONTEXT_FILENAMES as readonly string[]).includes(f.name),
          )
          .map((f) => ({
            name: f.name as ContextFilename,
            content: f.content,
            size_bytes: f.size_bytes,
          }));
      }

      // [START] Phase 6.2 — re-read all custom files (skip failed ones silently)
      const loadedCustomResults = await Promise.all(custom_files.map(loadCustomDir));
      const loaded_custom_files: CustomContextFile[] = loadedCustomResults.flat().filter(
        (r): r is CustomContextFile => r !== null,
      );
      // [END]

      set({ loaded_files: loaded, loaded_custom_files, loading: false });
    } catch (e) {
      console.warn("project_context: rescan failed", e);
      set({ loading: false });
    }
  },
  // [END]

  // [START] getEffectivePrompt — concat enabled standard files then custom files
  getEffectivePrompt: () => {
    const { loaded_files, enabled_files, loaded_custom_files } = get();
    const parts: string[] = [];

    for (const f of loaded_files) {
      if (enabled_files[f.name] !== false) {
        parts.push(`# ${f.name}\n\n${f.content}`);
      }
    }

    // [START] Phase 6.2 — custom files always included when present
    for (const f of loaded_custom_files) {
      parts.push(`# ${f.name}\n\n${f.content}`);
    }
    // [END]

    return parts.join("\n\n---\n\n");
  },
  // [END]

  // [START] Phase 6.1b — addCustomFile now accepts a DIRECTORY path; reads
  // every *.md / *.markdown inside it. Kept the same action name to avoid
  // rippling renames through consumers.
  addCustomFile: async (path: string) => {
    const { custom_files, loaded_custom_files, project_path, enabled_files } = get();
    if (custom_files.includes(path)) return; // deduplicate

    const entries = await loadCustomDir(path);
    const next_custom_files = [...custom_files, path];
    const next_loaded = [...loaded_custom_files, ...entries];

    set({ custom_files: next_custom_files, loaded_custom_files: next_loaded });
    persist(project_path, enabled_files, next_custom_files);
  },
  // [END]

  // [START] Phase 6.2 — removeCustomFile: remove from list + loaded, persist
  removeCustomFile: (path: string) => {
    const { custom_files, loaded_custom_files, project_path, enabled_files } = get();
    const next_custom_files = custom_files.filter((p) => p !== path);
    const next_loaded = loaded_custom_files.filter((f) => f.path !== path);

    set({ custom_files: next_custom_files, loaded_custom_files: next_loaded });
    persist(project_path, enabled_files, next_custom_files);
  },
  // [END]
}));
// [END]
