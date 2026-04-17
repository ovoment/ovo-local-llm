import { useEffect } from "react";
import { useToastsStore, type Toast } from "../store/toasts";

// [START] Toast component — auto-dismissing notification stack.
// Renders in a fixed top-right stack; each item fades out after 3 s.
const AUTO_DISMISS_MS = 3000;

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToastsStore((s) => s.dismiss);

  useEffect(() => {
    const timer = setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, dismiss]);

  const bgClass =
    toast.kind === "success"
      ? "bg-emerald-600"
      : toast.kind === "error"
        ? "bg-rose-600"
        : "bg-[#2C1810]";

  return (
    <div
      className={`${bgClass} text-white text-[12px] px-4 py-2.5 rounded-lg shadow-lg max-w-xs leading-snug animate-fade-in`}
      role="status"
      aria-live="polite"
    >
      {toast.message}
    </div>
  );
}

export function ToastStack() {
  const toasts = useToastsStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
// [END]
