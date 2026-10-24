import { API_PREFIX, FileRef, type ApiError, type PreviewInfoResponse } from '@wfb/contracts';
import { http, HttpResponse, type HttpHandler } from 'msw';
import * as store from './db';
import { MockError, type MockFile } from './db';

/** Preview endpoints for dev:mock and tests. Seeded binaries are filler, so images/PDFs are generated. */

const url = (path: string) => `*${API_PREFIX}${path}`;
const MAX_TEXT = 1024 * 1024;

const LANGUAGES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', json: 'json', py: 'python', md: 'markdown',
  html: 'xml', css: 'css', yaml: 'yaml', yml: 'yaml', sh: 'bash', sql: 'sql', go: 'go', rs: 'rust',
}; // prettier-ignore

const ext = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

export function mockPreviewKind(f: Pick<MockFile, 'name' | 'mime'>): PreviewInfoResponse['kind'] {
  const mime = f.mime ?? '';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('application/vnd.openxml')) return 'office';
  if (/^(text\/|application\/(json|yaml))/.test(mime) || ext(f.name) in LANGUAGES) return 'text';
  return 'none';
}

function placeholderSvg(name: string): string {
  let hash = 0;
  for (const c of name) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const label = name.replace(/[<>&"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue} 70% 62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360} 70% 42%)"/>
</linearGradient></defs>
<rect width="640" height="420" fill="url(#g)"/>
<circle cx="500" cy="110" r="52" fill="#fff" opacity=".55"/>
<path d="M0 420 L200 210 L330 330 L430 250 L640 420 Z" fill="#000" opacity=".25"/>
<text x="32" y="390" font-family="Segoe UI, sans-serif" font-size="26" fill="#fff">${label}</text>
</svg>`;
}

/** Tiny valid single-page PDF with a title line. */
function samplePdf(title: string): Uint8Array {
  const text = title.replace(/[()\\]/g, '').replace(/[^\x20-\x7e]/g, '?');
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj 0 -40 Td /F1 12 Tf (Documento de ejemplo generado por el modo mock.) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function guarded(fn: (request: Request) => Response): (info: { request: Request }) => Response {
  return ({ request }) => {
    try {
      if (!store.db.loggedIn) throw new MockError(401, 'UNAUTHENTICATED', 'Sesión no iniciada');
      return fn(request);
    } catch (e) {
      const err = e instanceof MockError ? e : new MockError(400, 'BAD_REQUEST', String(e));
      return HttpResponse.json<ApiError>(
        { error: { code: err.code, message: err.message } },
        { status: err.status },
      );
    }
  };
}

function readRef(request: Request) {
  const r = FileRef.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!r.success) throw new MockError(400, 'BAD_REQUEST', 'Solicitud no válida');
  return r.data;
}

const unsupported = (message: string) =>
  HttpResponse.json<ApiError>({ error: { code: 'BAD_REQUEST', message } }, { status: 415 });

export const previewHandlers: HttpHandler[] = [
  http.get(
    url('/preview/info'),
    guarded((request) => {
      const ref = readRef(request);
      const entry = store.stat(ref);
      if (entry.type !== 'file') return HttpResponse.json({ kind: 'none', mime: null, contentUrl: null });
      const kind = mockPreviewKind(entry);
      const body: PreviewInfoResponse = {
        kind,
        mime: entry.mime,
        contentUrl:
          kind === 'none'
            ? null
            : `${API_PREFIX}/preview/content?${new URLSearchParams({ share: ref.share, path: entry.path })}`,
        ...(kind === 'text'
          ? { truncated: entry.size > MAX_TEXT, language: LANGUAGES[ext(entry.name)] ?? 'plaintext' }
          : {}),
      };
      return HttpResponse.json(body);
    }),
  ),
  http.get(
    url('/preview/thumbnail'),
    guarded((request) => {
      const f = store.readFile(readRef(request));
      if (mockPreviewKind(f) !== 'image') return unsupported('Sin miniatura para este tipo de archivo');
      return new HttpResponse(placeholderSvg(f.name), { headers: { 'content-type': 'image/svg+xml' } });
    }),
  ),
  http.get(
    url('/preview/content'),
    guarded((request) => {
      const f = store.readFile(readRef(request));
      switch (mockPreviewKind(f)) {
        case 'text': {
          if (f.content.includes(0)) return unsupported('Archivo binario');
          return new HttpResponse(f.content.slice(0, MAX_TEXT), {
            headers: {
              'content-type': 'text/plain; charset=utf-8',
              'x-preview-truncated': String(f.content.byteLength > MAX_TEXT),
            },
          });
        }
        case 'image':
          return new HttpResponse(placeholderSvg(f.name), { headers: { 'content-type': 'image/svg+xml' } });
        case 'pdf':
        case 'office':
          return new HttpResponse(samplePdf(f.name), { headers: { 'content-type': 'application/pdf' } });
        case 'audio':
        case 'video':
          return new HttpResponse(f.content, { headers: { 'content-type': f.mime ?? '' } });
        default:
          return unsupported('No hay vista previa disponible');
      }
    }),
  ),
];
