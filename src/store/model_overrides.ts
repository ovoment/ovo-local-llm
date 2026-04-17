import { create } from "zustand";
import {
  listOverrides,
  upsertOverride,
  deleteOverride,
} from "../db/model_overrides";
import type { ModelContextOverride } from "../types/ovo";

// [START] ModelOverridesStore — in-memory cache of model_context_overrides rows.
// Loaded once at startup via load(). Mutations write to SQLite then update cache.
interface ModelOverridesState {
  overrides: Record<string, ModelContextOverride>; // keyed by repo_id
  load: () => Promise<void>;
  upsert: (input: Omit<ModelContextOverride, "updated_at">) => Promise<void>;
  remove: (repoId: string) => Promise<void>;
  getOverride: (repoId: string) => ModelContextOverride | null;
}

export const useModelOverridesStore = create<ModelOverridesState>((set, get) => ({
  overrides: {},

  load: async () => {
    try {
      const rows = await listOverrides();
      const map: Record<string, ModelContextOverride> = {};
      for (const row of rows) map[row.repo_id] = row;
      set({ overrides: map });
    } catch (e) {
      console.warn("ModelOverridesStore: load failed", e);
    }
  },

  upsert: async (input) => {
    const row = await upsertOverride(input);
    set((s) => ({ overrides: { ...s.overrides, [row.repo_id]: row } }));
  },

  remove: async (repoId) => {
    await deleteOverride(repoId);
    set((s) => {
      const next = { ...s.overrides };
      delete next[repoId];
      return { overrides: next };
    });
  },

  getOverride: (repoId) => {
    return get().overrides[repoId] ?? null;
  },
}));
// [END]
