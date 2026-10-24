# Audit module (`wfb-audit`)

Registered before every other module; decorates `app.audit` and `request.audit`.

- `app.audit.record({ action, user, username?, share, path, target?, outcome, ip, detail? })` writes one
  `AuditLog` row (`success = outcome === 'success'`, `detail` → `details`). `userId` links to the `User` row
  persisted at login (looked up by provider + username, cached). Without `DATABASE_URL` events are only
  logged (`msg: "audit"`). A failing write is logged as a warning and never fails the request; `record`
  never rejects. `flush()` waits for pending writes.
- Routes set `request.audit = { action, share, path, target?, detail?, items? }` once the input is parsed.
  When the response is sent, a 4xx/5xx becomes one `failure` event (`details.status`, `details.error` =
  error code); a success becomes one event per `items` entry (multi-item operations) or a single event.
  `skip: true` hands recording over to the route (copy/move jobs record each item when the job ends).
- Recorded actions: `login` (LDAP/AD and OIDC, success and failure including rate limiting), `logout`,
  `mkdir`, `rename`, `copy`, `move`, `delete`, `upload` (multipart and resumable completion),
  `trash.restore`, `trash.purge`. Reads are not audited. `target` is `share:/path` for copy/move and the new
  path for rename.
- `ip` is `request.ip`, which honours `X-Forwarded-For` (Fastify `trustProxy`).
