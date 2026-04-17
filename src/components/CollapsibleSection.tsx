import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

// [START] Phase 6.4 — Collapsible section wrapper used across SettingsPane.
// Persists open/closed state per `id` under ovo:settings_open:<id> so the
// panel remembers which categories the user left expanded between app
// launches.

interface Props {
  id: string;
  title: string;
  defaultOpen?: boolean;
  right?: ReactNode; // optional element rendered on the header right side
  children: ReactNode;
}

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(`ovo:settings_open:${id}`);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function writeOpen(id: string, v: boolean): void {
  try {
    localStorage.setItem(`ovo:settings_open:${id}`, v ? "true" : "false");
  } catch {
    /* storage unavailable — silent */
  }
}

export function CollapsibleSection({
  id,
  title,
  defaultOpen = false,
  right,
  children,
}: Props) {
  const [open, setOpen] = useState<boolean>(() => readOpen(id, defaultOpen));

  useEffect(() => {
    writeOpen(id, open);
  }, [id, open]);

  return (
    <section className="py-3 border-b border-ovo-border">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex items-center gap-2 flex-1 text-left group"
        >
          <ChevronDown
            className={`w-4 h-4 text-ovo-muted group-hover:text-ovo-text transition-transform duration-200 ${
              open ? "" : "-rotate-90"
            }`}
            aria-hidden
          />
          <h3 className="text-sm font-semibold text-ovo-text group-hover:text-ovo-accent transition">
            {title}
          </h3>
        </button>
        {right && <div className="flex-shrink-0">{right}</div>}
      </div>
      {open && <div className="mt-4 pl-6">{children}</div>}
    </section>
  );
}
// [END]
