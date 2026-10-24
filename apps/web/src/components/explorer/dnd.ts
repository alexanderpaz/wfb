import type { FileRef } from '@wfb/contracts';

/** Internal drag payload; `dragover` cannot read dataTransfer data, so it is kept here. */
let current: FileRef[] | null = null;

export const DRAG_MIME = 'application/x-wfb-items';

export const dragPayload = {
  set: (items: FileRef[] | null) => {
    current = items;
  },
  get: () => current,
};

export type DropOp = 'move' | 'copy' | 'upload';

export interface DropTarget {
  ref: FileRef;
  name: string;
  canWrite: boolean;
}

const isOsFiles = (dt: DataTransfer | null) => !!dt && [...dt.types].includes('Files');

/**
 * Decides what dropping here would do. Ctrl forces copy and Shift forces move;
 * otherwise moves inside a share and copies across shares (like Windows across drives).
 */
export function resolveDrop(
  e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; dataTransfer: DataTransfer | null },
  target: DropTarget,
  canDelete: (share: string) => boolean,
): DropOp | null {
  if (!target.canWrite) return null;
  const items = current;
  if (!items) return isOsFiles(e.dataTransfer) ? 'upload' : null;
  const { share, path } = target.ref;
  const intoItself = items.some(
    (i) => i.share === share && (path === i.path || path.startsWith(i.path === '/' ? '/' : i.path + '/')),
  );
  if (intoItself) return null;
  const allSameParent = items.every(
    (i) => i.share === share && (i.path.slice(0, i.path.lastIndexOf('/')) || '/') === path,
  );
  const sameShare = items.every((i) => i.share === share);
  const sourcesDeletable = items.every((i) => canDelete(i.share));
  let op: DropOp;
  if (e.ctrlKey || e.metaKey) op = 'copy';
  else if (e.shiftKey) op = 'move';
  else op = sameShare ? 'move' : 'copy';
  if (op === 'move' && allSameParent) return null;
  if (op === 'move' && !sourcesDeletable) return 'copy';
  return op;
}

export function dropLabel(op: DropOp, name: string) {
  return `${op === 'move' ? 'Mover a' : 'Copiar a'} ${name}`;
}
