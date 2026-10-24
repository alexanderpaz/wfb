import {
  basename,
  dirname,
  type ConflictStrategy,
  type FileEntry,
  type FileRef,
  type Job,
  type ListResponse,
  type TransferResponse,
} from '@wfb/contracts';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { useClipboard } from '../../stores/clipboard';
import { toast, useToasts } from '../../stores/toasts';
import { transferCancel, useTransfers } from '../../stores/transfers';
import { ConflictDialog, type ConflictInfo } from './ConflictDialog';
import { errorMessage, isConflict } from './errors';
import { isFinished, watchJob } from './jobStream';
import { CHUNKED_UPLOAD_THRESHOLD, chunkedUpload, UploadCancelledError } from './uploader';

let uploadSeq = 0;

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
  copy: { busy: 'Copiando', fail: 'copiar' },
  move: { busy: 'Moviendo', fail: 'mover' },
};

export interface TransferOutcome {
  /** Where the transferred items ended up. */
  targets: FileRef[];
  failed: FileRef[];
}

/** Runs `fn` with a busy toast that is gone before the caller handles the outcome (e.g. a conflict dialog). */
async function withBusy<T>(
  title: string,
  message: string | undefined,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const id = toast.busy(title, message);
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  } finally {
    useToasts.getState().dismiss(id);
  }
}

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

  /** Follows a background copy/move in the progress panel and refreshes folders when it ends. */
  const trackJob = useCallback(
    (jobId: string, kind: 'copy' | 'move', items: FileRef[], destination: FileRef) => {
      const { add, update } = useTransfers.getState();
      const from = describeRef.current({ share: items[0]!.share, path: dirname(items[0]!.path) });
      const title = `${VERB[kind].busy} ${plural(items.length, '1 elemento', '# elementos')} de ${from} a ${describeRef.current(destination)}`;
      add({
        id: jobId,
        kind,
        title,
        status: 'running',
        totalBytes: 0,
        doneBytes: 0,
        totalItems: items.length,
        doneItems: 0,
        currentItem: null,
      });

      let done = false;
      let stop: (() => void) | null = null;
      const finish = (job: Job | null) => {
        if (done) return;
        done = true;
        stop?.();
        transferCancel.delete(jobId);
        const dirs: FileRef[] = [destination];
        if (kind === 'move') dirs.push(...items.map((i) => ({ share: i.share, path: dirname(i.path) })));
        const moved = (job?.results ?? []).filter((r) => r.status === 'done').map((r) => r.source);
        void Promise.all([invalidateDirs(qc, dirs), kind === 'move' ? invalidateSubtrees(qc, moved) : null]);
        const failed = (job?.results ?? []).filter((r) => r.status === 'failed');
        if (failed.length > 0) {
          toast.error(
            `No se ${plural(failed.length, 'pudo', 'pudieron')} ${VERB[kind].fail} ${plural(failed.length, '1 elemento', '# elementos')}`,
            failed
              .slice(0, 4)
              .map((r) => `${basename(r.source.path)}: ${r.error ?? 'error'}`)
              .join('\n'),
          );
        }
      };
      const apply = (job: Job) => {
        if (done) return;
        update(jobId, {
          status: job.status === 'queued' ? 'running' : job.status,
          totalBytes: job.totalBytes,
          doneBytes: job.doneBytes,
          totalItems: job.totalItems,
          doneItems: job.doneItems,
          currentItem: job.currentItem,
          error: job.error,
          failures: job.results
            .filter((r) => r.status === 'failed')
            .map((r) => ({ name: basename(r.source.path), error: r.error ?? 'error' })),
          ...(isFinished(job) ? { cancelling: false } : {}),
        });
        if (isFinished(job)) finish(job);
      };

      transferCancel.set(jobId, async () => {
        update(jobId, { cancelling: true });
        try {
          apply((await api.cancelJob(jobId)).job);
        } catch (e) {
          update(jobId, { cancelling: false });
          toast.error('No se pudo cancelar la operación', errorMessage(e));
        }
      });
      stop = watchJob(jobId, {
        onJob: apply,
        onError: (e) => {
          if (done) return;
          update(jobId, { status: 'failed', error: errorMessage(e), cancelling: false });
          finish(null);
        },
      });
      if (done) stop();
    },
    [qc],
  );

  /** Copies or moves `items` into `destination`. Resolves to null when cancelled or rejected. */
  const transfer = useCallback(
    async (
      kind: 'copy' | 'move',
      items: FileRef[],
      destination: FileRef,
    ): Promise<TransferOutcome | null> => {
      if (items.length === 0) return null;
      const sameFolder = items.every(
        (i) => i.share === destination.share && dirname(i.path) === destination.path,
      );
      if (kind === 'move' && sameFolder) return { targets: [], failed: [] };
      // Pasting a copy next to its source behaves like Windows ("Conservar ambos").
      let strategy: ConflictStrategy = kind === 'copy' && sameFolder ? 'rename' : 'fail';
      const verb = VERB[kind];
      const label = `${verb.busy} ${plural(items.length, '1 elemento', '# elementos')}…`;
      let res: TransferResponse;
      try {
        for (;;) {
          const attempt = await withBusy(label, undefined, () =>
            api[kind]({ items, destination, conflict: strategy }),
          );
          if (attempt.ok) {
            res = attempt.value;
            break;
          }
          const e = attempt.error;
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
      } catch (e) {
        toast.error(`No se pudo ${verb.fail}`, errorMessage(e));
        return null;
      }

      const dirs: FileRef[] = [destination];
      if (kind === 'move') dirs.push(...items.map((i) => ({ share: i.share, path: dirname(i.path) })));
      if (res.mode === 'job') {
        trackJob(res.jobId, kind, items, destination);
        return { targets: [], failed: [] };
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
      return {
        targets: res.results.filter((r) => r.status !== 'failed' && r.target).map((r) => r.target!),
        failed: failed.map((r) => r.source),
      };
    },
    [qc, askConflict, trackJob],
  );

  const paste = useCallback(
    async (destination: FileRef) => {
      const { mode, items, clear } = useClipboard.getState();
      if (items.length === 0) return null;
      const result = await transfer(mode === 'cut' ? 'move' : 'copy', items, destination);
      if (result && mode === 'cut') {
        // Items that could not be moved stay on the clipboard so the user can retry.
        if (result.failed.length === 0) clear();
        else useClipboard.getState().set('cut', result.failed);
      }
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
          permanent ? null : qc.invalidateQueries({ queryKey: ['trash'] }),
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

  /** One large file through the resumable API, shown in the progress panel. */
  const uploadChunked = useCallback(
    async (dir: FileRef, file: File, conflict: ConflictStrategy): Promise<FileEntry | null> => {
      const { add, update } = useTransfers.getState();
      const id = `upload-${++uploadSeq}`;
      const controller = new AbortController();
      add({
        id,
        kind: 'upload',
        title: `Subiendo «${file.name}» a ${describeRef.current(dir)}`,
        status: 'running',
        totalBytes: file.size,
        doneBytes: 0,
        totalItems: 1,
        doneItems: 0,
        currentItem: null,
      });
      transferCancel.set(id, () => {
        update(id, { cancelling: true });
        controller.abort();
      });
      try {
        const entry = await chunkedUpload({
          file,
          name: file.name,
          destination: dir,
          conflict,
          signal: controller.signal,
          onProgress: (sent) => update(id, { doneBytes: sent }),
        });
        update(id, { status: 'completed', doneBytes: file.size, doneItems: 1 });
        return entry;
      } catch (e) {
        if (e instanceof UploadCancelledError) {
          update(id, { status: 'cancelled', cancelling: false });
        } else {
          update(id, {
            status: 'failed',
            cancelling: false,
            error: isConflict(e) ? `Ya existe «${file.name}» en el destino.` : errorMessage(e),
          });
        }
        return null;
      } finally {
        transferCancel.delete(id);
      }
    },
    [],
  );

  /** Small files in one multipart request (busy toast, server-side conflict check). */
  const uploadSimple = useCallback(
    async (dir: FileRef, files: File[], initial: ConflictStrategy): Promise<FileEntry[] | null> => {
      let strategy = initial;
      const label = `Subiendo ${plural(files.length, '1 archivo', '# archivos')}…`;
      try {
        for (;;) {
          const attempt = await withBusy(label, `a ${describeRef.current(dir)}`, () =>
            api.upload(dir, files, strategy),
          );
          if (attempt.ok) {
            const { entries } = attempt.value;
            toast.success(
              entries.length === 1
                ? `Se ha subido «${entries[0]!.name}»`
                : `Se han subido ${entries.length} archivos`,
            );
            return entries;
          }
          const e = attempt.error;
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
      } catch (e) {
        toast.error('No se pudieron subir los archivos', errorMessage(e));
        return null;
      } finally {
        void invalidateDirs(qc, [dir]);
      }
    },
    [qc, askConflict],
  );

  const upload = useCallback(
    async (dir: FileRef, allFiles: File[]): Promise<FileEntry[] | null> => {
      if (allFiles.length === 0) return null;
      let strategy: ConflictStrategy = 'fail';
      const large = allFiles.filter((f) => f.size > CHUNKED_UPLOAD_THRESHOLD);
      const files = allFiles.filter((f) => f.size <= CHUNKED_UPLOAD_THRESHOLD);

      if (large.length > 0) {
        // Chunked uploads only learn about conflicts at the end: ask before sending any byte.
        try {
          const listing = await api.list(dir);
          const taken = new Set(listing.entries.map((e) => e.name));
          const clashes = allFiles.filter((f) => taken.has(f.name)).map((f) => f.name);
          if (clashes.length > 0) {
            const choice = await askConflict({
              kind: 'upload',
              count: allFiles.length,
              names: clashes,
              to: describeRef.current(dir),
            });
            if (!choice) return null;
            strategy = choice;
          }
        } catch (e) {
          toast.error('No se pudieron subir los archivos', errorMessage(e));
          return null;
        }
      }

      const chunked = Promise.all(
        large.map((f) => uploadChunked(dir, f, strategy).finally(() => void invalidateDirs(qc, [dir]))),
      );
      const simple = files.length > 0 ? uploadSimple(dir, files, strategy) : Promise.resolve([]);
      const [big, small] = await Promise.all([chunked, simple]);
      if (small === null && big.every((e) => e === null)) return null;
      return [...(small ?? []), ...big.filter((e): e is FileEntry => e !== null)];
    },
    [qc, askConflict, uploadChunked, uploadSimple],
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
