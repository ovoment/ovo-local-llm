import { useTranslation } from "react-i18next";
import { ImageIcon } from "lucide-react";

// [START] ImagePane — placeholder for upcoming image-generation feature
// (Phase 7+). When the sidecar gains an MLX diffusion runner the full
// settings panel (model, LoRA, control, strength, seed, size, steps,
// CFG, sampler, shift, batch, prompt/negative prompt) lands here.
// Policy already captured: this tab scopes to image-gen models only,
// and loading one unloads the currently active chat/code LLM to free
// unified memory.
export function ImagePane() {
  const { t } = useTranslation();
  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-xl mx-auto flex flex-col items-center gap-4 text-center">
        <ImageIcon className="w-10 h-10 text-ovo-muted" aria-hidden />
        <h2 className="text-lg font-semibold text-ovo-text">{t("image.title")}</h2>
        <p className="text-sm text-ovo-muted">{t("image.coming_soon")}</p>
      </div>
      <div className="max-w-xl mx-auto mt-8 p-4 rounded-xl border border-ovo-border bg-ovo-surface">
        <div className="text-xs uppercase tracking-wider text-ovo-muted mb-2">
          {t("image.policy_heading")}
        </div>
        <ul className="space-y-1.5 text-sm text-ovo-text">
          <li>• {t("image.policy.scope")}</li>
          <li>• {t("image.policy.unload")}</li>
          <li>• {t("image.policy.download")}</li>
          <li>• {t("image.policy.settings")}</li>
        </ul>
      </div>
    </div>
  );
}
// [END]
