import { useEffect, useState } from "react";
import { Sidebar, type NavKey } from "./Sidebar";
import { SidecarIndicator } from "./SidecarIndicator";
import { ContextIndicator } from "./ContextIndicator";
import { ToastStack } from "./Toast";
import { ChatPane } from "../panes/ChatPane";
import { ModelsPane } from "../panes/ModelsPane";
import { SettingsPane } from "../panes/SettingsPane";
import { AboutPane } from "../panes/AboutPane";
import { useSidecarStore } from "../store/sidecar";
import { useChatSettingsStore } from "../store/chat_settings";
import { useModelOverridesStore } from "../store/model_overrides";

export function AppShell() {
  const [active, setActive] = useState<NavKey>("chat");
  const subscribe = useSidecarStore((s) => s.subscribe);
  const unsubscribe = useSidecarStore((s) => s.unsubscribe);

  // [START] Bootstrap global settings stores once on mount (R.6)
  useEffect(() => {
    useChatSettingsStore.getState().load();
    void useModelOverridesStore.getState().load();
  }, []);
  // [END]

  useEffect(() => {
    void subscribe();
    return () => unsubscribe();
  }, [subscribe, unsubscribe]);

  return (
    <div className="h-screen flex bg-[#FAF3E7] text-[#2C1810]">
      <ToastStack />
      <Sidebar active={active} onSelect={setActive} />
      <main className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-hidden">
          {active === "chat" && <ChatPane />}
          {active === "models" && <ModelsPane />}
          {active === "settings" && <SettingsPane />}
          {active === "about" && <AboutPane />}
        </div>
        <footer className="border-t border-[#E8CFBB] p-3 flex items-center gap-3">
          <SidecarIndicator />
          {/* [START] vertical divider + ContextIndicator (R.4) */}
          <div className="w-px self-stretch bg-[#E8CFBB]" aria-hidden="true" />
          <ContextIndicator />
          {/* [END] */}
        </footer>
      </main>
    </div>
  );
}
