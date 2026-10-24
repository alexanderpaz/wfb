import type { Job } from '@wfb/contracts';
import { api } from '../../api/client';

export interface JobStreamHandlers {
  onJob: (job: Job) => void;
  onError: (error: unknown) => void;
}

/** Starts following a job; returns a function that stops it. */
export type JobStreamFactory = (id: string, handlers: JobStreamHandlers) => () => void;

export const isFinished = (job: Job) =>
  job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';

const POLL_MS = 1000;

/** Parses `data:` payloads out of a text/event-stream buffer; returns the unconsumed rest. */
export function parseSse(buffer: string, onData: (data: string) => void): string {
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) onData(data);
  }
  return rest;
}

/**
 * Default strategy: EventSource when available, a streaming fetch otherwise
 * (jsdom, old browsers), and polling GET /jobs/:id when the stream breaks.
 */
const defaultFactory: JobStreamFactory = (id, handlers) => {
  let stopped = false;
  let finished = false;
  let cleanup = () => {};

  const deliver = (job: Job) => {
    if (stopped || finished) return;
    if (isFinished(job)) finished = true;
    handlers.onJob(job);
    if (finished) cleanup();
  };

  const poll = () => {
    if (stopped || finished) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        deliver((await api.job(id)).job);
        if (!finished && !stopped) timer = setTimeout(() => void tick(), POLL_MS);
      } catch (e) {
        if (!stopped) handlers.onError(e);
      }
    };
    cleanup = () => clearTimeout(timer);
    void tick();
  };

  const onData = (data: string) => {
    try {
      deliver(JSON.parse(data) as Job);
    } catch {
      // Ignore malformed events.
    }
  };

  if (typeof EventSource !== 'undefined') {
    const es = new EventSource(api.jobEventsUrl(id));
    cleanup = () => es.close();
    es.onmessage = (e: MessageEvent<string>) => onData(e.data);
    es.onerror = () => {
      // The browser retries on its own while CONNECTING; CLOSED means it gave up.
      if (es.readyState === EventSource.CLOSED || finished) {
        es.close();
        poll();
      }
    };
  } else {
    const controller = new AbortController();
    cleanup = () => controller.abort();
    void (async () => {
      try {
        const res = await fetch(api.jobEventsUrl(id), {
          credentials: 'same-origin',
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer = parseSse(buffer + decoder.decode(value, { stream: true }), onData);
        }
      } catch {
        // Fall through to polling.
      }
      poll();
    })();
  }

  return () => {
    stopped = true;
    cleanup();
  };
};

let factory: JobStreamFactory = defaultFactory;

/** Test hook: replace how job updates are received (null restores the default). */
export function setJobStreamFactory(f: JobStreamFactory | null): void {
  factory = f ?? defaultFactory;
}

export function watchJob(id: string, handlers: JobStreamHandlers): () => void {
  return factory(id, handlers);
}
