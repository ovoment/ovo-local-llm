import { useTranslation } from "react-i18next";
import { MessageSquare, Code2, Image as ImageIcon, Package, Settings, Info } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { RecentsPanel } from "./RecentsPanel";
import { useThemeStore } from "../store/theme";

export type NavKey = "chat" | "code" | "image" | "models" | "settings" | "about";

interface NavItem {
  key: NavKey;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const NAV_ITEMS: NavItem[] = [
  { key: "chat", icon: MessageSquare },
  { key: "code", icon: Code2 },
  { key: "image", icon: ImageIcon },
];

// [START] Secondary bottom-dock items — models/settings/info rendered as
// small icon-only buttons at the bottom center of the sidebar (no labels).
const BOTTOM_ITEMS: NavItem[] = [
  { key: "models", icon: Package },
  { key: "settings", icon: Settings },
  { key: "about", icon: Info },
];
// [END]

interface SidebarProps {
  active: NavKey;
  onSelect: (key: NavKey) => void;
}

export function Sidebar({ active, onSelect }: SidebarProps) {
  const { t } = useTranslation();
  const effectiveTheme = useThemeStore((s) => s.effective);
  // [START] Two logo assets with identical 238×88 dimensions (dark variant
  // generated from the black source so position stays pixel-perfect).
  const logoSrc =
    effectiveTheme === "dark" ? "/ovo-logo-dark.png?v=4" : "/ovo-logo.png?v=4";
  // [END]

  return (
    <nav className="w-56 bg-ovo-surface border-r border-ovo-border flex flex-col">
      {/* [START] Reserve space for macOS traffic-light buttons + expose the
          header as a drag region so the user can move the window by grabbing
          the OVO logo area (data-tauri-drag-region is honored by Tauri). */}
      <div
        data-tauri-drag-region
        className="px-5 pt-16 pb-4 border-b border-ovo-border"
      >
        <img
          src={logoSrc}
          alt={t("app.name")}
          data-tauri-drag-region
          className="h-8 w-auto object-contain object-left select-none pointer-events-none"
          draggable={false}
        />
        <div
          data-tauri-drag-region
          className="text-[11px] text-ovo-muted mt-2"
        >
          {t("app.tagline")}
        </div>
      </div>
      {/* [END] */}
      <ul className="py-2">
        {NAV_ITEMS.map(({ key, icon: Icon }) => {
          const isActive = key === active;
          return (
            <li key={key}>
              <button
                onClick={() => onSelect(key)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm transition ${
                  isActive
                    ? "bg-ovo-nav-active text-ovo-text font-medium border-l-2 border-ovo-accent"
                    : "text-ovo-muted hover:bg-ovo-nav-active-hover border-l-2 border-transparent"
                }`}
              >
                <Icon className="w-4 h-4" aria-hidden />
                <span>{t(`nav.${key}`)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {/* [START] Recents panel — only visible when chat tab is active */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {active === "chat" && <RecentsPanel />}
      </div>
      {/* [END] */}

      {/* [START] Bottom dock — settings + info as small centered icon buttons */}
      <div className="flex items-center justify-center gap-4 py-3 border-t border-ovo-border">
        {BOTTOM_ITEMS.map(({ key, icon: Icon }) => {
          const isActive = key === active;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onSelect(key)}
              title={t(`nav.${key}`)}
              aria-label={t(`nav.${key}`)}
              className={`p-1.5 rounded-md transition ${
                isActive
                  ? "text-ovo-accent bg-ovo-nav-active"
                  : "text-ovo-muted hover:bg-ovo-nav-active-hover hover:text-ovo-text"
              }`}
            >
              <Icon className="w-4 h-4" aria-hidden />
            </button>
          );
        })}
      </div>
      {/* [END] */}
    </nav>
  );
}
