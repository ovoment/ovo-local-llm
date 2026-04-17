import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Owl } from "../components/Owl";
import { getAppInfo, type AppInfo } from "../lib/tauri";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function AboutPane() {
  const { t } = useTranslation();
  const [grabbed, setGrabbed] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    void getAppInfo()
      .then(setAppInfo)
      .catch(() => setAppInfo(null));
  }, []);

  const effectiveState = grabbed ? "struggling" : "idle";

  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 p-8">
      <div className="text-center flex flex-col items-center">
        <button
          onMouseDown={() => setGrabbed(true)}
          onMouseUp={() => setGrabbed(false)}
          onMouseLeave={() => setGrabbed(false)}
          onTouchStart={() => setGrabbed(true)}
          onTouchEnd={() => setGrabbed(false)}
          className="cursor-grab active:cursor-grabbing select-none bg-transparent border-0 p-0"
          title="🦉"
        >
          <Owl state={effectiveState} size="lg" />
        </button>
        <h1 className="text-4xl font-semibold tracking-tight mt-4">{t("app.name")}</h1>
        <p className="mt-1 text-ovo-muted">{t("app.tagline")}</p>
        {appInfo && (
          <p className="mt-1 text-xs text-ovo-accent font-mono">v{appInfo.version}</p>
        )}
        {/* [START] Author credit — OVOmet 팀의 ben */}
        <p className="mt-3 text-xs text-ovo-muted">
          Made by <span className="font-medium text-ovo-text">ben</span> @ OVOmet
        </p>
        <a
          href="mailto:ben@ovoment.com"
          className="mt-0.5 text-xs font-mono text-ovo-muted hover:text-ovo-accent transition-colors"
        >
          ben@ovoment.com
        </a>
        {/* [END] */}
      </div>

    </div>
  );
}
