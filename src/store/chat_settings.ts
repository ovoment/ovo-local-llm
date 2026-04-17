import { create } from "zustand";
import type { CompactStrategy } from "../types/ovo";

// [START] ChatSettings — global compact strategy, warn threshold, and streaming send mode.
// Persisted to localStorage under key "ovo:chat_settings".
const LS_KEY = "ovo:chat_settings";

export type StreamingSendMode = "queue" | "interrupt" | "block";

export interface ChatSettings {
  default_strategy: CompactStrategy;
  global_warn_threshold: number; // 0–1, default 0.75
  streaming_send_mode: StreamingSendMode; // default "queue"
}

interface ChatSettingsState extends ChatSettings {
  setDefaultStrategy: (strategy: CompactStrategy) => void;
  setGlobalWarnThreshold: (threshold: number) => void;
  setStreamingSendMode: (mode: StreamingSendMode) => void;
  load: () => void;
}

const DEFAULTS: ChatSettings = {
  default_strategy: "auto",
  global_warn_threshold: 0.75,
  streaming_send_mode: "queue",
};

function persist(state: ChatSettings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable — silent
  }
}

function readStorage(): Partial<ChatSettings> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Partial<ChatSettings>;
  } catch {
    return {};
  }
}

export const useChatSettingsStore = create<ChatSettingsState>((set, get) => ({
  ...DEFAULTS,

  load: () => {
    const stored = readStorage();
    const next: ChatSettings = {
      default_strategy: stored.default_strategy ?? DEFAULTS.default_strategy,
      global_warn_threshold:
        typeof stored.global_warn_threshold === "number"
          ? stored.global_warn_threshold
          : DEFAULTS.global_warn_threshold,
      streaming_send_mode: stored.streaming_send_mode ?? DEFAULTS.streaming_send_mode,
    };
    set(next);
  },

  setDefaultStrategy: (strategy) => {
    set({ default_strategy: strategy });
    const s = get();
    persist({ default_strategy: strategy, global_warn_threshold: s.global_warn_threshold, streaming_send_mode: s.streaming_send_mode });
  },

  setGlobalWarnThreshold: (threshold) => {
    set({ global_warn_threshold: threshold });
    const s = get();
    persist({ default_strategy: s.default_strategy, global_warn_threshold: threshold, streaming_send_mode: s.streaming_send_mode });
  },

  // [START] setStreamingSendMode — persists new mode alongside existing fields
  setStreamingSendMode: (mode) => {
    set({ streaming_send_mode: mode });
    const s = get();
    persist({ default_strategy: s.default_strategy, global_warn_threshold: s.global_warn_threshold, streaming_send_mode: mode });
  },
  // [END]
}));
// [END]
