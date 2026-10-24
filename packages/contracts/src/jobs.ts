import { z } from 'zod';
import { TransferItemResult } from './files.js';

export const JobStatus = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type JobStatus = z.infer<typeof JobStatus>;

export const Job = z.object({
  id: z.string(),
  kind: z.enum(['copy', 'move']),
  status: JobStatus,
  totalBytes: z.number().int().nonnegative(),
  doneBytes: z.number().int().nonnegative(),
  totalItems: z.number().int().nonnegative(),
  doneItems: z.number().int().nonnegative(),
  currentItem: z.string().nullable(),
  results: z.array(TransferItemResult),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Job = z.infer<typeof Job>;

/*
 * GET  /api/jobs              -> JobsResponse (jobs of the current user)
 * GET  /api/jobs/:id          -> JobResponse
 * GET  /api/jobs/:id/events   -> text/event-stream, each `data:` line is a Job
 * POST /api/jobs/:id/cancel   -> JobResponse
 */
export const JobResponse = z.object({ job: Job });
export type JobResponse = z.infer<typeof JobResponse>;

export const JobsResponse = z.object({ jobs: z.array(Job) });
export type JobsResponse = z.infer<typeof JobsResponse>;
