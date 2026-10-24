# Advanced operations module (`wfb-ops`)

Registered after `wfb-files`; sets `app.files.trash` and `app.files.jobs` and decorates `app.jobs`,
`app.trash`, `app.uploads`.

- `jobs/` — `JobManager` (in memory, per user, finished jobs kept 1 h) and `TransferJobs`. Copy/move whose
  sources exceed `SYNC_TRANSFER_LIMIT_MB` or 1000 entries (bounded walk; same-device moves count as free)
  return `{ mode: 'job' }`. Files are streamed into hidden `.wfb-upload-*.tmp` files with byte counting;
  cancel stops between chunks and removes the partial temp file and the partially copied item.
  `GET /jobs/:id/events` is SSE: current state, throttled updates (~4/s), heartbeat comment every 15 s,
  final state, then the stream ends.
- `trash/` — `<shareRoot>/<TRASH_DIR_NAME>/<id>/{item,meta.json}`. The trash of a share is shared by every
  user entitled to act on it, whoever deleted the item (`deletedBy` is informative): list needs read + (write
  or delete), restore needs read + write (parents recreated, name conflicts become "name (1)"), purge needs
  read + delete. Read is always required so write-only drop boxes never reveal deleted names. Entries older
  than 30 days are purged on access.
- `search/` — breadth-first, case/accent-insensitive substring match on names; skips the trash, temp files
  and escaping symlinks (symlinks are never traversed). Limits: depth 20, 50k entries, 3 s, `limit` results
  → `truncated: true`.
- `uploads/` — state in `services.kv` (`upload:<id>`, TTL 24 h), data in `<DATA_DIR>/uploads/<id>.part`.
  `PUT /uploads/:id?offset=N` takes a raw `application/octet-stream` body of at most 8 MiB; a wrong offset is
  409 with `details.offset`. Completion re-checks permissions and applies the conflict strategy. Only the
  owner sees an upload (404 otherwise). Orphan `.part` files are removed hourly.
