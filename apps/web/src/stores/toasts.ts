import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'error' | 'busy';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>, timeoutMs?: number) => number;
  update: (id: number, toast: Partial<Omit<Toast, 'id'>>, timeoutMs?: number) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;
const DEFAULT_TIMEOUT = 6000;

export const useToasts = create<ToastState>((set, get) => {
  const schedule = (id: number, kind: ToastKind, timeoutMs?: number) => {
    const ms = timeoutMs ?? (kind === 'busy' ? 0 : DEFAULT_TIMEOUT);
    if (ms > 0) setTimeout(() => get().dismiss(id), ms);
  };
  return {
    toasts: [],
    push: (toast, timeoutMs) => {
      const id = nextId++;
      set((s) => ({ toasts: [...s.toasts, { ...toast, id }].slice(-5) }));
      schedule(id, toast.kind, timeoutMs);
      return id;
    },
    update: (id, patch, timeoutMs) => {
      set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
      if (patch.kind) schedule(id, patch.kind, timeoutMs);
    },
    dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});

export const toast = {
  info: (title: string, message?: string) => useToasts.getState().push({ kind: 'info', title, message }),
  success: (title: string, message?: string) =>
    useToasts.getState().push({ kind: 'success', title, message }),
  error: (title: string, message?: string) => useToasts.getState().push({ kind: 'error', title, message }),
  busy: (title: string, message?: string) => useToasts.getState().push({ kind: 'busy', title, message }),
};
