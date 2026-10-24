import type { KeyValueStore } from '../lib/kv.js';
import { HttpError } from '../lib/errors.js';

const WINDOW_SECONDS = 60;

/** Fixed one-minute window per client IP and per username. Throws 429 when exceeded. */
export async function checkLoginRateLimit(
  kv: KeyValueStore,
  limit: number,
  ip: string,
  username: string,
): Promise<void> {
  const [byIp, byUser] = await Promise.all([
    kv.incr(`rl:login:${ip}`, WINDOW_SECONDS),
    kv.incr(`rl:login-user:${username.toLowerCase()}`, WINDOW_SECONDS),
  ]);
  if (byIp > limit || byUser > limit) {
    throw new HttpError('RATE_LIMITED', 'Demasiados intentos de inicio de sesión. Espera un minuto.');
  }
}
