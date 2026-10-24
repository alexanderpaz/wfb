import type { Job, TransferItemResult } from '@wfb/contracts';
import { randomUUID } from 'node:crypto';
import { notFound } from '../lib/errors.js';

export interface JobContext {
  signal: AbortSignal;
  update(patch: Partial<Pick<Job, 'doneBytes' | 'doneItems' | 'currentItem' | 'totalBytes'>>): void;
  addResult(result: TransferItemResult): void;
}

export type JobRunner = (ctx: JobContext) => Promise<void>;

interface JobRecord {
  job: Job;
  owner: string;
  abort: AbortController;
  listeners: Set<(job: Job) => void>;
  done: Promise<void>;
  finishedAt: number | null;
}

export interface JobManagerOptions {
  /** How long finished jobs stay queryable. */
  retentionMs?: number;
  sweepIntervalMs?: number;
}

const TERMINAL = new Set<Job['status']>(['completed', 'failed', 'cancelled']);
export const isTerminal = (job: Job) => TERMINAL.has(job.status);

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
  }
}

/** In-process background jobs, owned by a user and kept in memory for a while after they finish. */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly retentionMs: number;
  private timer: NodeJS.Timeout | null;

  constructor(opts: JobManagerOptions = {}) {
    this.retentionMs = opts.retentionMs ?? 60 * 60 * 1000;
    this.timer = setInterval(() => this.sweep(), opts.sweepIntervalMs ?? 5 * 60 * 1000);
    this.timer.unref();
  }

  start(
    owner: string,
    init: Pick<Job, 'kind' | 'totalBytes' | 'totalItems'>,
    run: JobRunner,
  ): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      kind: init.kind,
      status: 'queued',
      totalBytes: init.totalBytes,
      doneBytes: 0,
      totalItems: init.totalItems,
      doneItems: 0,
      currentItem: null,
      results: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    const record: JobRecord = {
      job,
      owner,
      abort: new AbortController(),
      listeners: new Set(),
      done: Promise.resolve(),
      finishedAt: null,
    };
    this.jobs.set(job.id, record);

    const emit = () => {
      record.job.updatedAt = new Date().toISOString();
      const snapshot = this.snapshot(record);
      for (const l of record.listeners) l(snapshot);
    };
    const ctx: JobContext = {
      signal: record.abort.signal,
      update: (patch) => {
        Object.assign(record.job, patch);
        emit();
      },
      addResult: (result) => {
        record.job.results.push(result);
        emit();
      },
    };

    record.done = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        if (record.abort.signal.aborted) throw new CancelledError();
        record.job.status = 'running';
        emit();
        await run(ctx);
        record.job.status = 'completed';
      })
      .catch((err: unknown) => {
        if (record.abort.signal.aborted || err instanceof CancelledError) {
          record.job.status = 'cancelled';
        } else {
          record.job.status = 'failed';
          record.job.error = (err as Error)?.message ?? 'failed';
        }
      })
      .finally(() => {
        record.job.currentItem = null;
        record.finishedAt = Date.now();
        emit();
        record.listeners.clear();
      });
    return this.snapshot(record);
  }

  private snapshot(record: JobRecord): Job {
    return { ...record.job, results: [...record.job.results] };
  }

  private record(owner: string, id: string): JobRecord {
    const record = this.jobs.get(id);
    if (!record || record.owner !== owner) throw notFound('Job not found');
    return record;
  }

  get(owner: string, id: string): Job {
    return this.snapshot(this.record(owner, id));
  }

  list(owner: string): Job[] {
    return [...this.jobs.values()]
      .filter((r) => r.owner === owner)
      .map((r) => this.snapshot(r))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Requests cancellation and waits (bounded) for the runner to stop. */
  async cancel(owner: string, id: string, waitMs = 5000): Promise<Job> {
    const record = this.record(owner, id);
    if (!isTerminal(record.job)) {
      record.abort.abort();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        record.done,
        new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs))),
      ]);
      clearTimeout(timer);
    }
    return this.snapshot(record);
  }

  /** Calls `listener` with every update until the job finishes. Returns an unsubscribe function. */
  subscribe(owner: string, id: string, listener: (job: Job) => void): () => void {
    const record = this.record(owner, id);
    if (isTerminal(record.job)) return () => {};
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  listenerCount(id: string): number {
    return this.jobs.get(id)?.listeners.size ?? 0;
  }

  /** Resolves when the job has finished (for tests and shutdown). */
  async wait(id: string): Promise<void> {
    await this.jobs.get(id)?.done;
  }

  sweep(now = Date.now()): void {
    for (const [id, r] of this.jobs) {
      if (r.finishedAt !== null && now - r.finishedAt > this.retentionMs) this.jobs.delete(id);
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const pending = [...this.jobs.values()].filter((r) => !isTerminal(r.job));
    for (const r of pending) r.abort.abort();
    await Promise.all(pending.map((r) => r.done));
  }
}
