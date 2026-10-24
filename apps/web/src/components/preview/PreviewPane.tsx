import type { FileEntry } from '@wfb/contracts';
import { fileKind } from '../explorer/fileTypes';
import { FileIcon } from '../explorer/icons';
import { PreviewBody } from './PreviewBody';
import { PreviewMessage } from './PreviewMessage';
import './preview.css';

export interface PreviewPaneProps {
  entry: FileEntry;
  share: string;
}

/** Compact preview for the explorer details pane (`Explorer.renderPreview`). */
export function PreviewPane({ entry, share }: PreviewPaneProps) {
  return (
    <div className="wfb-pv-pane" data-testid="preview-pane">
      {entry.type === 'file' && entry.previewable ? (
        <PreviewBody key={`${share}:${entry.path}`} entry={entry} share={share} variant="pane" />
      ) : (
        <PreviewMessage icon={<FileIcon kind={fileKind(entry)} size={96} />}>
          No hay vista previa disponible
        </PreviewMessage>
      )}
    </div>
  );
}
