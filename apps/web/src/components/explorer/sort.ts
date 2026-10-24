import type { FileEntry } from '@wfb/contracts';
import type { SortDir, SortKey } from '../../stores/explorerPrefs';
import { typeLabel } from './fileTypes';

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Sorts like Explorer: folders always first, then by key; ties broken by name. */
export function sortEntries(entries: FileEntry[], key: SortKey, dir: SortDir): FileEntry[] {
  const m = dir === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    let c = 0;
    if (key === 'modifiedAt') c = Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt);
    else if (key === 'size') c = a.size - b.size;
    else if (key === 'type') c = collator.compare(typeLabel(a), typeLabel(b));
    if (c === 0) c = collator.compare(a.name, b.name);
    return c * m;
  });
}

export function filterEntries(entries: FileEntry[], query: string): FileEntry[] {
  const q = query.trim().toLocaleLowerCase('es');
  if (!q) return entries;
  return entries.filter((e) => e.name.toLocaleLowerCase('es').includes(q));
}
