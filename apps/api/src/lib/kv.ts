import { Redis } from 'ioredis';

/** Small key/value abstraction used for sessions, rate limits and upload state. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** Atomically increments a counter, setting the TTL on first increment. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export class MemoryStore implements KeyValueStore {
  private data = new Map<string, { value: string; expiresAt: number | null }>();

  private live(key: string) {
    const item = this.data.get(key);
    if (!item) return null;
    if (item.expiresAt !== null && item.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return item;
  }

  async get(key: string) {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    this.data.set(key, { value, expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
  }

  async del(key: string) {
    this.data.delete(key);
  }

  async incr(key: string, ttlSeconds: number) {
    const item = this.live(key);
    const next = (item ? Number(item.value) : 0) + 1;
    this.data.set(key, {
      value: String(next),
      expiresAt: item?.expiresAt ?? Date.now() + ttlSeconds * 1000,
    });
    return next;
  }

  async ping() {
    return true;
  }

  async close() {
    this.data.clear();
  }
}

export class RedisStore implements KeyValueStore {
  private client: Redis;

  constructor(url: string) {
    this.client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 3 });
  }

  async get(key: string) {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number) {
    if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
    else await this.client.set(key, value);
  }

  async del(key: string) {
    await this.client.del(key);
  }

  async incr(key: string, ttlSeconds: number) {
    const [[, count]] = (await this.client.multi().incr(key).expire(key, ttlSeconds, 'NX').exec()) as [
      [Error | null, number],
    ];
    return count;
  }

  async ping() {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close() {
    await this.client.quit();
  }
}

export function createStore(redisUrl: string | undefined): KeyValueStore {
  return redisUrl ? new RedisStore(redisUrl) : new MemoryStore();
}
