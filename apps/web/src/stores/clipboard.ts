import type { FileRef } from '@wfb/contracts';
import { create } from 'zustand';

export type ClipboardMode = 'copy' | 'cut';

interface ClipboardState {
  mode: ClipboardMode;
  items: FileRef[];
  set: (mode: ClipboardMode, items: FileRef[]) => void;
  clear: () => void;
}

export const useClipboard = create<ClipboardState>((set) => ({
  mode: 'copy',
  items: [],
  set: (mode, items) => set({ mode, items }),
  clear: () => set({ mode: 'copy', items: [] }),
}));

export const isCut = (state: Pick<ClipboardState, 'mode' | 'items'>, ref: FileRef) =>
  state.mode === 'cut' && state.items.some((i) => i.share === ref.share && i.path === ref.path);
