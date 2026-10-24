# Contribuir

El proyecto se construye con un agente orquestador y subagentes que trabajan en paralelo. Estas reglas evitan que se pisen entre sí y mantienen `main` siempre desplegable (Coolify despliega `main`).

## Ramas

- Una rama y un PR por agente y tarea. Nombre: `cursor/<fase>-<area>-1d0c` (por ejemplo `cursor/f1-auth-1d0c`). Las personas pueden usar `feat/<tema>` o `fix/<tema>`.
- Las ramas salen de `main` actualizado y viven poco. Cada subagente trabaja en su propio `git worktree`.
- Los cambios en `packages/contracts` van en su propia rama (`cursor/contracts-<cambio>-1d0c`) y se mergean antes que el código que los usa.
- Mientras una fase anterior no esté en `main`, la rama nueva se apila sobre la rama de esa fase y su PR apunta a ella. Cuando la base se mergea, GitHub retarget a `main`.

## Propiedad de directorios

| Responsable           | Directorios                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orquestador           | `packages/contracts/`, archivos raíz, `pnpm-lock.yaml`, `Dockerfile`, `docker-compose.yml`, `.github/`, `apps/api/src/app.ts`, `apps/api/src/config.ts`, `apps/api/src/lib/`, `apps/web/src/api/` |
| Auth                  | `apps/api/src/auth/`, `apps/web/src/features/auth/`                                                                                                                                               |
| Storage/ACL           | `apps/api/src/storage/`, `apps/api/src/acl/`, `apps/api/src/files/`                                                                                                                               |
| UI Explorer           | `apps/web/src/components/explorer/`, `apps/web/src/stores/`, `apps/web/src/mocks/`                                                                                                                |
| Previews              | `apps/api/src/preview/`, `apps/web/src/components/preview/`                                                                                                                                       |
| Operaciones avanzadas | `apps/api/src/jobs/`, `apps/api/src/trash/`, `apps/api/src/uploads/`                                                                                                                              |
| Seguridad/QA          | `apps/api/src/audit/`, `apps/api/test/security/`                                                                                                                                                  |
| DevOps                | `deploy/`                                                                                                                                                                                         |

Si un agente necesita tocar algo fuera de su área (una dependencia nueva, una variable de entorno, un campo del contrato), lo indica en la descripción del PR y el orquestador lo integra.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat(auth): ldap bind`, `fix(storage): realpath check`, `test(acl): denied delete`, `chore(ci): cache pnpm`. Un commit por cambio lógico.

## Pull requests

- Se abren como borrador mientras se trabajan y pasan a revisión cuando la CI está en verde.
- Usan la plantilla `.github/PULL_REQUEST_TEMPLATE.md` y declaran dependencias con otros PRs.
- Se mergean con **squash**, después de rebase sobre `main`.
- El merge lo aprueba y ejecuta el responsable del repositorio.

## Protección de `main` (configurar en GitHub)

Settings → Branches → Add rule para `main`:

- Require a pull request before merging (1 aprobación).
- Require status checks: `lint, typecheck, unit tests`, `docker image`, `e2e (playwright)`.
- Require branches to be up to date before merging.
- Allow squash merging only; Do not allow bypassing.

## Tags y despliegue

Al cerrar cada fase se crea un tag `v0.<fase>.0` sobre `main`. Coolify despliega automáticamente `main` (webhook) y crea previews por PR. Ver `deploy/COOLIFY.md`.

## Comandos

```bash
pnpm install
docker compose -f deploy/docker-compose.dev.yml up -d   # postgres, redis, openldap
cp .env.example .env
pnpm dev                                                  # api :3000, web :5173
pnpm lint && pnpm typecheck && pnpm test
```
