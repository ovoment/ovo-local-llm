import { create } from "zustand";
import type { CompactStrategy } from "../types/ovo";

// [START] ChatSettings — global compact strategy, warn threshold, streaming
// send mode, and sampling parameters. Persisted to localStorage under key
// "ovo:chat_settings".
const LS_KEY = "ovo:chat_settings";

export type StreamingSendMode = "queue" | "interrupt" | "block";

export interface ChatSettings {
  default_strategy: CompactStrategy;
  global_warn_threshold: number; // 0–1, default 0.75
  streaming_send_mode: StreamingSendMode; // default "queue"
  sound_enabled: boolean; // play owl-hoot on reply complete, default true
  // [START] Phase 6.4 — sampling parameters (per-model MLX generation knobs).
  // All four values are passed through to the sidecar OpenAI-compat endpoint
  // on every /v1/chat/completions request. Leaving a value at its default
  // keeps current model behavior; nudging temperature / repetition_penalty
  // is the go-to fix for small / quantized models spiraling into repetition.
  temperature: number; // 0.0–2.0, default 0.7
  top_p: number; // 0.0–1.0, default 0.95
  repetition_penalty: number; // 1.0–1.5, default 1.1
  max_tokens: number | null; // null = unlimited, default null
  // [END]
}

interface ChatSettingsState extends ChatSettings {
  setDefaultStrategy: (strategy: CompactStrategy) => void;
  setGlobalWarnThreshold: (threshold: number) => void;
  setStreamingSendMode: (mode: StreamingSendMode) => void;
  setSoundEnabled: (enabled: boolean) => void;
  setTemperature: (v: number) => void;
  setTopP: (v: number) => void;
  setRepetitionPenalty: (v: number) => void;
  setMaxTokens: (v: number | null) => void;
  resetSampling: () => void;
  load: () => void;
}

const DEFAULTS: ChatSettings = {
  default_strategy: "auto",
  global_warn_threshold: 0.75,
  streaming_send_mode: "queue",
  sound_enabled: true,
  temperature: 0.7,
  top_p: 0.95,
  repetition_penalty: 1.1,
  max_tokens: null,
};

function snapshot(s: ChatSettingsState): ChatSettings {
  return {
    default_strategy: s.default_strategy,
    global_warn_threshold: s.global_warn_threshold,
    streaming_send_mode: s.streaming_send_mode,
    sound_enabled: s.sound_enabled,
    temperature: s.temperature,
    top_p: s.top_p,
    repetition_penalty: s.repetition_penalty,
    max_tokens: s.max_tokens,
  };
}

function persist(state: ChatSettings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — silent */
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const useChatSettingsStore = create<ChatSettingsState>((set, get) => {
  // Shared helper — every setter mutates its field then persists the full
  // snapshot so the stored blob stays complete.
  function persistCurrent() {
    persist(snapshot(get()));
  }

  return {
    ...DEFAULTS,

    load: () => {
      const stored = readStorage();
      const next: ChatSettings = {
        default_strategy: stored.default_strategy ?? DEFAULTS.default_strategy,
        global_warn_threshold:
          typeof stored.global_warn_threshold === "number"
            ? stored.global_warn_threshold
            : DEFAULTS.global_warn_threshold,
        streaming_send_mode:
          stored.streaming_send_mode ?? DEFAULTS.streaming_send_mode,
        sound_enabled:
          typeof stored.sound_enabled === "boolean"
            ? stored.sound_enabled
            : DEFAULTS.sound_enabled,
        temperature:
          typeof stored.temperature === "number"
            ? clamp(stored.temperature, 0, 2)
            : DEFAULTS.temperature,
        top_p:
          typeof stored.top_p === "number"
            ? clamp(stored.top_p, 0, 1)
            : DEFAULTS.top_p,
        repetition_penalty:
          typeof stored.repetition_penalty === "number"
            ? clamp(stored.repetition_penalty, 1, 2)
            : DEFAULTS.repetition_penalty,
        max_tokens:
          stored.max_tokens === null
            ? null
            : typeof stored.max_tokens === "number" && stored.max_tokens > 0
              ? Math.round(stored.max_tokens)
              : DEFAULTS.max_tokens,
      };
      set(next);
    },

    setDefaultStrategy: (strategy) => {
      set({ default_strategy: strategy });
      persistCurrent();
    },
    setGlobalWarnThreshold: (threshold) => {
      set({ global_warn_threshold: threshold });
      persistCurrent();
    },
    setStreamingSendMode: (mode) => {
      set({ streaming_send_mode: mode });
      persistCurrent();
    },
    setSoundEnabled: (enabled) => {
      set({ sound_enabled: enabled });
      persistCurrent();
    },
    setTemperature: (v) => {
      set({ temperature: clamp(v, 0, 2) });
      persistCurrent();
    },
    setTopP: (v) => {
      set({ top_p: clamp(v, 0, 1) });
      persistCurrent();
    },
    setRepetitionPenalty: (v) => {
      set({ repetition_penalty: clamp(v, 1, 2) });
      persistCurrent();
    },
    setMaxTokens: (v) => {
      set({ max_tokens: v === null ? null : Math.max(1, Math.round(v)) });
      persistCurrent();
    },
    resetSampling: () => {
      set({
        temperature: DEFAULTS.temperature,
        top_p: DEFAULTS.top_p,
        repetition_penalty: DEFAULTS.repetition_penalty,
        max_tokens: DEFAULTS.max_tokens,
      });
      persistCurrent();
    },
  };
});
// [END]
