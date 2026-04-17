import { useTranslation } from "react-i18next";
import { MessageSquare, Package, Settings, Info } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { RecentsPanel } from "./RecentsPanel";

export type NavKey = "chat" | "models" | "settings" | "about";

interface NavItem {
  key: NavKey;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

const NAV_ITEMS: NavItem[] = [
  { key: "chat", icon: MessageSquare },
  { key: "models", icon: Package },
  { key: "settings", icon: Settings },
  { key: "about", icon: Info },
];

interface SidebarProps {
  active: NavKey;
  onSelect: (key: NavKey) => void;
}

export function Sidebar({ active, onSelect }: SidebarProps) {
  const { t } = useTranslation();

  return (
    <nav className="w-56 bg-white/40 border-r border-[#E8CFBB] flex flex-col">
      <div className="px-5 py-4 border-b border-[#E8CFBB]">
        <div className="font-semibold text-[#2C1810] tracking-tight">{t("app.name")}</div>
        <div className="text-[11px] text-[#8B4432] mt-0.5">{t("app.tagline")}</div>
      </div>
      <ul className="py-2">
        {NAV_ITEMS.map(({ key, icon: Icon }) => {
          const isActive = key === active;
          return (
            <li key={key}>
              <button
                onClick={() => onSelect(key)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm transition ${
                  isActive
                    ? "bg-[#F4D4B8] text-[#2C1810] font-medium border-l-2 border-[#D97757]"
                    : "text-[#8B4432] hover:bg-[#F4D4B8]/50 border-l-2 border-transparent"
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
    </nav>
  );
}
