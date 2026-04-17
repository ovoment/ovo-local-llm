import { useTranslation } from "react-i18next";
import { Code2 } from "lucide-react";

// [START] CodePane — placeholder for upcoming IDE-mode work (Phase 6.3+).
// Landing page describes the vision; actual editor/REPL comes later.
export function CodePane() {
  const { t } = useTranslation();
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
      <Code2 className="w-10 h-10 text-ovo-muted" aria-hidden />
      <h2 className="text-lg font-semibold text-ovo-text">{t("code.title")}</h2>
      <p className="text-sm text-ovo-muted max-w-md">{t("code.coming_soon")}</p>
    </div>
  );
}
// [END]
