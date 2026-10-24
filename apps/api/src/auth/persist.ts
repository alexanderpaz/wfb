import type { PrismaClient } from '@prisma/client';
import type { User } from '@wfb/contracts';
import type { FastifyBaseLogger } from 'fastify';

/** Records the user and its last login. Best effort: never breaks a login. */
export async function persistUser(
  prisma: PrismaClient | null,
  user: User,
  externalId: string,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!prisma) return;
  const data = {
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    groups: user.groups,
    lastLoginAt: new Date(),
  };
  try {
    await prisma.user.upsert({
      where: { provider_externalId: { provider: user.provider, externalId } },
      create: { provider: user.provider, externalId, ...data },
      update: data,
    });
  } catch (err) {
    log.warn({ err, username: user.username }, 'could not persist user');
  }
}
