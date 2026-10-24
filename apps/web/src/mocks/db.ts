import {
  basename,
  dirname,
  joinPath,
  pathSegments,
  type ConflictStrategy,
  type FileEntry,
  type FileRef,
  type Job,
  type Permission,
  type Share,
  type TransferItemResult,
  type TrashItem,
  type UploadSession,
  type User,
} from '@wfb/contracts';

/** In-memory file system used by the MSW handlers (dev:mock and tests). */

export interface MockFile {
  type: 'file';
  name: string;
  modifiedAt: string;
  mime: string | null;
  content: Uint8Array;
}

export interface MockDir {
  type: 'directory';
  name: string;
  modifiedAt: string;
  children: Map<string, MockNode>;
}

export type MockNode = MockFile | MockDir;

export interface MockShare {
  share: Share;
  root: MockDir;
}

export interface MockTrashEntry {
  item: TrashItem;
  node: MockNode;
}

export interface MockJob {
  job: Job;
  listeners: Set<(job: Job) => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface MockUpload {
  id: string;
  dest: FileRef;
  name: string;
  size: number;
  conflict: ConflictStrategy;
  chunks: Uint8Array[];
  offset: number;
}

export interface MockDb {
  shares: Map<string, MockShare>;
  user: User;
  loggedIn: boolean;
  trash: Map<string, MockTrashEntry[]>;
  jobs: Map<string, MockJob>;
  uploads: Map<string, MockUpload>;
  /** Copy/move above `syncLimitBytes` become jobs advancing `bytesPerTick` every `tickMs`. */
  jobSettings: { syncLimitBytes: number; bytesPerTick: number; tickMs: number };
  uploadChunkSize: number;
}

export class MockError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'UNAUTHENTICATED',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  py: 'text/x-python',
  html: 'text/html',
  css: 'text/css',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const PREVIEWABLE =
  /^(image\/|text\/|audio\/|video\/|application\/(pdf|json|yaml)|application\/vnd\.openxml)/;

export function mimeFor(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return MIME[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

const encoder = new TextEncoder();

function file(name: string, sizeOrText: number | string, modifiedAt: string): MockFile {
  const content =
    typeof sizeOrText === 'string' ? encoder.encode(sizeOrText) : new Uint8Array(sizeOrText).fill(32);
  return { type: 'file', name, modifiedAt, mime: mimeFor(name), content };
}

function dir(name: string, modifiedAt: string, children: MockNode[] = []): MockDir {
  return { type: 'directory', name, modifiedAt, children: new Map(children.map((c) => [c.name, c])) };
}

const d = (iso: string) => new Date(iso).toISOString();

function seed(): MockShare[] {
  return [
    {
      share: {
        id: 'public',
        name: 'Público',
        description: 'Documentos visibles para todos',
        visibility: 'public',
        permissions: ['read'],
      },
      root: dir('', d('2026-09-01T09:00:00Z'), [
        dir('Manuales', d('2026-08-12T10:30:00Z'), [
          file('Manual de bienvenida.pdf', 1_843_200, d('2026-08-12T10:30:00Z')),
          file('Normativa interna.docx', 356_000, d('2026-07-03T08:15:00Z')),
        ]),
        dir('Plantillas', d('2026-06-20T12:00:00Z'), [
          file('Presentación corporativa.pptx', 4_200_000, d('2026-06-20T12:00:00Z')),
          file('Hoja de gastos.xlsx', 48_200, d('2026-05-11T16:40:00Z')),
        ]),
        file('Calendario 2026.pdf', 512_000, d('2026-01-02T09:00:00Z')),
        file('Logo.png', 24_576, d('2026-03-14T11:20:00Z')),
        file('LEEME.txt', 'Bienvenido al espacio público.\n', d('2026-09-01T09:00:00Z')),
      ]),
    },
    {
      share: {
        id: 'engineering',
        name: 'Ingeniería',
        description: 'Proyectos del equipo de ingeniería',
        visibility: 'private',
        permissions: ['read', 'write', 'delete'],
      },
      root: dir('', d('2026-10-20T09:00:00Z'), [
        dir('Proyectos', d('2026-10-18T14:00:00Z'), [
          dir('Alfa', d('2026-10-18T14:00:00Z'), [
            dir('src', d('2026-10-18T14:00:00Z'), [
              file('index.ts', "export const hello = 'mundo';\n", d('2026-10-18T14:00:00Z')),
              file('app.py', 'print("hola")\n', d('2026-10-17T10:00:00Z')),
            ]),
            file('README.md', '# Proyecto Alfa\n', d('2026-10-15T09:12:00Z')),
            file('arquitectura.png', 312_000, d('2026-10-10T17:45:00Z')),
          ]),
          dir('Beta', d('2026-09-30T08:00:00Z'), [
            file('requisitos.docx', 88_000, d('2026-09-30T08:00:00Z')),
          ]),
        ]),
        dir('Documentación', d('2026-10-01T11:00:00Z'), [
          file('Especificación.pdf', 2_516_582, d('2026-10-01T11:00:00Z')),
          file('Presupuesto.xlsx', 74_000, d('2026-09-21T15:30:00Z')),
        ]),
        dir('Multimedia', d('2026-08-05T13:00:00Z'), [
          file('demo.mp4', 15_728_640, d('2026-08-05T13:00:00Z')),
          file('podcast.mp3', 5_242_880, d('2026-08-04T13:00:00Z')),
          file('foto-equipo.jpg', 1_048_576, d('2026-08-03T13:00:00Z')),
        ]),
        dir('Vacía', d('2026-07-01T10:00:00Z')),
        file('notas.txt', 'Reunión del lunes: revisar el backlog.\n', d('2026-10-20T09:00:00Z')),
        file('config.json', '{\n  "debug": true\n}\n', d('2026-10-19T18:00:00Z')),
        file('backup.zip', 7_340_032, d('2026-10-02T22:00:00Z')),
        file('diagrama.svg', 9_800, d('2026-09-12T12:00:00Z')),
      ]),
    },
    {
      share: {
        id: 'home',
        name: 'Mi carpeta',
        description: 'Carpeta personal',
        visibility: 'home',
        permissions: ['read', 'write', 'delete'],
      },
      root: dir('', d('2026-10-22T09:00:00Z'), [
        dir('Descargas', d('2026-10-22T09:00:00Z')),
        dir('Imágenes', d('2026-10-21T09:00:00Z'), [
          file('vacaciones.jpg', 2_400_000, d('2026-08-15T19:00:00Z')),
        ]),
        file('Currículum.pdf', 230_000, d('2026-04-10T10:00:00Z')),
        file('tareas.md', '- [ ] Revisar correo\n', d('2026-10-22T09:00:00Z')),
      ]),
    },
  ];
}

export function createMockDb(): MockDb {
  return {
    shares: new Map(seed().map((s) => [s.share.id, s])),
    user: {
      id: 'u-1',
      username: 'ana',
      displayName: 'Ana García',
      email: 'ana@example.com',
      groups: ['engineering', 'staff'],
      provider: 'ldap',
    },
    loggedIn: true,
    trash: new Map(),
    jobs: new Map(),
    uploads: new Map(),
    jobSettings: { syncLimitBytes: 10 * 1024 * 1024, bytesPerTick: 2 * 1024 * 1024, tickMs: 200 },
    uploadChunkSize: 8 * 1024 * 1024,
  };
}

export let db: MockDb = createMockDb();

/** Restores the seeded state (call between tests). */
export function resetMockDb(): MockDb {
  for (const j of db.jobs.values()) if (j.timer) clearTimeout(j.timer);
  db = createMockDb();
  return db;
}

// ---------------------------------------------------------------------------

function getShare(id: string, need?: Permission): MockShare {
  const s = db.shares.get(id);
  if (!s) throw new MockError(404, 'NOT_FOUND', `No existe el recurso compartido "${id}"`);
  if (need && !s.share.permissions.includes(need)) {
    throw new MockError(403, 'FORBIDDEN', 'No tiene permisos para realizar esta operación');
  }
  return s;
}

function findNode(root: MockDir, path: string): MockNode | null {
  let node: MockNode = root;
  for (const seg of pathSegments(path)) {
    if (node.type !== 'directory') return null;
    const next: MockNode | undefined = node.children.get(seg);
    if (!next) return null;
    node = next;
  }
  return node;
}

function resolve(ref: FileRef, need?: Permission): MockNode {
  const node = findNode(getShare(ref.share, need).root, ref.path);
  if (!node) throw new MockError(404, 'NOT_FOUND', `No se encuentra "${ref.path}"`);
  return node;
}

function resolveDir(ref: FileRef, need?: Permission): MockDir {
  const node = resolve(ref, need);
  if (node.type !== 'directory') throw new MockError(400, 'BAD_REQUEST', `"${ref.path}" no es una carpeta`);
  return node;
}

function sizeOf(node: MockNode): number {
  return node.type === 'file' ? node.content.byteLength : 0;
}

export function toEntry(node: MockNode, path: string): FileEntry {
  const mime = node.type === 'file' ? node.mime : null;
  return {
    name: node.name,
    path,
    type: node.type,
    size: sizeOf(node),
    modifiedAt: node.modifiedAt,
    mime,
    previewable: !!mime && PREVIEWABLE.test(mime),
  };
}

function clone(node: MockNode, name = node.name): MockNode {
  const modifiedAt = new Date().toISOString();
  if (node.type === 'file') return { ...node, name, modifiedAt, content: node.content.slice() };
  return {
    type: 'directory',
    name,
    modifiedAt,
    children: new Map([...node.children.values()].map((c) => [c.name, clone(c)])),
  };
}

export function uniqueName(parent: MockDir, name: string): string {
  if (!parent.children.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!parent.children.has(candidate)) return candidate;
  }
}

function touch(d: MockDir) {
  d.modifiedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------

export function listShares(): Share[] {
  return [...db.shares.values()].map((s) => s.share);
}

export function list(ref: FileRef): FileEntry[] {
  const d = resolveDir(ref, 'read');
  return [...d.children.values()].map((c) => toEntry(c, joinPath(ref.path, c.name)));
}

export function stat(ref: FileRef): FileEntry {
  return toEntry(resolve(ref, 'read'), ref.path);
}

export function mkdir(ref: FileRef, name: string): FileEntry {
  const parent = resolveDir(ref, 'write');
  if (parent.children.has(name)) {
    throw new MockError(409, 'CONFLICT', `Ya existe un elemento llamado "${name}"`);
  }
  const node = dir(name, new Date().toISOString());
  parent.children.set(name, node);
  touch(parent);
  return toEntry(node, joinPath(ref.path, name));
}

export function rename(ref: FileRef, newName: string): FileEntry {
  if (ref.path === '/') throw new MockError(400, 'BAD_REQUEST', 'No se puede renombrar la raíz');
  const node = resolve(ref, 'write');
  const parent = resolveDir({ share: ref.share, path: dirname(ref.path) });
  const target = joinPath(dirname(ref.path), newName);
  if (newName === node.name) return toEntry(node, target);
  const existing = parent.children.get(newName);
  // Case-only renames are allowed on the same node.
  if (existing && existing !== node) {
    throw new MockError(409, 'CONFLICT', `Ya existe un elemento llamado "${newName}"`);
  }
  parent.children.delete(node.name);
  node.name = newName;
  node.modifiedAt = new Date().toISOString();
  parent.children.set(newName, node);
  touch(parent);
  return toEntry(node, target);
}

export function transfer(
  kind: 'copy' | 'move',
  items: FileRef[],
  destination: FileRef,
  conflict: ConflictStrategy,
): TransferItemResult[] {
  const dest = resolveDir(destination, 'write');

  const conflicts = items.filter((item) => {
    const node = findNode(getShare(item.share).root, item.path);
    if (!node) return false;
    const sameParent = item.share === destination.share && dirname(item.path) === destination.path;
    if (kind === 'move' && sameParent) return false;
    return dest.children.has(node.name);
  });
  if (conflict === 'fail' && conflicts.length > 0 && conflicts.length === items.length) {
    throw new MockError(
      409,
      'CONFLICT',
      conflicts.length === 1
        ? `El destino ya contiene un elemento llamado "${basename(conflicts[0]!.path)}"`
        : `El destino ya contiene ${conflicts.length} elementos con el mismo nombre`,
      { conflicts },
    );
  }

  return items.map((source): TransferItemResult => {
    const fail = (error: string): TransferItemResult => ({ source, status: 'failed', target: null, error });
    try {
      const share = getShare(source.share, kind === 'move' ? 'delete' : 'read');
      const node = findNode(share.root, source.path);
      if (!node || source.path === '/') return fail('No se encuentra el elemento de origen');
      const sameShare = source.share === destination.share;
      if (
        node.type === 'directory' &&
        sameShare &&
        (destination.path === source.path || destination.path.startsWith(source.path + '/'))
      ) {
        return fail('La carpeta de destino es una subcarpeta de la carpeta de origen');
      }
      const srcParent = findNode(share.root, dirname(source.path)) as MockDir;
      if (kind === 'move' && srcParent === dest) {
        return { source, status: 'skipped', target: source, error: null };
      }

      let name = node.name;
      const existing = dest.children.get(name);
      if (existing) {
        if (conflict === 'fail') return fail(`Ya existe "${name}" en el destino`);
        if (conflict === 'skip') return { source, status: 'skipped', target: null, error: null };
        if (conflict === 'rename') name = uniqueName(dest, name);
        if (conflict === 'overwrite') {
          if (existing === node) return { source, status: 'skipped', target: source, error: null };
          dest.children.delete(name);
        }
      }

      if (kind === 'copy') {
        dest.children.set(name, clone(node, name));
      } else {
        srcParent.children.delete(node.name);
        touch(srcParent);
        node.name = name;
        dest.children.set(name, node);
      }
      touch(dest);
      return {
        source,
        status: 'done',
        target: { share: destination.share, path: joinPath(destination.path, name) },
        error: null,
      };
    } catch (e) {
      return fail(e instanceof Error ? e.message : 'Error desconocido');
    }
  });
}

export function remove(items: FileRef[], permanent: boolean) {
  return items.map((source) => {
    try {
      if (source.path === '/') throw new MockError(400, 'BAD_REQUEST', 'No se puede eliminar la raíz');
      const share = getShare(source.share, 'delete');
      const node = findNode(share.root, source.path);
      if (!node) throw new MockError(404, 'NOT_FOUND', 'No se encuentra el elemento');
      const parent = findNode(share.root, dirname(source.path)) as MockDir;
      parent.children.delete(node.name);
      touch(parent);
      if (!permanent) {
        const list = db.trash.get(source.share) ?? [];
        list.unshift({
          node,
          item: {
            id: `t${++seq}`,
            share: source.share,
            originalPath: source.path,
            name: node.name,
            type: node.type,
            size: treeSize(node),
            deletedAt: new Date().toISOString(),
            deletedBy: db.user.username,
          },
        });
        db.trash.set(source.share, list);
      }
      return { source, status: permanent ? ('deleted' as const) : ('trashed' as const), error: null };
    } catch (e) {
      return { source, status: 'failed' as const, error: e instanceof Error ? e.message : 'Error' };
    }
  });
}

export function upload(
  ref: FileRef,
  files: { name: string; content: Uint8Array; type: string }[],
  conflict: ConflictStrategy,
): FileEntry[] {
  const parent = resolveDir(ref, 'write');
  const conflicts = files.filter((f) => parent.children.has(f.name));
  if (conflict === 'fail' && conflicts.length > 0 && conflicts.length === files.length) {
    throw new MockError(409, 'CONFLICT', 'Ya existen archivos con el mismo nombre en el destino', {
      conflicts: conflicts.map((f) => ({ share: ref.share, path: joinPath(ref.path, f.name) })),
    });
  }
  const entries: FileEntry[] = [];
  for (const f of files) {
    let name = f.name;
    if (parent.children.has(name)) {
      if (conflict === 'fail' || conflict === 'skip') continue;
      if (conflict === 'rename') name = uniqueName(parent, name);
    }
    const node: MockFile = {
      type: 'file',
      name,
      modifiedAt: new Date().toISOString(),
      mime: f.type || mimeFor(name),
      content: f.content,
    };
    parent.children.set(name, node);
    entries.push(toEntry(node, joinPath(ref.path, name)));
  }
  touch(parent);
  return entries;
}

export function readFile(ref: FileRef): MockFile {
  const node = resolve(ref, 'read');
  if (node.type !== 'file') throw new MockError(400, 'BAD_REQUEST', 'No es un archivo');
  return node;
}

// ---------------------------------------------------------------------------
// Trash, search, jobs and resumable uploads.

let seq = 0;

function treeSize(node: MockNode): number {
  if (node.type === 'file') return node.content.byteLength;
  let n = 0;
  for (const c of node.children.values()) n += treeSize(c);
  return n;
}

export function trashList(share: string): TrashItem[] {
  const s = getShare(share, 'read');
  if (!s.share.permissions.includes('write')) getShare(share, 'delete');
  return (db.trash.get(share) ?? []).map((e) => e.item);
}

function trashEntries(share: string, ids: string[]): MockTrashEntry[] {
  const list = db.trash.get(share) ?? [];
  return ids.map((id) => {
    const e = list.find((x) => x.item.id === id);
    if (!e) throw new MockError(404, 'NOT_FOUND', 'No se encuentra el elemento en la papelera');
    return e;
  });
}

export function trashRestore(share: string, ids: string[]): void {
  const s = getShare(share, 'write');
  for (const e of trashEntries(share, ids)) {
    let parent: MockDir = s.root;
    for (const seg of pathSegments(dirname(e.item.originalPath))) {
      let next = parent.children.get(seg);
      if (!next) {
        next = dir(seg, new Date().toISOString());
        parent.children.set(seg, next);
      }
      if (next.type !== 'directory') throw new MockError(409, 'CONFLICT', `"${seg}" no es una carpeta`);
      parent = next;
    }
    e.node.name = uniqueName(parent, e.item.name);
    parent.children.set(e.node.name, e.node);
    touch(parent);
    db.trash.set(
      share,
      (db.trash.get(share) ?? []).filter((x) => x !== e),
    );
  }
}

export function trashPurge(share: string, ids: string[]): void {
  getShare(share, 'delete');
  const drop = new Set(ids);
  db.trash.set(
    share,
    (db.trash.get(share) ?? []).filter((x) => !drop.has(x.item.id)),
  );
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function search(ref: FileRef, q: string, limit: number): { results: FileEntry[]; truncated: boolean } {
  const start = resolveDir(ref, 'read');
  const needle = fold(q);
  const results: FileEntry[] = [];
  let level: { node: MockDir; path: string }[] = [{ node: start, path: ref.path }];
  while (level.length) {
    const next: typeof level = [];
    for (const { node, path } of level) {
      for (const child of node.children.values()) {
        const childPath = joinPath(path, child.name);
        if (fold(child.name).includes(needle)) {
          if (results.length >= limit) return { results, truncated: true };
          results.push(toEntry(child, childPath));
        }
        if (child.type === 'directory') next.push({ node: child, path: childPath });
      }
    }
    level = next;
  }
  return { results, truncated: false };
}

export function transferSize(items: FileRef[]): number {
  let n = 0;
  for (const item of items) {
    const node = findNode(getShare(item.share).root, item.path);
    if (node) n += treeSize(node);
  }
  return n;
}

/** Same upfront 409 as the server when every item conflicts with "fail". */
function assertNotAllConflicting(
  kind: 'copy' | 'move',
  items: FileRef[],
  destination: FileRef,
  conflict: ConflictStrategy,
) {
  if (conflict !== 'fail') return;
  const dest = resolveDir(destination, 'write');
  const conflicts = items.filter((item) => {
    const node = findNode(getShare(item.share).root, item.path);
    const sameParent = item.share === destination.share && dirname(item.path) === destination.path;
    return !!node && !(kind === 'move' && sameParent) && dest.children.has(node.name);
  });
  if (conflicts.length > 0 && conflicts.length === items.length) {
    throw new MockError(409, 'CONFLICT', 'El destino ya contiene elementos con el mismo nombre', {
      conflicts,
    });
  }
}

const isDone = (job: Job) =>
  job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled';

function emit(j: MockJob) {
  j.job = { ...j.job, updatedAt: new Date().toISOString() };
  for (const l of j.listeners) l(j.job);
  if (isDone(j.job)) j.listeners.clear();
}

/** Starts a simulated background copy/move that applies the change when the progress reaches 100 %. */
export function startJob(
  kind: 'copy' | 'move',
  items: FileRef[],
  destination: FileRef,
  conflict: ConflictStrategy,
): Job {
  resolveDir(destination, 'write');
  for (const item of items) getShare(item.share, kind === 'move' ? 'delete' : 'read');
  assertNotAllConflicting(kind, items, destination, conflict);
  const sizes = items.map((i) => transferSize([i]));
  const total = sizes.reduce((a, b) => a + b, 0);
  const now = new Date().toISOString();
  const j: MockJob = {
    job: {
      id: `job-${++seq}`,
      kind,
      status: 'running',
      totalBytes: total,
      doneBytes: 0,
      totalItems: items.length,
      doneItems: 0,
      currentItem: items[0]?.path ?? null,
      results: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    },
    listeners: new Set(),
    timer: null,
  };
  db.jobs.set(j.job.id, j);
  const tick = () => {
    j.timer = null;
    if (isDone(j.job)) return;
    const doneBytes = Math.min(total, j.job.doneBytes + db.jobSettings.bytesPerTick);
    let acc = 0;
    let doneItems = 0;
    for (const size of sizes) {
      if (acc + size > doneBytes) break;
      acc += size;
      doneItems++;
    }
    if (doneBytes >= total) {
      let results: TransferItemResult[];
      try {
        results = transfer(kind, items, destination, conflict);
      } catch (e) {
        results = items.map((source) => ({
          source,
          status: 'failed',
          target: null,
          error: e instanceof Error ? e.message : 'Error',
        }));
      }
      j.job = {
        ...j.job,
        status: 'completed',
        doneBytes: total,
        doneItems: items.length,
        currentItem: null,
        results,
      };
    } else {
      j.job = { ...j.job, doneBytes, doneItems, currentItem: items[doneItems]?.path ?? null };
      j.timer = setTimeout(tick, db.jobSettings.tickMs);
    }
    emit(j);
  };
  j.timer = setTimeout(tick, db.jobSettings.tickMs);
  return j.job;
}

function mockJob(id: string): MockJob {
  const j = db.jobs.get(id);
  if (!j) throw new MockError(404, 'NOT_FOUND', 'No se encuentra la operación');
  return j;
}

export const getJob = (id: string): Job => mockJob(id).job;
export const listJobs = (): Job[] => [...db.jobs.values()].map((j) => j.job);

export function cancelJob(id: string): Job {
  const j = mockJob(id);
  if (!isDone(j.job)) {
    if (j.timer) clearTimeout(j.timer);
    j.timer = null;
    j.job = { ...j.job, status: 'cancelled', currentItem: null };
    emit(j);
  }
  return j.job;
}

/** Calls `fn` on every update until the job finishes; returns an unsubscribe function. */
export function subscribeJob(id: string, fn: (job: Job) => void): () => void {
  const j = mockJob(id);
  if (isDone(j.job)) return () => {};
  j.listeners.add(fn);
  return () => j.listeners.delete(fn);
}

const session = (u: MockUpload): UploadSession => ({
  id: u.id,
  size: u.size,
  offset: u.offset,
  chunkSize: db.uploadChunkSize,
});

export function createUpload(
  ref: FileRef,
  name: string,
  size: number,
  conflict: ConflictStrategy,
): UploadSession {
  const parent = resolveDir(ref, 'write');
  if (conflict === 'fail' && parent.children.has(name)) {
    throw new MockError(409, 'CONFLICT', `Ya existe "${name}" en el destino`, { conflicts: [{ name }] });
  }
  const u: MockUpload = { id: `up-${++seq}`, dest: ref, name, size, conflict, chunks: [], offset: 0 };
  db.uploads.set(u.id, u);
  return session(u);
}

function mockUpload(id: string): MockUpload {
  const u = db.uploads.get(id);
  if (!u) throw new MockError(404, 'NOT_FOUND', 'No se encuentra la subida');
  return u;
}

export const uploadStatus = (id: string) => session(mockUpload(id));

export function appendUpload(id: string, offset: number, data: Uint8Array): UploadSession {
  const u = mockUpload(id);
  if (offset !== u.offset)
    throw new MockError(409, 'CONFLICT', 'Desplazamiento incorrecto', { offset: u.offset });
  if (u.offset + data.byteLength > u.size) {
    throw new MockError(400, 'BAD_REQUEST', 'El fragmento supera el tamaño declarado', { offset: u.offset });
  }
  u.chunks.push(data);
  u.offset += data.byteLength;
  return session(u);
}

export function completeUpload(id: string): FileEntry {
  const u = mockUpload(id);
  if (u.offset !== u.size) {
    throw new MockError(409, 'CONFLICT', 'La subida no está completa', { offset: u.offset, size: u.size });
  }
  const content = new Uint8Array(u.size);
  let at = 0;
  for (const c of u.chunks) {
    content.set(c, at);
    at += c.byteLength;
  }
  const [entry] = upload(u.dest, [{ name: u.name, content, type: '' }], u.conflict);
  db.uploads.delete(id);
  if (!entry) return stat({ share: u.dest.share, path: joinPath(u.dest.path, u.name) });
  return entry;
}

export function abortUpload(id: string): void {
  mockUpload(id);
  db.uploads.delete(id);
}
