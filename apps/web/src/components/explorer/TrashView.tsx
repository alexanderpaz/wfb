import { dirname, type Share, type TrashItem } from '@wfb/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { toast } from '../../stores/toasts';
import { Dialog } from '../ui/Dialog';
import { errorMessage } from './errors';
import { fileKind, formatDate, formatSize } from './fileTypes';
import { FileIcon, Icon } from './icons';
import './ops.css';

export const trashQueryKey = (share: string) => ['trash', share] as const;

/** "Ingeniería/Proyectos" for an entry at /Proyectos/x within the Ingeniería share. */
export function folderLabel(shareName: string, path: string): string {
  const parent = dirname(path);
  return parent === '/' ? shareName : `${shareName}${parent}`;
}

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

interface TrashViewProps {
  share: Share;
}

type Confirm = { kind: 'purge'; items: TrashItem[] } | { kind: 'empty'; items: TrashItem[] };

/** "Papelera de reciclaje" of one share: restore, purge selected, empty. */
export function TrashView({ share }: TrashViewProps) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: trashQueryKey(share.id), queryFn: () => api.trash(share.id) });
  const items = useMemo(
    () =>
      [...(q.data?.items ?? [])].sort(
        (a, b) => b.deletedAt.localeCompare(a.deletedAt) || collator.compare(a.name, b.name),
      ),
    [q.data],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const canRestore = share.permissions.includes('write');
  const canPurge = share.permissions.includes('delete');
  const selection = items.filter((i) => selected.has(i.id));

  useEffect(() => setSelected(new Set()), [share.id]);
  useEffect(() => {
    if (q.error) toast.error('No se puede abrir la papelera', errorMessage(q.error));
  }, [q.error]);

  const refreshShare = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: trashQueryKey(share.id) }),
      qc.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'list' && query.queryKey[1] === share.id,
      }),
    ]);

  const run = async (what: 'restore' | 'purge', list: TrashItem[]) => {
    if (list.length === 0) return;
    setBusy(true);
    try {
      const body = { share: share.id, ids: list.map((i) => i.id) };
      if (what === 'restore') await api.restoreTrash(body);
      else await api.purgeTrash(body);
      setSelected(new Set());
      const n = list.length === 1 ? `«${list[0]!.name}»` : `${list.length} elementos`;
      toast.success(what === 'restore' ? `Se ha restaurado ${n}` : `Se ha eliminado ${n} permanentemente`);
    } catch (e) {
      toast.error(
        what === 'restore'
          ? 'No se pudieron restaurar los elementos'
          : 'No se pudieron eliminar los elementos',
        errorMessage(e),
      );
    } finally {
      setBusy(false);
      await refreshShare();
    }
  };

  const onRowClick = (item: TrashItem, e: React.MouseEvent) => {
    setSelected((prev) => {
      if (e.ctrlKey || e.metaKey) {
        const next = new Set(prev);
        if (next.has(item.id)) next.delete(item.id);
        else next.add(item.id);
        return next;
      }
      return new Set([item.id]);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelected(new Set(items.map((i) => i.id)));
    } else if (e.key === 'Delete' && selection.length > 0 && canPurge) {
      e.preventDefault();
      setConfirm({ kind: 'purge', items: selection });
    } else if (e.key === 'Escape') {
      setSelected(new Set());
    }
  };

  return (
    <div className="wfb-ops-view">
      <div className="wfb-ops-header">
        <h2 className="wfb-ops-title">
          <Icon.RecycleBin size={18} /> Papelera de reciclaje: {share.name}
        </h2>
        <div className="wfb-ops-actions" role="toolbar" aria-label="Acciones de la papelera">
          <button
            type="button"
            className="wfb-cmd"
            disabled={busy || selection.length === 0 || !canRestore}
            title={canRestore ? 'Restaurar los elementos seleccionados' : 'No tiene permiso de escritura'}
            onClick={() => void run('restore', selection)}
          >
            <Icon.Restore />
            <span className="wfb-cmd-label">Restaurar</span>
          </button>
          <button
            type="button"
            className="wfb-cmd"
            disabled={busy || selection.length === 0 || !canPurge}
            title={canPurge ? undefined : 'No tiene permiso de eliminación'}
            onClick={() => setConfirm({ kind: 'purge', items: selection })}
          >
            <Icon.Delete />
            <span className="wfb-cmd-label">Eliminar permanentemente</span>
          </button>
          <button
            type="button"
            className="wfb-cmd"
            disabled={busy || items.length === 0 || !canPurge}
            title={canPurge ? undefined : 'No tiene permiso de eliminación'}
            onClick={() => setConfirm({ kind: 'empty', items })}
          >
            <Icon.RecycleBin />
            <span className="wfb-cmd-label">Vaciar papelera</span>
          </button>
        </div>
      </div>

      <div className="wfb-ops-table is-trash">
        <div className="wfb-ops-row wfb-ops-head" role="presentation">
          <span>Nombre</span>
          <span>Ubicación original</span>
          <span>Fecha de eliminación</span>
          <span className="is-right">Tamaño</span>
        </div>
        <div
          className="wfb-ops-items"
          role="listbox"
          aria-label={`Papelera de ${share.name}`}
          aria-multiselectable="true"
          tabIndex={0}
          onKeyDown={onKeyDown}
        >
          {q.isPending ? (
            <div className="wfb-empty" role="status">
              Cargando…
            </div>
          ) : items.length === 0 ? (
            <div className="wfb-empty">La papelera está vacía.</div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                role="option"
                aria-selected={selected.has(item.id)}
                aria-label={item.name}
                className={`wfb-ops-row wfb-item${selected.has(item.id) ? ' is-selected' : ''}`}
                onClick={(e) => onRowClick(item, e)}
              >
                <span className="wfb-cell wfb-cell-name">
                  <FileIcon kind={fileKind({ name: item.name, type: item.type, mime: null })} size={18} />
                  <span className="wfb-item-name" title={item.name}>
                    {item.name}
                  </span>
                </span>
                <span className="wfb-cell wfb-cell-muted" title={item.originalPath}>
                  {folderLabel(share.name, item.originalPath)}
                </span>
                <span className="wfb-cell wfb-cell-muted">{formatDate(item.deletedAt)}</span>
                <span className="wfb-cell wfb-cell-muted is-right">{formatSize(item.size)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {confirm && (
        <Dialog
          title={confirm.kind === 'empty' ? 'Vaciar papelera' : 'Eliminar permanentemente'}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button
                type="button"
                className="wfb-btn is-danger"
                data-autofocus=""
                onClick={() => {
                  const list = confirm.items;
                  setConfirm(null);
                  void run('purge', list);
                }}
              >
                Eliminar
              </button>
              <button type="button" className="wfb-btn" onClick={() => setConfirm(null)}>
                Cancelar
              </button>
            </>
          }
        >
          <p>
            {confirm.kind === 'empty'
              ? `¿Está seguro de que desea eliminar permanentemente ${confirm.items.length === 1 ? 'el elemento' : `los ${confirm.items.length} elementos`} de la papelera?`
              : `¿Está seguro de que desea eliminar permanentemente ${confirm.items.length === 1 ? `«${confirm.items[0]!.name}»` : `estos ${confirm.items.length} elementos`}? Esta acción no se puede deshacer.`}
          </p>
        </Dialog>
      )}
    </div>
  );
}
