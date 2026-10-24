import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import * as auth from './auth.js';
import * as common from './common.js';
import * as files from './files.js';
import * as jobs from './jobs.js';
import * as preview from './preview.js';

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path relative to API_PREFIX, Fastify style params (":id"). */
  path: string;
  summary: string;
  auth: boolean;
  query?: ZodTypeAny;
  body?: ZodTypeAny;
  /** Undefined for binary / streaming responses. */
  response?: ZodTypeAny;
  produces?: string;
}

/** Single source of truth for the HTTP API shared by api, web and e2e. */
export const routes = {
  health: {
    method: 'GET',
    path: '/healthz',
    summary: 'Health check',
    auth: false,
    response: common.HealthResponse,
  },

  authProviders: {
    method: 'GET',
    path: '/auth/providers',
    summary: 'Enabled login methods',
    auth: false,
    response: auth.AuthProvidersResponse,
  },
  directoryLogin: {
    method: 'POST',
    path: '/auth/ldap/login',
    summary: 'Login with LDAP / Active Directory credentials',
    auth: false,
    body: auth.DirectoryLoginRequest,
    response: auth.MeResponse,
  },
  oidcLogin: {
    method: 'GET',
    path: '/auth/oidc/login',
    summary: 'Redirect to the OIDC provider (Authentik)',
    auth: false,
    query: z.object({ returnTo: z.string().optional() }),
  },
  oidcCallback: {
    method: 'GET',
    path: '/auth/oidc/callback',
    summary: 'OIDC redirect URI',
    auth: false,
  },
  logout: {
    method: 'POST',
    path: '/auth/logout',
    summary: 'Logout (redirectUrl: IdP end-session URL for OIDC sessions)',
    auth: true,
    response: auth.LogoutResponse,
  },
  me: { method: 'GET', path: '/auth/me', summary: 'Current user', auth: true, response: auth.MeResponse },

  shares: {
    method: 'GET',
    path: '/shares',
    summary: 'Visible shares',
    auth: true,
    response: files.SharesResponse,
  },
  list: {
    method: 'GET',
    path: '/files',
    summary: 'List a directory',
    auth: true,
    query: files.ListQuery,
    response: files.ListResponse,
  },
  stat: {
    method: 'GET',
    path: '/files/stat',
    summary: 'Stat an entry',
    auth: true,
    query: files.FileRef,
    response: files.StatResponse,
  },
  mkdir: {
    method: 'POST',
    path: '/files/mkdir',
    summary: 'Create a folder',
    auth: true,
    body: files.MkdirRequest,
    response: files.EntryResponse,
  },
  rename: {
    method: 'POST',
    path: '/files/rename',
    summary: 'Rename an entry',
    auth: true,
    body: files.RenameRequest,
    response: files.EntryResponse,
  },
  copy: {
    method: 'POST',
    path: '/files/copy',
    summary: 'Copy entries',
    auth: true,
    body: files.TransferRequest,
    response: files.TransferResponse,
  },
  move: {
    method: 'POST',
    path: '/files/move',
    summary: 'Move entries',
    auth: true,
    body: files.TransferRequest,
    response: files.TransferResponse,
  },
  delete: {
    method: 'POST',
    path: '/files/delete',
    summary: 'Delete entries (trash by default)',
    auth: true,
    body: files.DeleteRequest,
    response: files.DeleteResponse,
  },
  upload: {
    method: 'POST',
    path: '/files/upload',
    summary: 'Multipart upload of small files',
    auth: true,
    query: files.UploadQuery,
    response: files.UploadResponse,
  },
  download: {
    method: 'GET',
    path: '/files/download',
    summary: 'Download a file (Range supported)',
    auth: true,
    query: files.DownloadQuery,
    produces: 'application/octet-stream',
  },
  search: {
    method: 'GET',
    path: '/search',
    summary: 'Recursive name search',
    auth: true,
    query: files.SearchQuery,
    response: files.SearchResponse,
  },

  createUpload: {
    method: 'POST',
    path: '/uploads',
    summary: 'Start a resumable upload',
    auth: true,
    body: files.CreateUploadRequest,
    response: files.UploadSession,
  },
  getUpload: {
    method: 'GET',
    path: '/uploads/:id',
    summary: 'Upload status',
    auth: true,
    response: files.UploadSession,
  },
  putUploadChunk: {
    method: 'PUT',
    path: '/uploads/:id',
    summary: 'Append a chunk at ?offset=',
    auth: true,
    query: z.object({ offset: z.coerce.number().int().nonnegative() }),
    response: files.UploadSession,
  },
  completeUpload: {
    method: 'POST',
    path: '/uploads/:id/complete',
    summary: 'Finish upload',
    auth: true,
    response: files.EntryResponse,
  },
  abortUpload: {
    method: 'DELETE',
    path: '/uploads/:id',
    summary: 'Abort upload',
    auth: true,
    response: common.OkResponse,
  },

  trashList: {
    method: 'GET',
    path: '/trash',
    summary: 'Trash content of a share',
    auth: true,
    query: z.object({ share: z.string() }),
    response: files.TrashListResponse,
  },
  trashRestore: {
    method: 'POST',
    path: '/trash/restore',
    summary: 'Restore trashed items',
    auth: true,
    body: files.TrashActionRequest,
    response: common.OkResponse,
  },
  trashPurge: {
    method: 'POST',
    path: '/trash/purge',
    summary: 'Permanently delete trashed items',
    auth: true,
    body: files.TrashActionRequest,
    response: common.OkResponse,
  },

  previewInfo: {
    method: 'GET',
    path: '/preview/info',
    summary: 'How to preview an entry',
    auth: true,
    query: preview.PreviewInfoQuery,
    response: preview.PreviewInfoResponse,
  },
  thumbnail: {
    method: 'GET',
    path: '/preview/thumbnail',
    summary: 'Thumbnail (image/webp)',
    auth: true,
    query: preview.ThumbnailQuery,
    produces: 'image/webp',
  },
  previewContent: {
    method: 'GET',
    path: '/preview/content',
    summary: 'Renderable content',
    auth: true,
    query: preview.PreviewContentQuery,
    produces: '*/*',
  },

  jobs: { method: 'GET', path: '/jobs', summary: 'My jobs', auth: true, response: jobs.JobsResponse },
  job: { method: 'GET', path: '/jobs/:id', summary: 'Job status', auth: true, response: jobs.JobResponse },
  jobEvents: {
    method: 'GET',
    path: '/jobs/:id/events',
    summary: 'Job progress (SSE)',
    auth: true,
    produces: 'text/event-stream',
  },
  jobCancel: {
    method: 'POST',
    path: '/jobs/:id/cancel',
    summary: 'Cancel a job',
    auth: true,
    response: jobs.JobResponse,
  },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof routes;
