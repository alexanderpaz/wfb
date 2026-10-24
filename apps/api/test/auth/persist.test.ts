import type { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { persistUser } from '../../src/auth/persist.js';
import { alice } from '../helpers.js';

const logger = () => ({ warn: vi.fn() }) as unknown as FastifyBaseLogger & { warn: ReturnType<typeof vi.fn> };

describe('persistUser', () => {
  it('upserts by provider + externalId', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    await persistUser({ user: { upsert } } as unknown as PrismaClient, alice, 'alice', logger());
    const arg = upsert.mock.calls[0]![0];
    expect(arg.where).toEqual({ provider_externalId: { provider: 'ldap', externalId: 'alice' } });
    expect(arg.create).toMatchObject({ provider: 'ldap', externalId: 'alice', username: 'alice', groups: ['staff'] });
    expect(arg.update.lastLoginAt).toBeInstanceOf(Date);
  });

  it('logs and swallows database errors', async () => {
    const log = logger();
    const upsert = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(persistUser({ user: { upsert } } as unknown as PrismaClient, alice, 'alice', log)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('does nothing without a database', async () => {
    await expect(persistUser(null, alice, 'alice', logger())).resolves.toBeUndefined();
  });
});
