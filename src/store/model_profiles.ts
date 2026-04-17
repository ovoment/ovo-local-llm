import { create } from "zustand";

// [START] Phase 6.4 — Model profiles.
// A profile = named preset of (persona + user honorific + sampling overrides +
// optional system prompt extras + optional default model). Active profile is
// applied on every chat send: persona & honorific get injected into the
// system prompt, sampling values override chat_settings for that turn.
//
// Built-in defaults cover common use cases (research / code / speed /
// casual / creative); the user can add custom profiles via the Settings UI
// (follow-up UI lands in the same Phase 6.4).

export interface ProfileSampling {
  temperature?: number;
  top_p?: number;
  repetition_penalty?: number;
  max_tokens?: number | null;
}

export interface ModelProfile {
  id: string;
  name: string; // user-visible, e.g. "연구"
  emoji?: string; // one-char hint for quick visual scan
  persona?: string; // injected as a prefix line in the system prompt
  user_honorific?: string; // how the assistant should address the user
  model_ref?: string | null; // optional default model for this profile
  sampling?: ProfileSampling;
  system_prompt_extra?: string; // free-form additional instructions
  builtin?: boolean; // read-only flag for built-ins
}

const LS_KEY = "ovo:model_profiles";
const LS_ACTIVE = "ovo:model_profile_active";

const BUILTIN_PROFILES: ModelProfile[] = [
  {
    id: "default",
    name: "자유 대화",
    emoji: "💬",
    builtin: true,
  },
  {
    id: "research",
    name: "연구",
    emoji: "🔬",
    persona:
      "너는 정확성과 근거를 최우선으로 하는 연구 어시스턴트야. 주장에는 가능한 출처를 덧붙이고, 불확실한 부분은 명시적으로 표기해.",
    sampling: { temperature: 0.3, top_p: 0.9, repetition_penalty: 1.1 },
    builtin: true,
  },
  {
    id: "code",
    name: "코드",
    emoji: "💻",
    persona:
      "너는 시니어 소프트웨어 엔지니어야. 코드는 간결하고 안전하게, 엣지 케이스를 먼저 고려하고, 주석은 WHY에만 달아. 불필요한 설명 생략.",
    sampling: { temperature: 0.2, top_p: 0.9, repetition_penalty: 1.1, max_tokens: 4096 },
    builtin: true,
  },
  {
    id: "speed",
    name: "속도",
    emoji: "⚡",
    persona: "짧고 핵심만 말해. 불필요한 서론/결론 생략.",
    sampling: { temperature: 0.7, top_p: 0.95, repetition_penalty: 1.05, max_tokens: 512 },
    builtin: true,
  },
  {
    id: "creative",
    name: "창작",
    emoji: "✍️",
    persona: "너는 창의적인 작가야. 생생한 묘사, 다양한 어휘, 예상 밖의 전개를 시도해.",
    sampling: { temperature: 1.0, top_p: 0.95, repetition_penalty: 1.1 },
    builtin: true,
  },
];

interface ModelProfilesState {
  profiles: ModelProfile[];
  activeId: string;
  setActive: (id: string) => void;
  upsert: (p: ModelProfile) => void;
  remove: (id: string) => void;
  reset: () => void; // restore built-ins only
  load: () => void;
  getActive: () => ModelProfile | null;
}

function readStorage(): ModelProfile[] | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    // Minimal shape check — keep known fields only
    return parsed
      .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => ({
        id: String(p.id ?? ""),
        name: String(p.name ?? ""),
        emoji: typeof p.emoji === "string" ? p.emoji : undefined,
        persona: typeof p.persona === "string" ? p.persona : undefined,
        user_honorific:
          typeof p.user_honorific === "string" ? p.user_honorific : undefined,
        model_ref:
          typeof p.model_ref === "string"
            ? p.model_ref
            : p.model_ref === null
              ? null
              : undefined,
        sampling:
          p.sampling && typeof p.sampling === "object"
            ? (p.sampling as ProfileSampling)
            : undefined,
        system_prompt_extra:
          typeof p.system_prompt_extra === "string"
            ? p.system_prompt_extra
            : undefined,
        builtin: p.builtin === true,
      }))
      .filter((p) => p.id.length > 0 && p.name.length > 0);
  } catch {
    return null;
  }
}

function writeStorage(profiles: ModelProfile[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(profiles));
  } catch {
    /* storage unavailable — silent */
  }
}

function readActive(): string {
  try {
    return localStorage.getItem(LS_ACTIVE) || "default";
  } catch {
    return "default";
  }
}

function writeActive(id: string): void {
  try {
    localStorage.setItem(LS_ACTIVE, id);
  } catch {
    /* ignore */
  }
}

function mergeWithBuiltins(stored: ModelProfile[] | null): ModelProfile[] {
  // Built-ins always present; user's stored list may add custom + override
  // some built-in fields. For now: rehydrate built-ins fresh (so persona text
  // upgrades across releases propagate) and append any custom (non-builtin)
  // profiles the user added.
  const userProfiles = (stored ?? []).filter((p) => !p.builtin);
  return [...BUILTIN_PROFILES, ...userProfiles];
}

export const useModelProfilesStore = create<ModelProfilesState>((set, get) => ({
  profiles: BUILTIN_PROFILES,
  activeId: "default",

  load: () => {
    const stored = readStorage();
    const profiles = mergeWithBuiltins(stored);
    const active = readActive();
    set({
      profiles,
      activeId: profiles.some((p) => p.id === active) ? active : "default",
    });
  },

  setActive: (id) => {
    const profiles = get().profiles;
    if (!profiles.some((p) => p.id === id)) return;
    writeActive(id);
    set({ activeId: id });
  },

  upsert: (p) => {
    // Reject empty id / name
    if (!p.id || !p.name) return;
    set((s) => {
      const existing = s.profiles.findIndex((x) => x.id === p.id);
      let next: ModelProfile[];
      if (existing >= 0) {
        // Don't let edits clobber the builtin flag on an existing built-in
        const wasBuiltin = s.profiles[existing].builtin === true;
        next = [...s.profiles];
        next[existing] = { ...p, builtin: wasBuiltin };
      } else {
        next = [...s.profiles, { ...p, builtin: false }];
      }
      // Persist only user-authored (non-builtin) so built-in text upgrades
      // naturally propagate on next release.
      writeStorage(next.filter((x) => !x.builtin));
      return { profiles: next };
    });
  },

  remove: (id) => {
    const target = get().profiles.find((p) => p.id === id);
    if (!target || target.builtin) return; // built-ins undeletable
    set((s) => {
      const next = s.profiles.filter((p) => p.id !== id);
      writeStorage(next.filter((x) => !x.builtin));
      const newActive = s.activeId === id ? "default" : s.activeId;
      if (newActive !== s.activeId) writeActive(newActive);
      return { profiles: next, activeId: newActive };
    });
  },

  reset: () => {
    writeStorage([]);
    writeActive("default");
    set({ profiles: BUILTIN_PROFILES, activeId: "default" });
  },

  getActive: () => {
    const { profiles, activeId } = get();
    return profiles.find((p) => p.id === activeId) ?? null;
  },
}));
// [END]
