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

Ver [CONTRIBUTING.md](CONTRIBUTING.md) para el flujo de ramas, PRs y propiedad de directorios.
