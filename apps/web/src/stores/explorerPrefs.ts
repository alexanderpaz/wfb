import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ViewMode = 'details' | 'icons' | 'list';
export type SortKey = 'name' | 'modifiedAt' | 'type' | 'size';
export type SortDir = 'asc' | 'desc';

export const DEFAULT_COLUMNS: Record<SortKey, number> = { name: 320, modifiedAt: 170, type: 190, size: 100 };

interface ExplorerPrefs {
  view: ViewMode;
  sortKey: SortKey;
  sortDir: SortDir;
  showDetails: boolean;
  showNav: boolean;
  columns: Record<SortKey, number>;
  setView: (view: ViewMode) => void;
  setSort: (key: SortKey, dir?: SortDir) => void;
  setShowDetails: (v: boolean) => void;
  setShowNav: (v: boolean) => void;
  setColumnWidth: (key: SortKey, width: number) => void;
  reset: () => void;
}

const defaults = {
  view: 'details' as ViewMode,
  sortKey: 'name' as SortKey,
  sortDir: 'asc' as SortDir,
  showDetails: false,
  showNav: true,
  columns: DEFAULT_COLUMNS,
};

/** View preferences, persisted in localStorage. */
export const useExplorerPrefs = create<ExplorerPrefs>()(
  persist(
    (set, get) => ({
      ...defaults,
      setView: (view) => set({ view }),
      setSort: (key, dir) => {
        const s = get();
        set({ sortKey: key, sortDir: dir ?? (s.sortKey === key && s.sortDir === 'asc' ? 'desc' : 'asc') });
      },
      setShowDetails: (showDetails) => set({ showDetails }),
      setShowNav: (showNav) => set({ showNav }),
      setColumnWidth: (key, width) => set((s) => ({ columns: { ...s.columns, [key]: Math.max(60, width) } })),
      reset: () => set(defaults),
    }),
    {
      name: 'wfb.explorer.prefs',
      storage: createJSONStorage(() => localStorage),
      partialize: ({ view, sortKey, sortDir, showDetails, showNav, columns }) => ({
        view,
        sortKey,
        sortDir,
        showDetails,
        showNav,
        columns,
      }),
    },
  ),
);
