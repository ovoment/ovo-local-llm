import { useTranslation } from "react-i18next";
import { ImageIcon } from "lucide-react";

// [START] ImagePane — placeholder for upcoming image-generation feature
// (Phase 7+). Will mount MLX diffusion models (SDXL / Flux) once the sidecar
// exposes `/ovo/images` and a matching runner is implemented.
export function ImagePane() {
  const { t } = useTranslation();
  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center">
      <ImageIcon className="w-10 h-10 text-ovo-muted" aria-hidden />
      <h2 className="text-lg font-semibold text-ovo-text">{t("image.title")}</h2>
      <p className="text-sm text-ovo-muted max-w-md">{t("image.coming_soon")}</p>
    </div>
  );
}
// [END]
