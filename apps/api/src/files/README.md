# Files module (`wfb-files`)

Shares (ACL), safe local storage and the `/api/shares` + `/api/files/*` routes.

- `src/acl/` — shares YAML loader (`SHARES_CONFIG`, reloaded every 2 s, last good config kept on errors) and `ShareService`.
- `src/storage/` — `StorageProvider` interface, `LocalStorageProvider`, `FileEntry` mapping (mime, previewable, sort).
- `src/files/` — `FilesService`, routes, range downloads and multipart uploads.

## Decorators for other modules

The plugin is wrapped with `fastify-plugin`, so these decorators are available on the root instance
(register your module after `wfb-files`):

```ts
app.shares: ShareService
  listForUser(user: User): Share[]
  get(user: User, shareId: string): Promise<ResolvedShare>            // 404 when not visible
  assert(user: User, shareId: string, perm: Permission): Promise<ResolvedShare> // + 403

app.resolveRef(user: User, ref: FileRef, perm: Permission): Promise<ResolvedRef>

interface ResolvedRef {
  shareId: string;
  share: ResolvedShare;        // id, name, description, visibility, path (abs root), permissions
  provider: StorageProvider;   // rooted at the share, takes virtual paths
  absPath: string;             // symlinks resolved, verified inside the share
  virtualPath: string;         // normalized ("/a/b.txt", "/" for the root)
}

app.files: FilesService
  resolveRef(user, ref, perm): Promise<ResolvedRef>
  toEntry(share: ResolvedShare, info: EntryInfo): FileEntry
  list(user, ref) / stat(user, ref) / mkdir(user, req) / rename(user, req)
  transfer(kind: 'copy' | 'move', user, req): Promise<TransferItemResult[]>
  delete(user, req): Promise<DeleteResponse>
  trash: TrashHandler | null   // set by the trash module; used when delete.permanent is false
```

`TrashHandler` is `{ trash(user: User, ref: ResolvedRef): Promise<void> }`. While it is `null`, deletes are
permanent and report `deleted`; once set, non-permanent deletes call it and report `trashed`.

Prefer `ref.provider` methods (`createReadStream`, `stat`, `list`...) over raw `fs` on `absPath`: they keep
every access inside the share. If a module needs `absPath` (e.g. `soffice`, `sharp`), use it only for reads
and only right after `resolveRef`.

## Path safety

- Virtual paths are normalized again (`..` → 400).
- The deepest existing ancestor is `realpath`ed and must be inside `realpath(shareRoot)`; escaping symlinks
  give 403, dangling symlinks cannot be traversed, and escaping/dangling links are omitted from listings.
- Rename/move/delete act on the entry itself (a symlink is renamed/removed, not its target) and refuse the
  share root (400).
- The trash folder (`TRASH_DIR_NAME`, case-insensitive) and in-flight upload temp files
  (`.wfb-upload-<hex>.tmp`) are hidden, unreachable (404) and reserved as names (400). Dotfiles are shown.

## Error details

- Copy/move with `conflict: 'fail'` where every item conflicts → 409 with
  `details.conflicts: [{ name, source: FileRef, target: FileRef }]`. Mixed results → 200 with per-item
  `failed` / `error: 'exists'`. Other per-item errors: `not_found`, `forbidden`, or a message.
- Upload with `conflict: 'fail'` on an existing name → 409 with `details.conflicts: [{ name }]`. Files
  stored before the conflicting one are kept.
- Upload over `MAX_UPLOAD_MB` → 413 `PAYLOAD_TOO_LARGE`; the partial file is never committed.
