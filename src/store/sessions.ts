import { create } from "zustand";
import type { CompactStrategy, Message, Session } from "../types/ovo";
import {
  appendMessage as dbAppendMessage,
  clearMessages as dbClearMessages,
  createSession as dbCreateSession,
  deleteSession as dbDeleteSession,
  listLiveMessages as dbListLiveMessages,
  listSessions as dbListSessions,
  renameSession as dbRenameSession,
  searchSessions as dbSearchSessions,
  setCompactStrategy as dbSetCompactStrategy,
  setCompacting as dbSetCompacting,
  setContextTokens as dbSetContextTokens,
  setModelRef as dbSetModelRef,
  setPinned as dbSetPinned,
  markMessagesCompacted as dbMarkCompacted,
  type AppendMessageInput,
  type CreateSessionInput,
} from "../db/sessions";

// [START] Sessions store — single source of truth for the session list and
// which session is active. ChatPane subscribes to `currentSessionId` +
// `messages` and re-renders when either changes. All mutators write to the
// SQLite-backed db layer first, then reconcile in-memory state.
interface SessionsState {
  sessions: Session[];
  currentSessionId: string | null;
  messages: Message[];
  loading: boolean;
  searchQuery: string;

  loadSessions: () => Promise<void>;
  selectSession: (id: string | null) => Promise<void>;
  loadMessages: (sessionId: string) => Promise<void>;
  createSession: (input?: CreateSessionInput) => Promise<Session>;
  renameSession: (id: string, title: string) => Promise<void>;
  togglePinned: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  escapeToNewSession: () => Promise<Session | null>;
  clearCurrentMessages: () => Promise<void>;
  setCompactStrategy: (id: string, strategy: CompactStrategy) => Promise<void>;
  setSessionModel: (id: string, modelRef: string | null) => Promise<void>;
  setSessionContextTokens: (id: string, tokens: number) => Promise<void>;
  setSessionCompacting: (id: string, compacting: boolean) => Promise<void>;

  appendMessage: (input: AppendMessageInput) => Promise<Message>;
  patchMessage: (id: string, content: string) => void;
  markMessagesCompacted: (ids: string[]) => Promise<void>;

  setSearchQuery: (q: string) => Promise<void>;
}
// [END]

function replaceOrAppend(list: Session[], next: Session): Session[] {
  const idx = list.findIndex((s) => s.id === next.id);
  if (idx === -1) return sortSessions([...list, next]);
  const copy = list.slice();
  copy[idx] = next;
  return sortSessions(copy);
}

function sortSessions(list: Session[]): Session[] {
  // match SQL ORDER BY pinned DESC, updated_at DESC
  return list.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updated_at - a.updated_at;
  });
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  messages: [],
  loading: false,
  searchQuery: "",

  loadSessions: async () => {
    set({ loading: true });
    try {
      const sessions = await dbListSessions();
      set({ sessions, loading: false });
    } catch (e) {
      console.error("loadSessions failed", e);
      set({ loading: false });
    }
  },

  selectSession: async (id) => {
    if (id === get().currentSessionId) return;
    set({ currentSessionId: id, messages: [] });
    if (id) await get().loadMessages(id);
  },

  loadMessages: async (sessionId) => {
    const messages = await dbListLiveMessages(sessionId);
    if (get().currentSessionId !== sessionId) return;
    set({ messages });
  },

  createSession: async (input) => {
    const session = await dbCreateSession(input);
    set((s) => ({
      sessions: replaceOrAppend(s.sessions, session),
      currentSessionId: session.id,
      messages: [],
    }));
    return session;
  },

  renameSession: async (id, title) => {
    await dbRenameSession(id, title);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, title, updated_at: Date.now() } : x,
      ),
    }));
  },

  togglePinned: async (id) => {
    const sess = get().sessions.find((s) => s.id === id);
    if (!sess) return;
    const pinned = !sess.pinned;
    await dbSetPinned(id, pinned);
    set((s) => ({
      sessions: sortSessions(
        s.sessions.map((x) =>
          x.id === id ? { ...x, pinned, updated_at: Date.now() } : x,
        ),
      ),
    }));
  },

  deleteSession: async (id) => {
    await dbDeleteSession(id);
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id);
      const wasCurrent = s.currentSessionId === id;
      return {
        sessions,
        currentSessionId: wasCurrent ? null : s.currentSessionId,
        messages: wasCurrent ? [] : s.messages,
      };
    });
  },

  escapeToNewSession: async () => {
    const current = get().sessions.find((s) => s.id === get().currentSessionId);
    if (!current) return null;
    return await get().createSession({
      model_ref: current.model_ref,
      system_prompt: current.system_prompt,
      compact_strategy: current.compact_strategy,
    });
  },

  clearCurrentMessages: async () => {
    const id = get().currentSessionId;
    if (!id) return;
    await dbClearMessages(id);
    set((s) => ({
      messages: [],
      sessions: s.sessions.map((x) =>
        x.id === id
          ? { ...x, context_tokens: 0, updated_at: Date.now() }
          : x,
      ),
    }));
  },

  setCompactStrategy: async (id, strategy) => {
    await dbSetCompactStrategy(id, strategy);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, compact_strategy: strategy } : x,
      ),
    }));
  },

  setSessionModel: async (id, modelRef) => {
    await dbSetModelRef(id, modelRef);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, model_ref: modelRef } : x,
      ),
    }));
  },

  setSessionContextTokens: async (id, tokens) => {
    await dbSetContextTokens(id, tokens);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, context_tokens: tokens } : x,
      ),
    }));
  },

  setSessionCompacting: async (id, compacting) => {
    await dbSetCompacting(id, compacting);
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, compacting } : x,
      ),
    }));
  },

  appendMessage: async (input) => {
    const msg = await dbAppendMessage(input);
    if (get().currentSessionId === input.session_id) {
      set((s) => ({ messages: [...s.messages, msg] }));
    }
    // bump session updated_at in memory too
    set((s) => ({
      sessions: sortSessions(
        s.sessions.map((x) =>
          x.id === input.session_id ? { ...x, updated_at: msg.created_at } : x,
        ),
      ),
    }));
    return msg;
  },

  patchMessage: (id, content) => {
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, content } : m)),
    }));
  },

  markMessagesCompacted: async (ids) => {
    await dbMarkCompacted(ids);
    set((s) => ({
      messages: s.messages.filter((m) => !ids.includes(m.id)),
    }));
  },

  setSearchQuery: async (q) => {
    set({ searchQuery: q });
    const sessions = q.trim() ? await dbSearchSessions(q) : await dbListSessions();
    set({ sessions });
  },
}));
