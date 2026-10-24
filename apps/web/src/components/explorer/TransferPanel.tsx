import { basename } from '@wfb/contracts';
import { transferCancel, useTransfers, type TransferTask } from '../../stores/transfers';
import { formatSize } from './fileTypes';
import { Icon } from './icons';

const STATUS_LABEL: Record<TransferTask['status'], string> = {
  running: 'En curso',
  completed: 'Completado',
  failed: 'Error',
  cancelled: 'Cancelado',
};

const percent = (t: TransferTask) => {
  if (t.status === 'completed') return 100;
  if (t.totalBytes > 0) return Math.min(100, Math.floor((t.doneBytes / t.totalBytes) * 100));
  if (t.totalItems > 0) return Math.min(100, Math.floor((t.doneItems / t.totalItems) * 100));
  return 0;
};

function TaskRow({ task }: { task: TransferTask }) {
  const remove = useTransfers((s) => s.remove);
  const pct = percent(task);
  const running = task.status === 'running';
  return (
    <li className={`wfb-transfer is-${task.status}`} aria-label={task.title}>
      <div className="wfb-transfer-head">
        <strong className="wfb-transfer-title">{task.title}</strong>
        {running ? (
          <button
            type="button"
            className="wfb-btn wfb-transfer-cancel"
            disabled={task.cancelling}
            onClick={() => void transferCancel.run(task.id)}
          >
            {task.cancelling ? 'Cancelando…' : 'Cancelar'}
          </button>
        ) : (
          <button
            type="button"
            className="wfb-iconbtn"
            aria-label={`Quitar «${task.title}»`}
            title="Quitar"
            onClick={() => remove(task.id)}
          >
            <Icon.Close size={12} />
          </button>
        )}
      </div>
      <div className="wfb-transfer-status">
        <span>{running ? `${pct} % completado` : STATUS_LABEL[task.status]}</span>
        {task.totalBytes > 0 && (
          <span className="wfb-muted">
            {formatSize(Math.min(task.doneBytes, task.totalBytes))} de {formatSize(task.totalBytes)}
          </span>
        )}
      </div>
      <div
        className="wfb-progress"
        role="progressbar"
        aria-label={`Progreso: ${task.title}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className="wfb-progress-bar" style={{ width: `${pct}%` }} />
      </div>
      {running && task.currentItem && (
        <div className="wfb-transfer-item wfb-muted" title={task.currentItem}>
          Elemento: {basename(task.currentItem) || task.currentItem}
        </div>
      )}
      {task.error && <div className="wfb-transfer-error">{task.error}</div>}
      {task.failures.length > 0 && (
        <details className="wfb-transfer-failures">
          <summary>
            {task.failures.length === 1
              ? '1 elemento no se pudo procesar'
              : `${task.failures.length} elementos no se pudieron procesar`}
          </summary>
          <ul>
            {task.failures.map((f, i) => (
              <li key={i}>
                <span>{f.name}</span>: <span className="wfb-muted">{f.error}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

/** Windows-like stack of background operations (copy/move jobs and chunked uploads). */
export function TransferPanel() {
  const tasks = useTransfers((s) => s.tasks);
  const collapsed = useTransfers((s) => s.collapsed);
  const setCollapsed = useTransfers((s) => s.setCollapsed);
  const clearFinished = useTransfers((s) => s.clearFinished);
  if (tasks.length === 0) return null;

  const running = tasks.filter((t) => t.status === 'running').length;
  const title =
    running > 0
      ? running === 1
        ? '1 operación en curso'
        : `${running} operaciones en curso`
      : 'Operaciones finalizadas';
  return (
    <section className="wfb-transfers" aria-label="Operaciones en segundo plano">
      <header className="wfb-transfers-header">
        <button
          type="button"
          className="wfb-transfers-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <Icon.ChevronRight size={12} /> : <Icon.ChevronDown size={12} />}
          <span>{title}</span>
        </button>
        {running === 0 && (
          <button
            type="button"
            className="wfb-iconbtn"
            aria-label="Cerrar panel de operaciones"
            title="Cerrar"
            onClick={clearFinished}
          >
            <Icon.Close size={12} />
          </button>
        )}
      </header>
      {!collapsed && (
        <ul className="wfb-transfers-list">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
