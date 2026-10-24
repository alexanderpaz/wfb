import type { ReactNode } from 'react';

interface PreviewMessageProps {
  children: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  error?: boolean;
}

export function PreviewMessage({ children, icon, loading, error }: PreviewMessageProps) {
  return (
    <div
      className={`wfb-pv-message${error ? ' is-error' : ''}`}
      role={error ? 'alert' : 'status'}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="wfb-pv-spinner" aria-hidden="true" /> : icon}
      <p>{children}</p>
    </div>
  );
}
