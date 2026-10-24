import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { User } from '@wfb/contracts';
import type { KeyValueStore } from '../lib/kv.js';

export interface SessionData {
  user: User;
  csrfToken: string;
  createdAt: number;
  /** OIDC sessions: the id token, sent as `id_token_hint` on logout. */
  idToken?: string;
}

export interface Session extends SessionData {
  id: string;
}

const key = (id: string) => `sess:${id}`;

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Server-side sessions stored in the key/value store under `sess:<id>`. */
export class SessionStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly ttlSeconds: number,
  ) {}

  async create(user: User, extra: Pick<SessionData, 'idToken'> = {}): Promise<Session> {
    const data: SessionData = { user, csrfToken: randomToken(), createdAt: Date.now(), ...extra };
    const session: Session = { id: randomToken(), ...data };
    await this.kv.set(key(session.id), JSON.stringify(data), this.ttlSeconds);
    return session;
  }

  async get(id: string): Promise<Session | null> {
    if (!/^[\w-]{20,128}$/.test(id)) return null;
    const raw = await this.kv.get(key(id));
    if (!raw) return null;
    try {
      const data = JSON.parse(raw) as SessionData;
      if (!data?.user || typeof data.csrfToken !== 'string') return null;
      return { id, ...data };
    } catch {
      return null;
    }
  }

  async destroy(id: string): Promise<void> {
    await this.kv.del(key(id));
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(bb, bb);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
