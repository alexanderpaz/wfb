import { dirname, type FileEntry, type ListResponse } from '@wfb/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { useExplorerPrefs } from '../../stores/explorerPrefs';
import { sortEntries } from '../explorer/sort';
import { listKey } from '../explorer/useFileOps';
import { PreviewModal } from './PreviewModal';

interface Opened {
  entry: FileEntry;
  share: string;
}

/** Starts a browser download of a file without leaving the page. */
export function downloadFile(entry: FileEntry, share: string): void {
  const a = document.createElement('a');
  a.href = api.downloadUrl({ share, path: entry.path });
  a.download = entry.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * State for the full-screen viewer. `open` is meant for `Explorer.onOpenFile`: previewable files open
 * in the modal (siblings come from the explorer's cached folder listing), others are downloaded.
 */
export function usePreviewModal(): { open: (entry: FileEntry, share: string) => void; modal: ReactNode } {
  const [opened, setOpened] = useState<Opened | null>(null);
  const queryClient = useQueryClient();
  const sortKey = useExplorerPrefs((s) => s.sortKey);
  const sortDir = useExplorerPrefs((s) => s.sortDir);

  const open = useCallback((entry: FileEntry, share: string) => {
    if (entry.type !== 'file') return;
    if (entry.previewable) setOpened({ entry, share });
    else downloadFile(entry, share);
  }, []);

  let modal: ReactNode = null;
  if (opened) {
    const listing = queryClient.getQueryData<ListResponse>(listKey(opened.share, dirname(opened.entry.path)));
    const siblings = listing
      ? sortEntries(listing.entries, sortKey, sortDir).filter((e) => e.type === 'file' && e.previewable)
      : [];
    modal = (
      <PreviewModal
        entry={opened.entry}
        share={opened.share}
        siblings={siblings}
        onNavigate={(entry) => setOpened({ entry, share: opened.share })}
        onClose={() => setOpened(null)}
      />
    );
  }
  return { open, modal };
}
