import { create } from "zustand";

// [START] Toast store — lightweight in-memory queue for transient notifications.
// Consumers call push() to enqueue; Toast component auto-dismisses after 3 s.
export interface Toast {
  id: string;
  kind: "success" | "error" | "info";
  message: string;
}

interface ToastsState {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
}

export const useToastsStore = create<ToastsState>((set) => ({
  toasts: [],

  push: (toast) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { ...toast, id }] }));
    return id;
  },

  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));
// [END]
