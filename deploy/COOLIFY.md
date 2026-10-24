# Despliegue en Coolify

Guía paso a paso para desplegar **wfb** en [Coolify](https://coolify.io) (v4) con el build pack **Docker Compose** a partir del repositorio Git. El stack (`docker-compose.yml` en la raíz) tiene tres servicios:

| Servicio   | Imagen                         | Función                                                                                 |
| ---------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `app`      | construida con el `Dockerfile` | API Fastify + web estática en el puerto interno `3000`. Ejecuta migraciones al iniciar. |
| `postgres` | `postgres:16-alpine`           | Usuarios y metadatos.                                                                   |
| `redis`    | `redis:7-alpine`               | Sesiones, límites de login y estado de subidas.                                         |

No se publica ningún puerto en el host: el proxy de Coolify (Traefik o Caddy) recibe el tráfico HTTPS y lo envía a `app:3000`.

Para identidad (LDAP, Active Directory, Authentik) ver [`docs/identity.md`](../docs/identity.md).

## 1. Preparar el servidor

En el servidor donde Coolify ejecuta los contenedores:

```bash
# Carpeta con las carpetas compartidas (puede ser un disco, un montaje NFS/SMB, etc.)
sudo mkdir -p /srv/fileshares/{public,engineering,finance}

# Carpeta con la configuración de shares (se monta en solo lectura en /config)
sudo mkdir -p /srv/wfb/config
sudo curl -fsSL -o /srv/wfb/config/shares.yaml \
  https://raw.githubusercontent.com/alexanderpaz/wfb/main/config/shares.example.yaml
sudo nano /srv/wfb/config/shares.yaml

# Usuario dueño de los archivos: será PUID/PGID
stat -c '%u:%g %n' /srv/fileshares
```

El contenedor `app` se ejecuta con `user: ${PUID}:${PGID}`. Ese usuario debe poder **leer** las carpetas de los shares (y **escribir** donde las ACL den `write` o `delete`). Lo más simple es que coincida con el dueño de `SHARES_HOST_PATH`:

```bash
sudo chown -R 1000:1000 /srv/fileshares          # o usa el UID/GID que ya tengan
sudo chmod -R u+rwX,g+rwX /srv/fileshares
```

- Si las carpetas pertenecen a varios usuarios, usa un grupo común (`PGID`) con permisos `g+rwX` y `chmod g+s` en los directorios para que lo nuevo herede el grupo.
- Para montajes SMB/CIFS indica `uid=`/`gid=` (o `forceuid`) en `/etc/fstab`; para NFS, que el `PUID` exista con permisos en el servidor NFS (cuidado con `root_squash`).
- `shares.yaml` solo necesita ser legible por `PUID` (`chmod 644`).
- Los volúmenes de datos de la app (`app-data`, `app-thumbs`) funcionan con cualquier `PUID/PGID`.

`shares.yaml` usa rutas **dentro del contenedor**: `SHARES_HOST_PATH` se monta en `/data/shares`, así que `/srv/fileshares/finance` es `path: /data/shares/finance`. Los cambios en `shares.yaml` se recargan solos en unos segundos (si el archivo es inválido se mantiene la configuración anterior y se registra un error en los logs).

Si los shares están en discos distintos, móntalos bajo una única carpeta en el host (`mount --bind /mnt/disco2/finanzas /srv/fileshares/finance`, o en `/etc/fstab`). Los enlaces simbólicos que salen de `/data/shares` no se siguen por seguridad.

## 2. Crear el recurso en Coolify

1. **Projects → (tu proyecto) → (entorno, p. ej. `production`) → + New → Application**.
2. Origen del código:
   - **Private Repository (with GitHub App)**: recomendado. Permite autodeploy en cada push y despliegues de previsualización por PR. Si aún no tienes la GitHub App, créala en **Sources → + Add → GitHub App** y dale acceso al repositorio `alexanderpaz/wfb`.
   - **Public Repository**: pega `https://github.com/alexanderpaz/wfb` (autodeploy mediante webhook manual, ver §6).
3. Rama: `main`. **Build Pack: Docker Compose**.
4. **Base Directory**: `/` · **Docker Compose Location**: `/docker-compose.yml`.
5. Pulsa **Continue**. Coolify lee el compose y muestra los servicios `app`, `postgres` y `redis`.

## 3. Dominio (`SERVICE_FQDN_APP`)

En la configuración de la aplicación, en **Domains for app**, escribe el dominio público **con el puerto interno**:

```
https://archivos.example.com:3000
```

El `:3000` solo le indica al proxy a qué puerto del contenedor enviar el tráfico; los usuarios entran por `https://archivos.example.com` (443). Coolify obtiene el certificado de Let's Encrypt automáticamente (el DNS `A`/`AAAA` debe apuntar al servidor antes de desplegar).

Con ese dominio Coolify rellena `SERVICE_FQDN_APP` y `SERVICE_URL_APP`. La app usa `SERVICE_URL_APP` como URL pública (`APP_URL`) para la cookie `Secure`, la comprobación de `Origin` y el `redirect_uri` de OIDC: `https://archivos.example.com/api/auth/oidc/callback`.

> **Importante:** Coolify toma solo el **primer** dominio de la lista. Borra el dominio autogenerado (`https://app-<uuid>.<wildcard>`) y deja únicamente el tuyo; si dejas ambos (`https://app-xxx…,https://archivos…`) la app usará el autogenerado y Authentik responderá _Redirect URI Error_. Tras cambiar el dominio haz **Redeploy** (un _Restart_ no regenera las variables). Si necesitas varios dominios, fija la URL pública con `PUBLIC_URL=https://archivos.example.com`, que tiene prioridad sobre `SERVICE_URL_APP`.

`postgres` y `redis` no deben tener dominio.

## 4. Variables de entorno

Abre **Environment Variables**. En **Developer view** puedes pegar el bloque de [`deploy/coolify.env.example`](coolify.env.example) y ajustarlo.

### Generadas por Coolify (no las toques)

| Variable                    | Uso                                                         |
| --------------------------- | ----------------------------------------------------------- |
| `SERVICE_FQDN_APP`          | Dominio del servicio `app` (sin esquema).                   |
| `SERVICE_URL_APP`           | URL pública (`https://…`). Se pasa a la app como `APP_URL`. |
| `SERVICE_USER_POSTGRES`     | Usuario de Postgres.                                        |
| `SERVICE_PASSWORD_POSTGRES` | Contraseña de Postgres.                                     |
| `SERVICE_PASSWORD_REDIS`    | Contraseña de Redis.                                        |
| `SERVICE_BASE64_64_SESSION` | `SESSION_SECRET`: firma de las cookies de sesión.           |

Se generan una vez y se mantienen entre despliegues. Si cambias `SERVICE_BASE64_64_SESSION` se cierran todas las sesiones. **No cambies** `SERVICE_PASSWORD_POSTGRES` después del primer despliegue: Postgres solo la aplica al crear el volumen.

### Las defines tú

| Variable                      | Obligatoria | Valor por defecto            | Descripción                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SHARES_HOST_PATH`            | **sí**      | —                            | Carpeta del host con los shares; se monta en `/data/shares`.                                                                                                                                                                                                                                                                                                                                    |
| `SHARES_CONFIG_HOST_DIR`      | **sí**      | —                            | Ruta **absoluta** de la carpeta del host con `shares.yaml`; se monta en `/config` (solo lectura). No uses rutas relativas: Coolify las resuelve en su carpeta de la aplicación (`/data/coolify/applications/<uuid>/`), no en el repositorio, y Docker montaría una carpeta vacía.                                                                                                               |
| `SHARES_CONFIG_FILE`          | no          | `shares.yaml`                | Nombre del archivo dentro de `SHARES_CONFIG_HOST_DIR`.                                                                                                                                                                                                                                                                                                                                          |
| `PUID` / `PGID`               | recomendada | `1000` / `1000`              | Usuario y grupo con los que corre la app (ver §1).                                                                                                                                                                                                                                                                                                                                              |
| `DIRECTORY_KIND`              | no          | `none`                       | `ldap`, `ad` o `none`. Variables `LDAP_*`/`AD_DOMAIN` en `docs/identity.md`.                                                                                                                                                                                                                                                                                                                    |
| `OIDC_ISSUER` …               | no          | vacío                        | Login con Authentik. Variables `OIDC_*` en `docs/identity.md`.                                                                                                                                                                                                                                                                                                                                  |
| `NODE_EXTRA_CA_CERTS`         | no          | vacío                        | CA privada (PEM) para LDAPS o el issuer OIDC, p. ej. `/config/ca.pem`.                                                                                                                                                                                                                                                                                                                          |
| `HOME_ROOT`                   | no          | `home.root` de `shares.yaml` | Raíz de las carpetas personales.                                                                                                                                                                                                                                                                                                                                                                |
| `TZ`                          | no          | `UTC`                        | Zona horaria de logs y backups.                                                                                                                                                                                                                                                                                                                                                                 |
| `LOG_LEVEL`                   | no          | `info`                       | `fatal`, `error`, `warn`, `info`, `debug`, `trace`.                                                                                                                                                                                                                                                                                                                                             |
| `SESSION_TTL_HOURS`           | no          | `12`                         | Duración de la sesión.                                                                                                                                                                                                                                                                                                                                                                          |
| `LOGIN_RATE_LIMIT_PER_MINUTE` | no          | `10`                         | Intentos de login por IP y minuto.                                                                                                                                                                                                                                                                                                                                                              |
| `TRUST_PROXY`                 | no          | `172.16.0.0/12`              | Direcciones/CIDR del proxy cuyo `X-Forwarded-For` se acepta para obtener la IP real del cliente (rate limit y auditoría). Debe cubrir la red Docker de Traefik: `docker network inspect coolify -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'`. Si tus usuarios están en esa misma red LAN, usa la subred exacta. No uses `true` (permite falsificar la IP) ni un número de saltos (se ignora). |
| `PUBLIC_URL`                  | no          | —                            | URL pública explícita (`https://archivos.example.com`, sin puerto ni barra final). Tiene prioridad sobre `SERVICE_URL_APP`; úsala si la app tiene varios dominios o si `SERVICE_URL_APP` no es el dominio público.                                                                                                                                                                              |
| `MAX_UPLOAD_MB`               | no          | `1024`                       | Tamaño máximo de archivo subido.                                                                                                                                                                                                                                                                                                                                                                |
| `SYNC_TRANSFER_LIMIT_MB`      | no          | `50`                         | Copias/movimientos mayores se hacen como tarea en segundo plano.                                                                                                                                                                                                                                                                                                                                |
| `TRASH_DIR_NAME`              | no          | `.wfb-trash`                 | Carpeta de papelera dentro de cada share.                                                                                                                                                                                                                                                                                                                                                       |
| `INSTALL_LIBREOFFICE`         | no          | `false`                      | `true` instala LibreOffice para previsualizar Word/Excel/PowerPoint (imagen ≈ +650 MB).                                                                                                                                                                                                                                                                                                         |
| `POSTGRES_DB`                 | no          | `wfb`                        | Nombre de la base de datos. No cambiar tras el primer despliegue.                                                                                                                                                                                                                                                                                                                               |
| `REDIS_MAXMEMORY`             | no          | `256mb`                      | Memoria máxima de Redis.                                                                                                                                                                                                                                                                                                                                                                        |
| `SHUTDOWN_TIMEOUT_SECONDS`    | no          | `25`                         | Espera a peticiones en curso al parar (menor que el `stop_grace_period` de 30 s).                                                                                                                                                                                                                                                                                                               |

`SHARES_HOST_PATH` y `SHARES_CONFIG_HOST_DIR` son obligatorias: si faltan, el despliegue falla (Docker Compose rechaza un volumen con origen vacío) o la app no arranca. El compose usa `${VAR}` sin `:?` ni valores por defecto porque Coolify solo acepta `${VAR}`, `${VAR}/ruta` o `${VAR:-ruta}` como origen de un volumen.

Bloquea (icono de candado) las contraseñas (`LDAP_BIND_PASSWORD`, `OIDC_CLIENT_SECRET`) para que Coolify no las muestre. No uses comillas alrededor de los valores; marca **Is Literal** en `LDAP_USER_FILTER` si contiene `$`.

## 5. Desplegar

Pulsa **Deploy**. En el primer despliegue Coolify construye la imagen (3–6 min; con LibreOffice bastante más), crea los volúmenes y arranca `postgres` y `redis`; `app` espera a que estén sanos, aplica las migraciones (`prisma migrate deploy`) y arranca.

Comprueba:

- **Logs** del servicio `app`: deben aparecer `All migrations have been successfully applied` y un JSON con `"msg":"wfb api ready"`.
- `https://archivos.example.com/api/healthz` responde `{"status":"ok","checks":{"kv":"ok","db":"ok"}}`.
- Los tres servicios aparecen como `healthy`.

Volúmenes que crea Coolify (con el prefijo del UUID del recurso):

| Volumen            | Contenido                                                  | ¿Respaldar?            |
| ------------------ | ---------------------------------------------------------- | ---------------------- |
| `postgres-data`    | Base de datos.                                             | Sí (con `pg_dump`, §7) |
| `postgres-backups` | Volcados de la tarea de backup.                            | Copiar fuera (§7)      |
| `redis-data`       | Sesiones (AOF).                                            | No                     |
| `app-data`         | Fragmentos de subidas en curso y caché de PDFs de Office.  | No                     |
| `app-thumbs`       | Caché de miniaturas. Se puede borrar en cualquier momento. | No                     |

Los archivos de los usuarios están en `SHARES_HOST_PATH` (y la papelera en `.wfb-trash` dentro de cada share): respáldalos con la herramienta habitual del servidor (restic, borg, snapshots ZFS/Btrfs…).

## 6. Autodeploy en cada push a `main`

**Con la GitHub App** (recomendado): en **Advanced → Auto Deploy** activa la opción. Cada push a `main` despliega. Activa también **Preview Deployments** si quieres un entorno por PR (cada preview levanta su propio Postgres/Redis; los shares del host son compartidos, úsalos con cuidado o apunta las previews a otra carpeta).

**Sin GitHub App** (repositorio público o deploy key):

1. En Coolify: **Webhooks → GitHub**, define un **GitHub Webhook Secret** y copia la URL.
2. En GitHub: **Settings → Webhooks → Add webhook** del repositorio.
   - Payload URL: la URL copiada.
   - Content type: `application/json`.
   - Secret: el mismo secreto.
   - Eventos: **Just the push event**.
3. Haz un push y verifica en **Deployments** que se lanza el despliegue.

Como `main` está protegida (CI obligatoria, ver `CONTRIBUTING.md`), lo que llega a `main` ya pasó lint, tests, el build de la imagen y el smoke test del compose.

Para que la versión aparezca en las etiquetas de la imagen, activa **Advanced → Include Source Commit in Build** (Coolify pasa `SOURCE_COMMIT` al build).

## 7. Copias de seguridad de Postgres

### Opción A: tarea programada con `pg_dump` (incluida)

El servicio `postgres` monta el volumen `postgres-backups` en `/backups`. El comando va completo en la tarea porque Coolify no puede montar archivos del repositorio: traduce `./` a `/data/coolify/applications/<uuid>/`, donde no hay checkout. Los scripts de `deploy/scripts/` hacen lo mismo y sirven para un cron del host (`docker exec -i postgres-<uuid> sh -s < deploy/scripts/pg-backup.sh`).

1. En la aplicación: **Scheduled Tasks → + Add**.
   - Name: `pg-backup`
   - Command (una sola línea):
     ```sh
     mkdir -p /backups && f=/backups/$POSTGRES_DB-$(date -u +%Y%m%dT%H%M%SZ).dump && pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner -f "$f.partial" && mv "$f.partial" "$f" && find /backups -name "*.dump" -mtime +14 -delete && echo "backup written: $f"
     ```
   - Frequency: `0 3 * * *` (todos los días a las 03:00)
   - Container name: `postgres`
2. Ejecútala una vez a mano y revisa su log: `backup written: /backups/wfb-AAAAMMDDTHHMMSSZ.dump`.

Se guardan 14 días (cambia `-mtime +14` para otra retención). Los volcados están en el host en `/var/lib/docker/volumes/<uuid>_postgres-backups/_data`; **cópialos fuera del servidor** (restic/rclone a S3, otro NAS…), por ejemplo con un cron del host:

```bash
rclone sync /var/lib/docker/volumes/<uuid>_postgres-backups/_data s3:mi-bucket/wfb-db
```

### Opción B: backups nativos de Coolify con S3

Las copias programadas de Coolify (pestaña **Backups**, con destino S3) están pensadas para recursos de **base de datos** de Coolify. Si las prefieres:

1. Crea un recurso **+ New → Database → PostgreSQL 16** en el mismo proyecto y configura sus **Backups** (frecuencia, retención y destino S3 en **Settings → S3 Storages**).
2. Elimina el servicio `postgres` del compose en tu fork o rama de despliegue y cambia `DATABASE_URL` del servicio `app` por la URL interna del recurso (Coolify la muestra como _Postgres URL (internal)_). Activa **Connect to Predefined Network** en la aplicación para que vea la base de datos.

### Restaurar

1. Detén solo la app: en Coolify no hay "stop" por servicio, así que desde el servidor:
   ```bash
   docker ps --format '{{.Names}}' | grep -E '^(app|postgres)-'   # nombres reales
   docker stop app-<uuid>
   ```
2. Restaura (borra y recrea los objetos de la base de datos dentro de una transacción):
   ```bash
   docker exec postgres-<uuid> ls /backups
   docker exec postgres-<uuid> sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction /backups/wfb-20260101T030000Z.dump'
   ```
   Para restaurar un volcado traído de fuera: `docker cp wfb.dump postgres-<uuid>:/backups/`.
3. **Restart** de la aplicación en Coolify.

Haz una prueba de restauración de vez en cuando (por ejemplo en un entorno `staging` del mismo proyecto).

## 8. Actualizaciones y rollback

- **Actualizar**: merge a `main` → autodeploy. O **Redeploy** a mano. Con Docker Compose, Coolify sustituye los contenedores (hay unos segundos de corte; la app termina las peticiones en curso al recibir `SIGTERM`). Las migraciones se aplican al arrancar la nueva versión; si fallan (se reintenta 5 veces) la app queda caída hasta que corrijas o hagas rollback.
- **Versión concreta**: en **Configuration → Git**, fija el commit o tag (`v0.4.0`) y despliega.
- **Rollback**: en la pestaña **Rollback** Coolify lista las imágenes anteriores que conserva (**Advanced → Docker Images to keep**); elige una y pulsa _Rollback_. Si tu versión no muestra esa pestaña para Docker Compose, fija el commit anterior y despliega.
- **Migraciones y rollback**: las migraciones son solo hacia delante. Si la versión nueva cambió el esquema y necesitas volver atrás, haz antes un backup (lanza la tarea `pg-backup` a mano antes de desplegar cambios grandes), vuelve a la imagen anterior y restaura ese backup (§7).
- **Imágenes base**: `postgres:16-alpine` y `redis:7-alpine` siguen versiones menores; un redeploy con **Force rebuild / pull** las actualiza. No cambies la versión mayor de Postgres sin `pg_dump`/restore.

## 9. Solución de problemas

| Síntoma                                                                                                      | Causa probable y solución                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| El despliegue falla con `invalid spec: :/data/shares: empty section between colons` (o `:/config`)           | Falta `SHARES_HOST_PATH` (o `SHARES_CONFIG_HOST_DIR`) en Environment Variables.                                                                                                                                                                                    |
| Coolify detiene el despliegue con `Invalid volume source: contains forbidden character '${'`                 | El origen de un volumen usa una forma de variable que Coolify no acepta (`${VAR:?…}`, `${VAR:+…}`, etc.). Usa solo `${VAR}`, `${VAR}/ruta` o `${VAR:-ruta}`.                                                                                                       |
| La app se reinicia con `EISDIR: illegal operation on a directory` o `Invalid shares config … file not found` | `SHARES_CONFIG_HOST_DIR`/`SHARES_CONFIG_FILE` no apuntan a un archivo existente en el host (con una ruta relativa o inexistente Docker crea una carpeta vacía). Crea `shares.yaml` en una ruta absoluta, por ejemplo `/srv/wfb/config/shares.yaml`, y redespliega. |
| `app` reinicia en bucle con `ERROR: /app/data is not writable`                                               | El volumen `app-data` se creó con otro dueño (por ejemplo una versión antigua de la imagen). Desde el servidor: `docker run --rm -v <uuid>_app-data:/d alpine chmod -R 1777 /d`.                                                                                   |
| `database migrations failed after 5 attempts`                                                                | Revisa las líneas anteriores del log. `P1000` (autenticación): se cambió `SERVICE_PASSWORD_POSTGRES` después de crear el volumen; restáurala. `P1001`: `postgres` no está sano.                                                                                    |
| `SESSION_SECRET is required in production`                                                                   | Falta `SERVICE_BASE64_64_SESSION`: borra la variable y vuelve a desplegar para que Coolify la regenere.                                                                                                                                                            |
| 502 / _no available server_ en el dominio                                                                    | `app` no está `healthy` todavía o el dominio no lleva `:3000`. Mira los logs de `app`.                                                                                                                                                                             |
| Los shares aparecen vacíos o con _permission denied_                                                         | `PUID/PGID` no pueden leer `SHARES_HOST_PATH`, o `path` en `shares.yaml` no empieza por `/data/shares`. Prueba: `docker exec app-<uuid> ls -la /data/shares`.                                                                                                      |
| No se puede crear/renombrar aunque la ACL da `write`                                                         | Permisos de escritura del sistema de archivos para `PUID/PGID` (ver §1).                                                                                                                                                                                           |
| Cambios en `shares.yaml` no se aplican                                                                       | Busca `shares config reload failed` en los logs (YAML inválido). Comprueba que editas el archivo de `SHARES_CONFIG_HOST_DIR`/`SHARES_CONFIG_FILE`.                                                                                                                 |
| El login OIDC vuelve con `?authError=oidc_unavailable`                                                       | La app no llega al issuer (DNS, CA privada → `NODE_EXTRA_CA_CERTS`) o `OIDC_ISSUER` no coincide exactamente (barra final incluida). Ver `docs/identity.md`.                                                                                                        |
| El login LDAP/AD responde _servicio de directorio no disponible_                                             | Conectividad, certificado o cuenta de servicio. Busca `directory unavailable` en los logs con `LOG_LEVEL=debug`.                                                                                                                                                   |
| Subidas grandes fallan                                                                                       | La web sube por fragmentos; si usas un proxy adicional delante de Coolify (Cloudflare, Nginx), revisa su límite de cuerpo y timeouts.                                                                                                                              |
| La previsualización de Office no aparece                                                                     | Requiere `INSTALL_LIBREOFFICE=true` y un redeploy (reconstruye la imagen).                                                                                                                                                                                         |

### Logs

La app escribe **JSON de una línea** (pino) en stdout: se ven en **Logs** de Coolify o con `docker logs app-<uuid>`. Cada petición lleva `reqId`; si el proxy envía `x-request-id` se reutiliza, así que puedes correlacionar con los logs del proxy. Cookies, cabeceras `authorization`/`x-csrf-token`, contraseñas, secretos y los parámetros `code`/`state` de OIDC se registran como `[Redacted]`. Las peticiones de healthcheck (`/healthz`) no se registran.

```bash
docker logs app-<uuid> --since 10m | grep '"level":50'            # errores
docker logs app-<uuid> --since 1h | grep '"reqId":"<id>"'           # una petición
```

El driver `json-file` del compose rota los logs (10 MB × 5 para `app`).

## 10. Probar el stack de producción en local

```bash
mkdir -p /tmp/wfb/shares/public
cat > /tmp/wfb/env <<EOF
SERVICE_URL_APP=http://localhost:3000
SERVICE_USER_POSTGRES=wfb
SERVICE_PASSWORD_POSTGRES=$(openssl rand -hex 16)
SERVICE_PASSWORD_REDIS=$(openssl rand -hex 16)
SERVICE_BASE64_64_SESSION=$(openssl rand -base64 48 | tr -d '\n')
SHARES_HOST_PATH=/tmp/wfb/shares
SHARES_CONFIG_HOST_DIR=$PWD/config
SHARES_CONFIG_FILE=shares.example.yaml
PUID=$(id -u)
PGID=$(id -g)
EOF
docker compose -p wfb-prodtest --env-file /tmp/wfb/env up -d --build --wait
docker compose -p wfb-prodtest exec app node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>r.text()).then(console.log)"
docker compose -p wfb-prodtest down -v
```
