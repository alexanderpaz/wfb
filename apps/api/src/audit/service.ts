import type { Prisma, PrismaClient } from '@prisma/client';
import type { User } from '@wfb/contracts';
import type { FastifyBaseLogger } from 'fastify';

export type AuditAction =
  | 'login'
  | 'logout'
  | 'mkdir'
  | 'rename'
  | 'copy'
  | 'move'
  | 'delete'
  | 'upload'
  | 'trash.restore'
  | 'trash.purge';

export type AuditOutcome = 'success' | 'failure';

export interface AuditEvent {
  action: AuditAction;
  user: User | null;
  /** Used when there is no authenticated user (e.g. failed logins). */
  username?: string;
  share?: string | null;
  path?: string | null;
  /** Destination of copy/move/rename (`share:/path` or the new path). */
  target?: string | null;
  outcome: AuditOutcome;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

export type AuditPrisma = Pick<PrismaClient, 'auditLog' | 'user'>;

const MAX_CACHED_USERS = 1000;

/**
 * Writes audit events to the `AuditLog` table. Without Postgres events are
 * only logged. Writes are best effort: a failing database is logged and never
 * surfaces to the request.
 */
export class AuditService {
  private readonly pending = new Set<Promise<void>>();
  /** wfb user id ("ldap:alice") -> `User.id` row. */
  private readonly userIds = new Map<string, string>();

  constructor(
    private readonly prisma: AuditPrisma | null,
    private readonly log: FastifyBaseLogger,
  ) {}

  record(event: AuditEvent): Promise<void> {
    const promise: Promise<void> = this.write(event)
      .catch((err: unknown) => {
        this.log.warn({ err, audit: this.summary(event) }, 'could not write audit log');
      })
      .finally(() => this.pending.delete(promise));
    this.pending.add(promise);
    return promise;
  }

  /** Resolves once every event recorded so far has been written (tests, shutdown). */
  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private summary(event: AuditEvent) {
    return {
      action: event.action,
      username: event.user?.username ?? event.username ?? '',
      share: event.share ?? null,
      path: event.path ?? null,
      target: event.target ?? null,
      outcome: event.outcome,
      ip: event.ip ?? null,
      ...(event.detail ? { detail: event.detail } : {}),
    };
  }

  private async write(event: AuditEvent): Promise<void> {
    const summary = this.summary(event);
    if (!this.prisma) {
      this.log.info({ audit: summary }, 'audit');
      return;
    }
    const userId = event.user ? await this.userId(event.user) : null;
    await this.prisma.auditLog.create({
      data: {
        userId,
        username: summary.username,
        action: summary.action,
        share: summary.share,
        path: summary.path,
        target: summary.target,
        success: event.outcome === 'success',
        ip: summary.ip,
        details: event.detail as Prisma.InputJsonValue | undefined,
      },
    });
  }

  private async userId(user: User): Promise<string | null> {
    const cached = this.userIds.get(user.id);
    if (cached) return cached;
    try {
      const row = await this.prisma!.user.findFirst({
        where: { provider: user.provider, username: user.username },
        select: { id: true },
        orderBy: { lastLoginAt: 'desc' },
      });
      if (!row) return null;
      if (this.userIds.size >= MAX_CACHED_USERS) this.userIds.clear();
      this.userIds.set(user.id, row.id);
      return row.id;
    } catch {
      // The event is still worth keeping without the relation.
      return null;
    }
  }
}
