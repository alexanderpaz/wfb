import { PrismaClient } from '@prisma/client';

/** Postgres is optional in development and tests; modules must handle `null`. */
export function createPrisma(databaseUrl: string | undefined): PrismaClient | null {
  if (!databaseUrl) return null;
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}
