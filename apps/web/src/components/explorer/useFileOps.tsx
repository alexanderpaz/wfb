import {
  basename,
  dirname,
  type ConflictStrategy,
  type FileEntry,
  type FileRef,
  type ListResponse,
  type TransferResponse,
} from '@wfb/contracts';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { useClipboard } from '../../stores/clipboard';
import { toast, useToasts } from '../../stores/toasts';
import { ConflictDialog, type ConflictInfo } from './ConflictDialog';
import { errorMessage, isConflict } from './errors';

export const listKey = (share: string, path: string) => ['list', share, path] as const;

function invalidateDirs(qc: QueryClient, dirs: FileRef[]) {
  const seen = new Set<string>();
  const jobs: Promise<void>[] = [];
  for (const d of dirs) {
    const k = `${d.share}\0${d.path}`;
    if (seen.has(k)) continue;
    seen.add(k);
    jobs.push(qc.invalidateQueries({ queryKey: listKey(d.share, d.path) }));
  }
  return Promise.all(jobs);
}

/** Marks every cached listing at or below `ref.path` as stale (moved/deleted folders). */
function invalidateSubtrees(qc: QueryClient, refs: FileRef[]) {
  if (refs.length === 0) return Promise.resolve();
  return qc.invalidateQueries({
    predicate: (q) => {
      const [kind, share, path] = q.queryKey as [unknown, unknown, unknown];
      return (
        kind === 'list' &&
        typeof path === 'string' &&
        refs.some((r) => r.share === share && (path === r.path || path.startsWith(r.path + '/')))
      );
    },
  });
}

function conflictNames(details: unknown): string[] {
  const list = (details as { conflicts?: unknown } | undefined)?.conflicts;
  if (!Array.isArray(list)) return [];
  return list
    .map((c) => (typeof c === 'string' ? basename(c) : typeof c?.path === 'string' ? basename(c.path) : null))
    .filter((n): n is string => !!n);
}

const VERB = {
  copy: { busy: 'Copiando', done: 'copiado', fail: 'copiar' },
  move: { busy: 'Moviendo', done: 'movido', fail: 'mover' },
};

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many.replace('#', String(n));
}

/** Mutations used by the explorer: transfers (with conflict resolution), delete, rename, mkdir, upload. */
export function useFileOps(describe: (ref: FileRef) => string) {
  const qc = useQueryClient();
  const [conflict, setConflict] = useState<{
    info: ConflictInfo;
    resolve: (s: Exclude<ConflictStrategy, 'fail'> | null) => void;
  } | null>(null);
  const describeRef = useRef(describe);
  describeRef.current = describe;

  const askConflict = useCallback(
    (info: ConflictInfo) =>
      new Promise<Exclude<ConflictStrategy, 'fail'> | null>((resolve) => {
        setConflict({
          info,
          resolve: (s) => {
            setConflict(null);
            resolve(s);
          },
        });
      }),
    [],
  );

  /** Copies or moves `items` into `destination`. Resolves to the target refs that were written, or null. */
  const transfer = useCallback(
    async (kind: 'copy' | 'move', items: FileRef[], destination: FileRef): Promise<FileRef[] | null> => {
      if (items.length === 0) return null;
      const sameFolder = items.every(
        (i) => i.share === destination.share && dirname(i.path) === destination.path,
      );
      if (kind === 'move' && sameFolder) return [];
      // Pasting a copy next to its source behaves like Windows ("Conservar ambos").
      let strategy: ConflictStrategy = kind === 'copy' && sameFolder ? 'rename' : 'fail';
      const verb = VERB[kind];
      const busy = toast.busy(`${verb.busy} ${plural(items.length, '1 elemento', '# elementos')}…`);
      let res: TransferResponse;
      try {
        for (;;) {
          try {
            res = await api[kind]({ items, destination, conflict: strategy });
            break;
          } catch (e) {
            if (!isConflict(e) || strategy !== 'fail') throw e;
            const choice = await askConflict({
              kind,
              count: items.length,
              names: conflictNames(e.details),
              from: describeRef.current({ share: items[0]!.share, path: dirname(items[0]!.path) }),
              to: describeRef.current(destination),
            });
            if (!choice) return null;
            strategy = choice;
          }
        }
      } catch (e) {
        toast.error(`No se pudo ${verb.fail}`, errorMessage(e));
        return null;
      } finally {
        useToasts.getState().dismiss(busy);
      }

      const dirs: FileRef[] = [destination];
      if (kind === 'move') dirs.push(...items.map((i) => ({ share: i.share, path: dirname(i.path) })));
      if (res.mode === 'job') {
        toast.info('La operación continúa en segundo plano', 'Actualice la carpeta cuando termine.');
        await invalidateDirs(qc, dirs);
        return [];
      }
      const failed = res.results.filter((r) => r.status === 'failed');
      if (failed.length > 0) {
        toast.error(
          `No se ${plural(failed.length, 'pudo', 'pudieron')} ${verb.fail} ${plural(failed.length, '1 elemento', '# elementos')}`,
          failed
            .slice(0, 4)
            .map((r) => `${basename(r.source.path)}: ${r.error ?? 'error'}`)
            .join('\n'),
        );
      }
      const moved = res.results.filter((r) => r.status === 'done').map((r) => r.source);
      await Promise.all([invalidateDirs(qc, dirs), kind === 'move' ? invalidateSubtrees(qc, moved) : null]);
      return res.results.filter((r) => r.status !== 'failed' && r.target).map((r) => r.target!);
    },
    [qc, askConflict],
  );

  const paste = useCallback(
    async (destination: FileRef) => {
      const { mode, items, clear } = useClipboard.getState();
      if (items.length === 0) return null;
      const result = await transfer(mode === 'cut' ? 'move' : 'copy', items, destination);
      if (result && mode === 'cut') clear();
      return result;
    },
    [transfer],
  );

  const remove = useCallback(
    async (items: FileRef[], permanent: boolean) => {
      if (items.length === 0) return false;
      try {
        const res = await api.remove({ items, permanent });
        const failed = res.results.filter((r) => r.status === 'failed');
        if (failed.length > 0) {
          toast.error(
            `No se ${plural(failed.length, 'pudo', 'pudieron')} eliminar ${plural(failed.length, '1 elemento', '# elementos')}`,
            failed.map((r) => `${basename(r.source.path)}: ${r.error ?? 'error'}`).join('\n'),
          );
        }
        const cut = useClipboard.getState();
        if (cut.items.some((c) => items.some((i) => i.share === c.share && i.path === c.path))) cut.clear();
        await Promise.all([
          invalidateDirs(
            qc,
            items.map((i) => ({ share: i.share, path: dirname(i.path) })),
          ),
          invalidateSubtrees(qc, items),
        ]);
        return failed.length === 0;
      } catch (e) {
        toast.error('No se pudo eliminar', errorMessage(e));
        return false;
      }
    },
    [qc],
  );

  const rename = useCallback(
    async (ref: FileRef, newName: string): Promise<FileEntry | null> => {
      try {
        const { entry } = await api.rename({ ...ref, newName });
        await Promise.all([
          invalidateDirs(qc, [{ share: ref.share, path: dirname(ref.path) }]),
          invalidateSubtrees(qc, [ref]),
        ]);
        return entry;
      } catch (e) {
        toast.error(`No se pudo cambiar el nombre de «${basename(ref.path)}»`, errorMessage(e));
        return null;
      }
    },
    [qc],
  );

  /** Creates "Nueva carpeta" (or "Nueva carpeta (N)") inside `dir`. */
  const mkdir = useCallback(
    async (dir: FileRef, existing: string[]): Promise<FileEntry | null> => {
      const taken = new Set(existing.map((n) => n.toLocaleLowerCase('es')));
      let name = 'Nueva carpeta';
      for (let i = 2; taken.has(name.toLocaleLowerCase('es')); i++) name = `Nueva carpeta (${i})`;
      try {
        const { entry } = await api.mkdir({ ...dir, name });
        qc.setQueryData<ListResponse>(listKey(dir.share, dir.path), (old) =>
          old && !old.entries.some((e) => e.path === entry.path)
            ? { ...old, entries: [...old.entries, entry] }
            : old,
        );
        void invalidateDirs(qc, [dir]);
        return entry;
      } catch (e) {
        toast.error('No se pudo crear la carpeta', errorMessage(e));
        return null;
      }
    },
    [qc],
  );

  const upload = useCallback(
    async (dir: FileRef, files: File[]): Promise<FileEntry[] | null> => {
      if (files.length === 0) return null;
      const busy = toast.busy(
        `Subiendo ${plural(files.length, '1 archivo', '# archivos')}…`,
        `a ${describeRef.current(dir)}`,
      );
      let strategy: ConflictStrategy = 'fail';
      try {
        for (;;) {
          try {
            const { entries } = await api.upload(dir, files, strategy);
            toast.success(
              entries.length === 1
                ? `Se ha subido «${entries[0]!.name}»`
                : `Se han subido ${entries.length} archivos`,
            );
            return entries;
          } catch (e) {
            if (!isConflict(e) || strategy !== 'fail') throw e;
            const names = conflictNames(e.details);
            const choice = await askConflict({
              kind: 'upload',
              count: files.length,
              names: names.length ? names : files.map((f) => f.name),
              to: describeRef.current(dir),
            });
            if (!choice) return null;
            strategy = choice;
          }
        }
      } catch (e) {
        toast.error('No se pudieron subir los archivos', errorMessage(e));
        return null;
      } finally {
        useToasts.getState().dismiss(busy);
        void invalidateDirs(qc, [dir]);
      }
    },
    [qc, askConflict],
  );

  const refresh = useCallback(
    (dir: FileRef) =>
      Promise.all([qc.invalidateQueries({ queryKey: ['shares'] }), invalidateDirs(qc, [dir])]),
    [qc],
  );

  const dialogs: ReactNode = conflict ? (
    <ConflictDialog info={conflict.info} onResolve={conflict.resolve} />
  ) : null;

  return { transfer, paste, remove, rename, mkdir, upload, refresh, dialogs };
}
