# wfb — Web File Browser

Explorador de archivos web con estilo Explorador de Windows. Autentica con LDAP, Active Directory u OIDC (Authentik), muestra las carpetas públicas y las habilitadas para cada usuario o grupo, y permite copiar, pegar, mover, renombrar, eliminar, subir, descargar y previsualizar archivos.

## Estructura

| Ruta                 | Contenido                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`           | API Fastify (TypeScript). Sirve también el build de la web.                                                                |
| `apps/web`           | Interfaz React + Vite.                                                                                                     |
| `packages/contracts` | Esquemas Zod del API, fuente de verdad entre api, web y e2e. `pnpm --filter @wfb/contracts openapi` genera `openapi.json`. |
| `config/`            | Definición de shares (`shares.example.yaml`).                                                                              |
| `deploy/`            | Compose de desarrollo y E2E, LDIF de prueba, blueprint de Authentik y guía de Coolify.                                     |
| `docker-compose.yml` | Stack de producción para Coolify.                                                                                          |

## Desarrollo rápido

```bash
pnpm install
docker compose -f deploy/docker-compose.dev.yml up -d
cp .env.example .env
pnpm dev
```

Usuarios LDAP de prueba: `alice/alice123` (staff, engineering), `bob/bob123` (staff, engineering), `carol/carol123` (staff, finance).

## Despliegue

Producción se despliega con **Coolify** (build pack Docker Compose) usando `docker-compose.yml` y el `Dockerfile` de la raíz: una imagen Node 22 sin root (API + web), Postgres 16 y Redis 7, con healthchecks y migraciones automáticas al arrancar.

- [deploy/COOLIFY.md](deploy/COOLIFY.md): paso a paso en Coolify (dominio, variables, carpetas compartidas y `shares.yaml`, PUID/PGID, autodeploy, backups de Postgres, actualizaciones y rollback, solución de problemas).
- [docs/identity.md](docs/identity.md): OpenLDAP, Active Directory (UPN, grupos anidados, LDAPS) y Authentik OIDC, y cómo mapear grupos a las ACL de `shares.yaml`.
- [deploy/coolify.env.example](deploy/coolify.env.example): plantilla de variables para pegar en Coolify.

```bash
docker build -t wfb .                                              # imagen por defecto
docker build --build-arg INSTALL_LIBREOFFICE=true -t wfb:office .  # con previsualización de Office
```

Los logs de producción son JSON (pino) con `reqId` por petición (respeta `x-request-id`) y redacción de cookies, tokens y contraseñas; nivel con `LOG_LEVEL`.

Ver [CONTRIBUTING.md](CONTRIBUTING.md) para el flujo de ramas, PRs y propiedad de directorios.
