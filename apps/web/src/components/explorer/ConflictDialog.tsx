import type { ConflictStrategy } from '@wfb/contracts';
import { Dialog } from '../ui/Dialog';
import { Icon } from './icons';

export interface ConflictInfo {
  kind: 'copy' | 'move' | 'upload';
  count: number;
  /** Names that already exist in the destination (may be empty if the server gave no details). */
  names: string[];
  from?: string;
  to: string;
}

const VERB = { copy: 'Copiando', move: 'Moviendo', upload: 'Subiendo' };

export function ConflictDialog({
  info,
  onResolve,
}: {
  info: ConflictInfo;
  onResolve: (strategy: Exclude<ConflictStrategy, 'fail'> | null) => void;
}) {
  const { names } = info;
  const what =
    names.length === 1
      ? `El destino ya tiene un elemento llamado «${names[0]}»`
      : names.length > 1
        ? `El destino tiene ${names.length} elementos con los mismos nombres`
        : 'El destino ya contiene elementos con los mismos nombres';
  const options: {
    strategy: Exclude<ConflictStrategy, 'fail'>;
    label: string;
    hint: string;
    icon: React.ReactNode;
  }[] = [
    {
      strategy: 'overwrite',
      label: 'Reemplazar los archivos en el destino',
      hint: 'Los elementos existentes se sobrescribirán.',
      icon: <Icon.Check />,
    },
    {
      strategy: 'skip',
      label: 'Omitir estos archivos',
      hint: 'Solo se transferirán los que no existan.',
      icon: <Icon.Forward />,
    },
    {
      strategy: 'rename',
      label: 'Conservar ambos',
      hint: 'Se añadirá un número al nombre de los nuevos.',
      icon: <Icon.Copy />,
    },
  ];
  return (
    <Dialog
      title="Reemplazar u omitir archivos"
      onClose={() => onResolve(null)}
      width={480}
      footer={
        <button type="button" className="wfb-btn" onClick={() => onResolve(null)}>
          Cancelar
        </button>
      }
    >
      <p className="wfb-conflict-summary">
        {VERB[info.kind]} {info.count === 1 ? '1 elemento' : `${info.count} elementos`}
        {info.from ? (
          <>
            {' '}
            de <strong>{info.from}</strong>
          </>
        ) : null}{' '}
        a <strong>{info.to}</strong>
      </p>
      <p className="wfb-conflict-what">{what}</p>
      {names.length > 1 && (
        <ul className="wfb-conflict-names">
          {names.slice(0, 5).map((n) => (
            <li key={n}>{n}</li>
          ))}
          {names.length > 5 && <li>y {names.length - 5} más…</li>}
        </ul>
      )}
      <div className="wfb-conflict-options">
        {options.map((o, i) => (
          <button
            key={o.strategy}
            type="button"
            className="wfb-conflict-option"
            data-autofocus={i === 0 ? '' : undefined}
            onClick={() => onResolve(o.strategy)}
          >
            <span className="wfb-conflict-check">{o.icon}</span>
            <span>
              <span className="wfb-conflict-label">{o.label}</span>
              <span className="wfb-conflict-hint">{o.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
