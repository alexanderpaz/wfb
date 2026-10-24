import { ApiRequestError } from '../../api/client';

/** Codes sent by the API as `/?authError=<code>` when the OIDC callback fails. */
const OIDC_ERRORS: Record<string, string> = {
  oidc_denied: 'Se canceló el inicio de sesión en el proveedor de identidad.',
  oidc_state: 'La solicitud de inicio de sesión caducó o no es válida. Vuelve a intentarlo.',
  oidc_failed: 'No se pudo completar el inicio de sesión. Vuelve a intentarlo.',
  oidc_unavailable: 'El proveedor de identidad no está disponible en este momento. Inténtalo más tarde.',
};

export function oidcErrorMessage(code: string): string {
  return OIDC_ERRORS[code] ?? 'No se pudo iniciar sesión. Vuelve a intentarlo.';
}

export function loginErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'UNAUTHENTICATED':
        return 'Usuario o contraseña incorrectos.';
      case 'RATE_LIMITED':
        return 'Demasiados intentos de inicio de sesión. Espera un minuto y vuelve a intentarlo.';
      case 'BAD_REQUEST':
        return 'Escribe tu usuario y tu contraseña.';
      case 'NOT_FOUND':
        return 'El inicio de sesión con usuario y contraseña no está habilitado.';
      default:
        return 'El servicio de autenticación no está disponible. Inténtalo más tarde.';
    }
  }
  return 'No se pudo conectar con el servidor. Comprueba tu conexión.';
}
