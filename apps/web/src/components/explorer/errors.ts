import { ApiRequestError } from '../../api/client';

const BY_CODE: Record<string, string> = {
  UNAUTHENTICATED: 'La sesión ha caducado. Vuelva a iniciar sesión.',
  FORBIDDEN: 'No tiene permiso para realizar esta operación.',
  NOT_FOUND: 'No se encuentra el elemento. Puede que se haya movido o eliminado.',
  PAYLOAD_TOO_LARGE: 'El archivo es demasiado grande.',
  RATE_LIMITED: 'Demasiadas solicitudes. Inténtelo de nuevo en unos segundos.',
  CSRF: 'La sesión no es válida. Recargue la página.',
  INTERNAL: 'Se ha producido un error en el servidor.',
};

/** Spanish, user-facing description of an API (or network) error. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.code === 'CONFLICT' || e.code === 'BAD_REQUEST') return e.message || BY_CODE.INTERNAL!;
    return BY_CODE[e.code] ?? e.message;
  }
  if (e instanceof TypeError) return 'No se puede conectar con el servidor.';
  return e instanceof Error && e.message ? e.message : 'Error desconocido.';
}

export const isConflict = (e: unknown): e is ApiRequestError =>
  e instanceof ApiRequestError && e.status === 409 && e.code === 'CONFLICT';
