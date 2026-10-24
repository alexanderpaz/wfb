import { create } from 'zustand';

export type TransferKind = 'copy' | 'move' | 'upload';
export type TransferStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface TransferFailure {
  name: string;
  error: string;
}

/** One entry of the progress panel: a background copy/move job or a chunked upload. */
export interface TransferTask {
  id: string;
  kind: TransferKind;
  /** "Copiando 12 elementos de Ingeniería a Finanzas" */
  title: string;
  status: TransferStatus;
  totalBytes: number;
  doneBytes: number;
  totalItems: number;
  doneItems: number;
  currentItem: string | null;
  failures: TransferFailure[];
  error: string | null;
  /** True while a cancellation request is in flight. */
  cancelling: boolean;
}

interface TransfersState {
  tasks: TransferTask[];
  collapsed: boolean;
  add: (task: Omit<TransferTask, 'failures' | 'error' | 'cancelling'> & Partial<TransferTask>) => void;
  update: (id: string, patch: Partial<TransferTask>) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
  setCollapsed: (collapsed: boolean) => void;
}

export const useTransfers = create<TransfersState>((set) => ({
  tasks: [],
  collapsed: false,
  add: (task) =>
    set((s) => ({
      collapsed: false,
      tasks: [
        ...s.tasks.filter((t) => t.id !== task.id),
        { failures: [], error: null, cancelling: false, ...task },
      ],
    })),
  update: (id, patch) => set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  remove: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
  clearFinished: () => set((s) => ({ tasks: s.tasks.filter((t) => t.status === 'running') })),
  setCollapsed: (collapsed) => set({ collapsed }),
}));

/** Cancel callbacks live outside the store so state stays serialisable. */
const cancellers = new Map<string, () => void | Promise<void>>();

export const transferCancel = {
  set: (id: string, fn: () => void | Promise<void>) => cancellers.set(id, fn),
  delete: (id: string) => cancellers.delete(id),
  run: (id: string) => cancellers.get(id)?.(),
  clear: () => cancellers.clear(),
};
