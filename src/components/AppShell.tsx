import { useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar, type NavKey } from "./Sidebar";
import { ToastStack } from "./Toast";
import { ChatPane } from "../panes/ChatPane";
import { CodePane } from "../panes/CodePane";
import { ImagePane } from "../panes/ImagePane";
import { WikiPane } from "../panes/WikiPane";
import { ModelsPane } from "../panes/ModelsPane";
import { SettingsPane } from "../panes/SettingsPane";
import { AboutPane } from "../panes/AboutPane";
import { useSidecarStore } from "../store/sidecar";
import { useChatSettingsStore } from "../store/chat_settings";
import { useModelOverridesStore } from "../store/model_overrides";
import { useChatStore } from "../store/chat";
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

export function AppShell() {
  const [active, setActive] = useState<NavKey>("chat");
  const subscribe = useSidecarStore((s) => s.subscribe);
  const unsubscribe = useSidecarStore((s) => s.unsubscribe);
  const owlState = useChatStore((s) => s.owlState);
  const petEnabled = usePetStore((s) => s.pet_enabled);

  // [START] Bootstrap global settings stores once on mount (R.6)
  useEffect(() => {
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
      // without needing to touch the 💾 button.
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
      <Sidebar active={active} onSelect={setActive} />
      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-hidden">
          {active === "chat" && <ChatPane />}
          {active === "code" && <CodePane />}
          {active === "image" && <ImagePane />}
          {active === "wiki" && <WikiPane />}
          {active === "models" && <ModelsPane />}
          {active === "settings" && <SettingsPane />}
          {active === "about" && <AboutPane />}
        </div>
      </main>
    </div>
  );
}
