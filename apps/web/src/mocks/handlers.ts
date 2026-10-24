import {
  API_PREFIX,
  CreateUploadRequest,
  DeleteRequest,
  DirectoryLoginRequest,
  DownloadQuery,
  FileRef,
  ListQuery,
  MkdirRequest,
  RenameRequest,
  SearchQuery,
  TransferRequest,
  TrashActionRequest,
  UploadQuery,
  type ApiError,
  type AuthProvidersResponse,
  type Job,
  type MeResponse,
} from '@wfb/contracts';
import { http, HttpResponse, delay, type HttpHandler } from 'msw';
import * as store from './db';
import { MockError } from './db';

/** MSW handlers implementing the contract in memory (see `./db`). */

/** Origin-agnostic so the same handlers work in the browser, jsdom and plain node. */
const url = (path: string) => `*${API_PREFIX}${path}`;

function errorResponse(status: number, code: ApiError['error']['code'], message: string, details?: unknown) {
  return HttpResponse.json<ApiError>({ error: { code, message, details } }, { status });
}

interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } };
}

function parse<T>(schema: Schema<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new MockError(400, 'BAD_REQUEST', 'Solicitud no válida', r.error.flatten());
  return r.data;
}

function query(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

async function json(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new MockError(400, 'BAD_REQUEST', 'El cuerpo debe ser JSON');
  }
}

/** Small artificial latency in the browser so loading states are visible; none in tests. */
const latency = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator ? delay(150) : undefined;

type Resolver = (info: {
  request: Request;
  params: Record<string, string | readonly string[] | undefined>;
}) => Promise<Response> | Response;

function guarded(fn: Resolver, auth = true): Resolver {
  return async (info) => {
    await latency();
    try {
      if (auth && !store.db.loggedIn) throw new MockError(401, 'UNAUTHENTICATED', 'Sesión no iniciada');
      return await fn(info);
    } catch (e) {
      if (e instanceof MockError) return errorResponse(e.status, e.code, e.message, e.details);
      return errorResponse(500, 'INTERNAL', e instanceof Error ? e.message : 'Error interno');
    }
  };
}

function transferResponse(kind: 'copy' | 'move', b: ReturnType<typeof TransferRequest.parse>) {
  if (store.transferSize(b.items) > store.db.jobSettings.syncLimitBytes) {
    const job = store.startJob(kind, b.items, b.destination, b.conflict);
    return HttpResponse.json({ mode: 'job', jobId: job.id });
  }
  return HttpResponse.json({
    mode: 'sync',
    results: store.transfer(kind, b.items, b.destination, b.conflict),
  });
}

const encoder = new TextEncoder();

/** text/event-stream of Job snapshots, closed when the job finishes. */
function jobEvents(id: string): Response {
  const first = store.getJob(id);
  const done = (job: Job) =>
    job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';
  let unsubscribe = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (job: Job) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(job)}\n\n`));
      send(first);
      if (done(first)) return controller.close();
      unsubscribe = store.subscribeJob(id, (job) => {
        send(job);
        if (done(job)) {
          unsubscribe();
          controller.close();
        }
      });
    },
    cancel() {
      unsubscribe();
    },
  });
  return new HttpResponse(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

const param = (params: Record<string, string | readonly string[] | undefined>, key: string) =>
  String(params[key] ?? '');

const me = (): MeResponse => ({ user: store.db.user, csrfToken: 'mock-csrf-token' });

export const handlers: HttpHandler[] = [
  http.get(
    url('/auth/providers'),
    guarded(
      () =>
        HttpResponse.json<AuthProvidersResponse>({
          directory: { kind: 'ldap', label: 'Directorio corporativo' },
          oidc: null,
        }),
      false,
    ),
  ),
  http.get(
    url('/auth/me'),
    guarded(() => HttpResponse.json(me())),
  ),
  http.post(
    url('/auth/ldap/login'),
    guarded(async ({ request }) => {
      const body = parse(DirectoryLoginRequest, await json(request));
      if (body.password === 'incorrecta')
        throw new MockError(401, 'UNAUTHENTICATED', 'Credenciales no válidas');
      store.db.loggedIn = true;
      store.db.user = { ...store.db.user, username: body.username };
      return HttpResponse.json(me());
    }, false),
  ),
  http.post(
    url('/auth/logout'),
    guarded(() => {
      store.db.loggedIn = false;
      return HttpResponse.json({ ok: true });
    }),
  ),

  http.get(
    url('/shares'),
    guarded(() => HttpResponse.json({ shares: store.listShares() })),
  ),
  http.get(
    url('/files'),
    guarded(({ request }) => {
      const q = parse(ListQuery, query(request));
      return HttpResponse.json({ share: q.share, path: q.path, entries: store.list(q) });
    }),
  ),
  http.get(
    url('/files/stat'),
    guarded(({ request }) => HttpResponse.json({ entry: store.stat(parse(FileRef, query(request))) })),
  ),
  http.post(
    url('/files/mkdir'),
    guarded(async ({ request }) => {
      const b = parse(MkdirRequest, await json(request));
      return HttpResponse.json({ entry: store.mkdir(b, b.name) }, { status: 201 });
    }),
  ),
  http.post(
    url('/files/rename'),
    guarded(async ({ request }) => {
      const b = parse(RenameRequest, await json(request));
      return HttpResponse.json({ entry: store.rename(b, b.newName) });
    }),
  ),
  http.post(
    url('/files/copy'),
    guarded(async ({ request }) => transferResponse('copy', parse(TransferRequest, await json(request)))),
  ),
  http.post(
    url('/files/move'),
    guarded(async ({ request }) => transferResponse('move', parse(TransferRequest, await json(request)))),
  ),
  http.post(
    url('/files/delete'),
    guarded(async ({ request }) => {
      const b = parse(DeleteRequest, await json(request));
      return HttpResponse.json({ results: store.remove(b.items, b.permanent) });
    }),
  ),
  http.post(
    url('/files/upload'),
    guarded(async ({ request }) => {
      const q = parse(UploadQuery, query(request));
      let form: FormData;
      try {
        form = await request.formData();
      } catch {
        throw new MockError(400, 'BAD_REQUEST', 'Se esperaba multipart/form-data');
      }
      const files = form.getAll('file').filter((f): f is File => typeof f !== 'string');
      if (files.length === 0) throw new MockError(400, 'BAD_REQUEST', 'No se ha enviado ningún archivo');
      const payload = await Promise.all(
        files.map(async (f) => ({
          name: f.name,
          type: f.type,
          content: new Uint8Array(await f.arrayBuffer()),
        })),
      );
      return HttpResponse.json({ entries: store.upload(q, payload, q.conflict) }, { status: 201 });
    }),
  ),
  http.get(
    url('/files/download'),
    guarded(({ request }) => {
      const q = parse(DownloadQuery, query(request));
      const f = store.readFile(q);
      return new HttpResponse(f.content, {
        headers: {
          'content-type': f.mime ?? 'application/octet-stream',
          'content-disposition': `${q.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        },
      });
    }),
  ),

  http.get(
    url('/search'),
    guarded(({ request }) => {
      const q = parse(SearchQuery, query(request));
      return HttpResponse.json(store.search(q, q.q, q.limit));
    }),
  ),

  http.get(
    url('/trash'),
    guarded(({ request }) => {
      const share = query(request).share;
      if (!share) throw new MockError(400, 'BAD_REQUEST', 'Falta el recurso compartido');
      return HttpResponse.json({ items: store.trashList(share) });
    }),
  ),
  http.post(
    url('/trash/restore'),
    guarded(async ({ request }) => {
      const b = parse(TrashActionRequest, await json(request));
      store.trashRestore(b.share, b.ids);
      return HttpResponse.json({ ok: true });
    }),
  ),
  http.post(
    url('/trash/purge'),
    guarded(async ({ request }) => {
      const b = parse(TrashActionRequest, await json(request));
      store.trashPurge(b.share, b.ids);
      return HttpResponse.json({ ok: true });
    }),
  ),

  http.get(
    url('/jobs'),
    guarded(() => HttpResponse.json({ jobs: store.listJobs() })),
  ),
  http.get(
    url('/jobs/:id'),
    guarded(({ params }) => HttpResponse.json({ job: store.getJob(param(params, 'id')) })),
  ),
  http.get(
    url('/jobs/:id/events'),
    guarded(({ params }) => jobEvents(param(params, 'id'))),
  ),
  http.post(
    url('/jobs/:id/cancel'),
    guarded(({ params }) => HttpResponse.json({ job: store.cancelJob(param(params, 'id')) })),
  ),

  http.post(
    url('/uploads'),
    guarded(async ({ request }) => {
      const b = parse(CreateUploadRequest, await json(request));
      return HttpResponse.json(store.createUpload(b, b.name, b.size, b.conflict), { status: 201 });
    }),
  ),
  http.get(
    url('/uploads/:id'),
    guarded(({ params }) => HttpResponse.json(store.uploadStatus(param(params, 'id')))),
  ),
  http.put(
    url('/uploads/:id'),
    guarded(async ({ request, params }) => {
      const offset = Number(query(request).offset);
      if (!Number.isInteger(offset) || offset < 0)
        throw new MockError(400, 'BAD_REQUEST', 'offset no válido');
      const data = new Uint8Array(await request.arrayBuffer());
      return HttpResponse.json(store.appendUpload(param(params, 'id'), offset, data));
    }),
  ),
  http.post(
    url('/uploads/:id/complete'),
    guarded(({ params }) => HttpResponse.json({ entry: store.completeUpload(param(params, 'id')) })),
  ),
  http.delete(
    url('/uploads/:id'),
    guarded(({ params }) => {
      store.abortUpload(param(params, 'id'));
      return HttpResponse.json({ ok: true });
    }),
  ),
];
