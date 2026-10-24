import {
  API_PREFIX,
  ApiError,
  CSRF_HEADER,
  type AuthProvidersResponse,
  type CreateUploadRequest,
  type DeleteRequest,
  type DeleteResponse,
  type DirectoryLoginRequest,
  type EntryResponse,
  type FileRef,
  type JobResponse,
  type JobsResponse,
  type ListResponse,
  type MeResponse,
  type MkdirRequest,
  type OkResponse,
  type RenameRequest,
  type SearchQuery,
  type SearchResponse,
  type SharesResponse,
  type TransferRequest,
  type TransferResponse,
  type TrashActionRequest,
  type TrashListResponse,
  type UploadResponse,
  type UploadSession,
} from '@wfb/contracts';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when any request returns 401 (e.g. session expired). */
export function setUnauthenticatedHandler(handler: (() => void) | null): void {
  onUnauthenticated = handler;
}

type Query = Record<string, string | number | boolean | undefined>;

export function apiUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return `${API_PREFIX}${path}${qs ? `?${qs}` : ''}`;
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  opts: { query?: Query; body?: unknown; raw?: BodyInit; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers[CSRF_HEADER] = csrfToken;

  const res = await fetch(apiUrl(path, opts.query), {
    method,
    headers,
    credentials: 'same-origin',
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    signal: opts.signal,
  });

  if (res.status === 401 && onUnauthenticated && !path.startsWith('/auth/')) onUnauthenticated();
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const parsed = ApiError.safeParse(data);
    if (parsed.success) {
      const { code, message, details } = parsed.data.error;
      throw new ApiRequestError(res.status, code, message, details);
    }
    throw new ApiRequestError(res.status, 'INTERNAL', res.statusText || 'Request failed');
  }
  return data as T;
}

const ref = (r: FileRef) => ({ share: r.share, path: r.path });

/** Typed wrappers over the contract routes (see @wfb/contracts routes.ts). */
export const api = {
  providers: () => request<AuthProvidersResponse>('GET', '/auth/providers'),
  login: (body: DirectoryLoginRequest) => request<MeResponse>('POST', '/auth/ldap/login', { body }),
  oidcLoginUrl: (returnTo?: string) => apiUrl('/auth/oidc/login', { returnTo }),
  logout: () => request<OkResponse>('POST', '/auth/logout'),
  me: () => request<MeResponse>('GET', '/auth/me'),

  shares: () => request<SharesResponse>('GET', '/shares'),
  list: (r: FileRef) => request<ListResponse>('GET', '/files', { query: ref(r) }),
  mkdir: (body: MkdirRequest) => request<EntryResponse>('POST', '/files/mkdir', { body }),
  rename: (body: RenameRequest) => request<EntryResponse>('POST', '/files/rename', { body }),
  copy: (body: TransferRequest) => request<TransferResponse>('POST', '/files/copy', { body }),
  move: (body: TransferRequest) => request<TransferResponse>('POST', '/files/move', { body }),
  remove: (body: DeleteRequest) => request<DeleteResponse>('POST', '/files/delete', { body }),
  upload: (r: FileRef, files: File[], conflict: TransferRequest['conflict'] = 'fail') => {
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    return request<UploadResponse>('POST', '/files/upload', { query: { ...ref(r), conflict }, raw: form });
  },
  downloadUrl: (r: FileRef, inline = false) =>
    apiUrl('/files/download', { ...ref(r), inline: inline || undefined }),

  jobs: () => request<JobsResponse>('GET', '/jobs'),
  job: (id: string) => request<JobResponse>('GET', `/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => request<JobResponse>('POST', `/jobs/${encodeURIComponent(id)}/cancel`),
  /** SSE stream of Job updates (same-origin cookies). */
  jobEventsUrl: (id: string) => apiUrl(`/jobs/${encodeURIComponent(id)}/events`),

  search: (q: SearchQuery, signal?: AbortSignal) =>
    request<SearchResponse>('GET', '/search', {
      query: { share: q.share, path: q.path, q: q.q, limit: q.limit },
      signal,
    }),

  trash: (share: string) => request<TrashListResponse>('GET', '/trash', { query: { share } }),
  restoreTrash: (body: TrashActionRequest) => request<OkResponse>('POST', '/trash/restore', { body }),
  purgeTrash: (body: TrashActionRequest) => request<OkResponse>('POST', '/trash/purge', { body }),

  createUpload: (body: CreateUploadRequest) => request<UploadSession>('POST', '/uploads', { body }),
  uploadStatus: (id: string) => request<UploadSession>('GET', `/uploads/${encodeURIComponent(id)}`),
  uploadChunk: (id: string, offset: number, chunk: Blob, signal?: AbortSignal) =>
    request<UploadSession>('PUT', `/uploads/${encodeURIComponent(id)}`, {
      query: { offset },
      // The Blob type becomes the request content type.
      raw: new Blob([chunk], { type: 'application/octet-stream' }),
      signal,
    }),
  completeUpload: (id: string) =>
    request<EntryResponse>('POST', `/uploads/${encodeURIComponent(id)}/complete`),
  abortUpload: (id: string) => request<OkResponse>('DELETE', `/uploads/${encodeURIComponent(id)}`),
};
