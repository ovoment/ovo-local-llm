import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar, type NavKey } from "./Sidebar";
import { ToastStack } from "./Toast";
import { SidecarTransitionModal } from "./SidecarTransitionModal";
import { SidecarBootstrapModal } from "./SidecarBootstrapModal";
import { ModelSwapToast } from "./ModelSwapToast";
import { ChatPane } from "../panes/ChatPane";
import { CodePane } from "../panes/CodePane";
import { ImagePane } from "../panes/ImagePane";
import { WikiPane } from "../panes/WikiPane";
import { ModelsPane } from "../panes/ModelsPane";
import { FitPane } from "../panes/FitPane";
import { FinetunePane } from "../panes/FinetunePane";
import { BlendingPane } from "../panes/BlendingPane";
import { PingpongPane } from "../panes/PingpongPane";
import { SettingsPane } from "../panes/SettingsPane";
import { AboutPane } from "../panes/AboutPane";
import { useSidecarStore } from "../store/sidecar";
import { useChatSettingsStore } from "../store/chat_settings";
import { useModelOverridesStore } from "../store/model_overrides";
import { useChatStore } from "../store/chat";
import { useCodeAgentStore } from "../store/code_agent";
import { usePetStore } from "../store/pet";
// [START] theme bootstrap
import { useThemeStore } from "../store/theme";
// [END]
// [START] model_perf bootstrap
import { useModelPerfStore } from "../store/model_perf";
// [END]
// [START] Phase A — attachment GC on startup
import { garbageCollectAttachments } from "../lib/attachmentStorage";
import { getDb } from "../db/index";
import type { ChatAttachment } from "../types/ovo";
// [END]
// [START] Phase 6.1 — project context bootstrap
import { useProjectContextStore } from "../store/project_context";
// [END]
// [START] Phase 6.2b — MCP store bootstrap
import { useMcpStore } from "../store/mcp";
// [END]
// [START] Phase 6.2c — tool-call approval mode bootstrap
import { useToolModeStore } from "../store/tool_mode";
// [END]
// [START] Phase 6.4 — model profiles bootstrap
import { useModelProfilesStore } from "../store/model_profiles";
// [END]
// [START] Phase 8 — feature flags bootstrap
import { useFeatureFlagsStore } from "../store/feature_flags";
// [END]
// [START] KB store bootstrap
import { useKBStore } from "../store/knowledge_base";
// [END]
// [START] Phase 6.4 — skills bootstrap + project-path subscription
import { useSkillsStore } from "../store/skills";
// [END]

export function AppShell() {
  const [active, setActive] = useState<NavKey>("chat");
  const subscribe = useSidecarStore((s) => s.subscribe);
  const unsubscribe = useSidecarStore((s) => s.unsubscribe);
  // [START] Phase 8 — owl state multiplex.
  // The pet window listens to a single "owl:state" stream, but the chat
  // store and the code-agent store each drive their own owl. Active tab
  // decides which source is authoritative so switching to Code doesn't
  // leave the owl stuck on the previous chat's "happy" frame, and the
  // code agent's thinking/typing transitions actually reach the pet.
  const chatOwlState = useChatStore((s) => s.owlState);
  const agentOwlState = useCodeAgentStore((s) => s.owlState);
  const owlState = active === "code" ? agentOwlState : chatOwlState;
  // [END]
  const petEnabled = usePetStore((s) => s.pet_enabled);

  // [START] Bootstrap global settings stores once on mount (R.6)
  useEffect(() => {
    // [START] Phase 8 — load feature flags first so gates apply during boot
    useFeatureFlagsStore.getState().load();
    // [END]
    useChatSettingsStore.getState().load();
    void useModelOverridesStore.getState().load();
    // [START] theme bootstrap — apply persisted theme class to <html> before first paint
    useThemeStore.getState().load();
    // [END]
    // [START] model_perf bootstrap — hydrate perf stats from localStorage
    useModelPerfStore.getState().load();
    // [END]
    // [START] Phase 6.1 — project context bootstrap: hydrate then rescan on startup
    useProjectContextStore.getState().load();
    if (useProjectContextStore.getState().project_path) {
      void useProjectContextStore.getState().rescan();
    }
    // [END]
    // [START] Phase 6.2b — MCP store bootstrap: hydrate configs from localStorage
    useMcpStore.getState().load();
    // [END]
    // [START] Phase 6.2c — tool-call approval mode bootstrap
    useToolModeStore.getState().load();
    // [END]
    // [START] Phase 6.4 — model profiles bootstrap
    useModelProfilesStore.getState().load();
    // [END]
    // [START] KB store bootstrap
    useKBStore.getState().load();
    // [END]
    // [START] Phase 6.4 — skills bootstrap: hydrate + rescan once the project
    // context store has finished resolving its default path. We run load() up
    // front (hydrates localStorage only) then subscribe to project_context for
    // rescan on folder change. The initial rescan happens after project_context
    // resolves its home-dir fallback, via the subscribe hook below.
    useSkillsStore.getState().load();
    // [START] Phase 8 — Code sessions bootstrap
    import("../store/code_sessions").then((m) => m.useCodeSessionsStore.getState().load()).catch(() => {});
    // [END]
    const unsubscribeProjectPath = useProjectContextStore.subscribe((state, prev) => {
      if (state.project_path !== prev.project_path) {
        void useSkillsStore.getState().rescan();
        // [START] Phase 8 — personas live under .ovo/personas/, follow project switches
        void useModelProfilesStore.getState().rescan();
        // [END]
      }
    });
    // [END]
    // [START] Phase 6.4 — slash command /wiki /models /settings nav listener
    const onNav = (e: Event) => {
      const target = (e as CustomEvent<NavKey>).detail;
      if (typeof target === "string") setActive(target);
    };
    window.addEventListener("ovo:navigate", onNav);
    // [END]
    return () => {
      window.removeEventListener("ovo:navigate", onNav);
      unsubscribeProjectPath();
    };
  }, []);
  // [END]

  // [START] Phase A — Garbage collect orphan attachment files on startup.
  // Runs after DB migrations complete (tauri-plugin-sql auto-migrates before
  // any JS query). Collects all stored-kind relativePaths from DB, then
  // removes any files on disk that no longer have a DB reference.
  useEffect(() => {
    async function runGc(): Promise<void> {
      try {
        const db = await getDb();
        const rows = await db.select<{ attachments_json: string | null }[]>(
          `SELECT attachments_json FROM messages WHERE attachments_json IS NOT NULL`,
        );
        const referencedPaths = new Set<string>();
        for (const row of rows) {
          if (!row.attachments_json) continue;
          try {
            const parsed: unknown = JSON.parse(row.attachments_json);
            if (!Array.isArray(parsed)) continue;
            for (const a of parsed as ChatAttachment[]) {
              if (a.kind === "stored") referencedPaths.add(a.meta.relativePath);
            }
          } catch {
            // malformed json — skip
          }
        }
        await garbageCollectAttachments(referencedPaths);
      } catch {
        // GC is best-effort — never block startup
      }
    }
    void runGc();
  }, []);
  // [END]

  // [START] Phase 7 — show pet window on startup if pet_enabled was persisted
  useEffect(() => {
    if (petEnabled) {
      void invoke("pet_show").catch(() => { /* pet window may not be ready yet */ });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // [END]

  // [START] Phase 7 — emit owl state to pet window via Tauri event bus
  useEffect(() => {
    void emit("owl:state", { state: owlState }).catch(() => { /* ignore if no listeners */ });
  }, [owlState]);
  // [END]

  // [START] Phase 7 — listen for pet:disabled (emitted when user picks "펫 숨기기"
  // from the pet window's context menu) and flip the Settings toggle in sync.
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen("pet:disabled", () => {
      void usePetStore.getState().setPetEnabled(false);
    }).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, []);
  // [END]

  useEffect(() => {
    let autostartTimer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      await subscribe();
      // [START] auto-start fallback — if the native spawn didn't transition
      // past "stopped" within 2s (bundle path missing, port conflict, etc.),
      // kick a restart from the frontend so the user sees the sidecar come up
      // without needing to touch the 💾 button. Skip when the sidecar is
      // mid-install ("bootstrapping") so we don't interrupt `uv sync`.
      autostartTimer = setTimeout(() => {
        const s = useSidecarStore.getState().status;
        if (s.health === "stopped") {
          void useSidecarStore.getState().restart();
        }
      }, 2000);
      // [END]
    })();
    return () => {
      if (autostartTimer) clearTimeout(autostartTimer);
      unsubscribe();
    };
  }, [subscribe, unsubscribe]);

  return (
    <div className="h-screen flex bg-ovo-bg text-ovo-text">
      <ToastStack />
      <SidecarBootstrapModal />
      <SidecarTransitionModal />
      <ModelSwapToast />
      <Sidebar active={active} onSelect={setActive} />
      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-hidden">
          {active === "chat" && <ChatPane />}
          {active === "code" && <CodePane />}
          {active === "image" && <ImagePane />}
          {active === "wiki" && <WikiPane />}
          {active === "finetune" && <FinetunePane />}
          {active === "blending" && <BlendingPane />}
          {active === "pingpong" && <PingpongPane />}
          {active === "models" && <ModelsPane />}
          {active === "fit" && <FitPane />}
          {active === "settings" && <SettingsPane />}
          {active === "about" && <AboutPane />}
        </div>
      </main>
    </div>
  );
}
