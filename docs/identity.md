# Integración de identidad: LDAP, Active Directory y Authentik (OIDC)

wfb no guarda contraseñas. Los usuarios entran con un **directorio** (OpenLDAP o Active Directory, formulario usuario/contraseña) o con **OIDC** (Authentik, botón "Entrar con …"). Se pueden activar ambos a la vez. De cada login se obtienen un **nombre de usuario** y una lista de **grupos**; `shares.yaml` decide con ellos qué carpetas ve cada uno.

Las variables se definen en Coolify (ver [`deploy/COOLIFY.md`](../deploy/COOLIFY.md) y [`deploy/coolify.env.example`](../deploy/coolify.env.example)). Tras cambiarlas hay que **Redeploy** (o **Restart**).

## 1. Cómo se obtienen usuario y grupos

| Origen           | Nombre de usuario (siempre en minúsculas)              | Grupos                                                                                                                            |
| ---------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| OpenLDAP         | `uid` (o `sAMAccountName`) de la entrada encontrada    | CN de cada DN de `LDAP_GROUP_ATTRIBUTE` (`memberOf`). Si está vacío, busca grupos con `member` o `uniqueMember` = DN del usuario. |
| Active Directory | `sAMAccountName`                                       | CN de `memberOf` **más** los grupos anidados (regla `LDAP_MATCHING_RULE_IN_CHAIN`).                                               |
| OIDC (Authentik) | claim `preferred_username`, si no `email`, si no `sub` | claim indicado en `OIDC_GROUPS_CLAIM` (por defecto `groups`): lista de nombres.                                                   |

Los grupos se comparan por su **CN en minúsculas**: en `shares.yaml` puedes escribir `Finanzas`, `finanzas` o el DN completo `CN=Finanzas,OU=Grupos,DC=corp,DC=example,DC=com`; los tres equivalen. Ojo: dos grupos con el mismo CN en OUs distintas cuentan como el mismo grupo.

Para comprobar lo que wfb ve de un usuario, inicia sesión y abre `https://<dominio>/api/auth/me`: muestra `username`, `provider` y `groups`. Los grupos se leen en cada login; los cambios en el directorio se aplican al volver a iniciar sesión (o al caducar la sesión, `SESSION_TTL_HOURS`).

## 2. OpenLDAP

```env
DIRECTORY_KIND=ldap
DIRECTORY_LABEL=LDAP
LDAP_URL=ldap://ldap.example.com:389
LDAP_START_TLS=true
LDAP_BIND_DN=cn=wfb-reader,ou=services,dc=example,dc=com
LDAP_BIND_PASSWORD=********
LDAP_BASE_DN=dc=example,dc=com
LDAP_USER_FILTER=(&(objectClass=inetOrgPerson)(uid={{username}}))
LDAP_GROUP_ATTRIBUTE=memberOf
```

- **Flujo**: wfb se conecta con la cuenta de servicio, busca al usuario con `LDAP_USER_FILTER` (`{{username}}` se sustituye escapado) bajo `LDAP_BASE_DN`, exige **exactamente una** coincidencia y comprueba la contraseña haciendo bind con el DN del usuario.
- **Cuenta de servicio**: solo necesita leer usuarios y grupos (en OpenLDAP, una ACL `by dn="cn=wfb-reader,…" read`). Sin `LDAP_BIND_DN` la búsqueda es anónima (solo si tu servidor lo permite).
- **Grupos**:
  - Con el overlay `memberof` activo, `memberOf` ya trae los grupos (`groupOfNames`/`groupOfUniqueNames`).
  - Sin overlay, wfb busca `(|(member=<DN>)(uniqueMember=<DN>))` bajo `LDAP_BASE_DN`.
  - Los `posixGroup` con `memberUid` **no** se soportan: usa `groupOfNames` o activa `memberof`.
- **TLS**:
  - StartTLS: `LDAP_URL=ldap://…:389` + `LDAP_START_TLS=true`.
  - LDAPS: `LDAP_URL=ldaps://…:636` (no actives `LDAP_START_TLS`).
  - CA privada: copia el PEM a la carpeta de `SHARES_CONFIG_HOST_DIR` (se monta en `/config`) y define `NODE_EXTRA_CA_CERTS=/config/ca.pem`.
  - `LDAP_TLS_REJECT_UNAUTHORIZED=false` desactiva la verificación del certificado: solo para pruebas.

## 3. Active Directory

```env
DIRECTORY_KIND=ad
DIRECTORY_LABEL=Cuenta corporativa
LDAP_URL=ldaps://dc01.corp.example.com:636
LDAP_BIND_DN=CN=svc-wfb,OU=Service Accounts,DC=corp,DC=example,DC=com
LDAP_BIND_PASSWORD=********
LDAP_BASE_DN=DC=corp,DC=example,DC=com
LDAP_USER_FILTER=(&(objectClass=user)(|(sAMAccountName={{username}})(userPrincipalName={{username}}))(!(userAccountControl:1.2.840.113556.1.4.803:=2)))
AD_DOMAIN=corp.example.com
NODE_EXTRA_CA_CERTS=/config/corp-root-ca.pem
```

### Cuenta de servicio (recomendado)

1. Crea un usuario `svc-wfb` en AD: contraseña larga, "La contraseña nunca expira", sin permisos especiales (los usuarios del dominio pueden leer el directorio por defecto) y, si quieres, con "Iniciar sesión en…" limitado.
2. `LDAP_BIND_DN` puede ser el DN completo o el UPN (`svc-wfb@corp.example.com`).
3. El filtro de ejemplo acepta `alice` **o** `alice@corp.example.com` (UPN) y excluye cuentas deshabilitadas. El nombre de usuario en wfb será siempre el `sAMAccountName` (`alice`).

### Sin cuenta de servicio (bind con UPN)

Si dejas `LDAP_BIND_DN` vacío y defines `AD_DOMAIN`, wfb hace bind directamente como `<usuario>@AD_DOMAIN` y luego busca al propio usuario por `sAMAccountName`. El usuario debe escribir **solo** su nombre (`alice`, no `alice@corp…` ni `CORP\alice`). `LDAP_USER_FILTER` se ignora en este modo.

### Grupos y grupos anidados

- `memberOf` devuelve los grupos **directos** (no incluye el grupo primario, normalmente _Domain Users_).
- Con `DIRECTORY_KIND=ad` wfb añade siempre los grupos **anidados** con la búsqueda `(member:1.2.840.113556.1.4.1941:=<DN del usuario>)` bajo `LDAP_BASE_DN`. Si `alice` está en `Contabilidad` y `Contabilidad` es miembro de `Finanzas`, una ACL para `Finanzas` le aplica.
- En dominios muy grandes esa búsqueda puede tardar; acota `LDAP_BASE_DN` a la OU que contiene usuarios y grupos si es posible.
- Bosques con varios dominios: usa el catálogo global (`ldaps://gc.corp.example.com:3269`, `LDAP_BASE_DN` = raíz del bosque).

### LDAPS / StartTLS en AD

- LDAPS (636) requiere que los controladores de dominio tengan certificado (AD CS o uno público). Exporta la **CA raíz** en Base64 (PEM) y monta el archivo como `NODE_EXTRA_CA_CERTS` (ver §2).
- StartTLS sobre 389 también funciona (`ldap://…:389` + `LDAP_START_TLS=true`).
- No uses LDAP sin cifrar contra AD: las contraseñas viajarían en claro y los DC con _LDAP signing_ obligatorio rechazan el bind simple.
- El nombre del `LDAP_URL` debe coincidir con el certificado del DC (usa el FQDN, no la IP).

## 4. Authentik (OIDC)

### Datos que necesitas

| Concepto                      | Valor                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| Redirect URI                  | `https://<SERVICE_FQDN_APP>/api/auth/oidc/callback`                  |
| URL de lanzamiento (opcional) | `https://<SERVICE_FQDN_APP>/`                                        |
| Issuer (`OIDC_ISSUER`)        | `https://<authentik>/application/o/<slug>/` (**con la barra final**) |

`<SERVICE_FQDN_APP>` es el dominio configurado en Coolify para `app`, sin `:3000` (p. ej. `archivos.example.com`). wfb construye el `redirect_uri` a partir de `SERVICE_URL_APP`/`APP_URL`, así que deben coincidir exactamente.

### Paso a paso en la interfaz de Authentik (2024.10+)

1. **Customization → Property Mappings → Create → Scope Mapping** (opcional pero recomendado, deja explícito el claim de grupos):
   - Name: `wfb: groups` · Scope name: `groups`
   - Expression:
     ```python
     return {"groups": [group.name for group in request.user.ak_groups.all()]}
     ```
   El mapping estándar `profile` de Authentik también incluye `groups`; con este scope no dependes de él.
2. **Applications → Providers → Create → OAuth2/OpenID Provider**:
   - Name: `wfb` · Authorization flow: `default-provider-authorization-implicit-consent` (o `explicit` si quieres pantalla de consentimiento).
   - Client type: **Confidential**. Copia **Client ID** y **Client Secret**.
   - Redirect URIs: `Strict` → `https://archivos.example.com/api/auth/oidc/callback`.
   - Signing Key: `authentik Self-signed Certificate` (o tu certificado). Es necesario para firmar el ID token con RS256.
   - Advanced protocol settings → Scopes: `openid`, `email`, `profile` y `wfb: groups`.
   - Subject mode: `Based on the User's hashed ID` (estable aunque se renombre el usuario). wfb usa `preferred_username` como nombre.
   - Include claims in id_token: activado.
3. **Applications → Applications → Create**: Name `Explorador de archivos`, Slug `wfb`, Provider `wfb`, Launch URL `https://archivos.example.com/`.
4. **Restringir acceso** (recomendado): en la aplicación, **Policy / Group / User Bindings → Bind existing group** → `wfb-users`. Sin bindings, cualquier usuario de Authentik puede entrar (y solo verá shares públicos).

### Variables en Coolify

```env
OIDC_ISSUER=https://auth.example.com/application/o/wfb/
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret>
OIDC_LABEL=Authentik
OIDC_SCOPES=openid profile email groups
OIDC_GROUPS_CLAIM=groups
OIDC_TOKEN_AUTH_METHOD=client_secret_post
```

- `OIDC_TOKEN_AUTH_METHOD`: déjalo en `client_secret_post`. Authentik no decodifica las credenciales `client_secret_basic` codificadas como formulario, y un secreto con caracteres especiales falla con `invalid_client`. Usa `client_secret_basic` solo con otros proveedores que lo requieran.
- El issuer debe ser HTTPS en producción y coincidir **carácter por carácter** con el `issuer` de `https://auth.example.com/application/o/wfb/.well-known/openid-configuration`.
- Si Authentik usa una CA privada, monta el PEM y define `NODE_EXTRA_CA_CERTS` (§2).
- El login usa _authorization code_ + PKCE + `state` + `nonce`; el `state` se guarda 10 minutos en Redis y en una cookie firmada `wfb_oidc`, y ambos deben coincidir en el callback (protege contra _login CSRF_).

### Cierre de sesión

"Cerrar sesión" en wfb siempre elimina la sesión de wfb y, para usuarios que entraron con OIDC, hace además un _RP-initiated logout_: el navegador va al `end_session_endpoint` de Authentik con `id_token_hint`, `client_id` y `post_logout_redirect_uri` = `APP_URL` (por ejemplo `https://files.example.com`). Si el IdP no publica `end_session_endpoint`, solo se cierra la sesión local.

Lo que ocurre en Authentik depende del **invalidation flow** del provider:

- `default-provider-invalidation-flow` (el que usan los blueprints): muestra una página de Authentik que confirma la salida de la aplicación y ofrece cerrar también la sesión de Authentik. No vuelve automáticamente a wfb.
- Para cerrar la sesión de Authentik sin preguntar, asigna al provider un flujo de invalidación con la etapa _User Logout_ (por ejemplo `default-invalidation-flow`).
- Para que Authentik devuelva al usuario a wfb, registra `APP_URL` como redirect URI de tipo _post-logout_ en el provider si tu versión de Authentik lo permite. Las versiones que no lo permiten (como la 2024.10 del entorno de desarrollo) se quedan en la página del flujo.

Con otros IdP OIDC registra `APP_URL` como _post-logout redirect URI_ del cliente.

### Blueprint de producción

[`deploy/authentik/blueprints/wfb-prod.example.yaml`](../deploy/authentik/blueprints/wfb-prod.example.yaml) crea de una vez el grupo `wfb-users`, el scope `groups`, el provider `wfb`, la aplicación y el binding de acceso.

1. En el servidor y el worker de Authentik define:
   ```env
   WFB_DOMAIN=archivos.example.com
   WFB_OIDC_CLIENT_SECRET=<secreto largo; el mismo valor que OIDC_CLIENT_SECRET en wfb>
   ```
   (Genera el secreto con `openssl rand -hex 32`.)
2. Copia el archivo a la carpeta de blueprints del worker (`/blueprints/custom/`, montada como volumen en el compose de Authentik).
3. **Customization → Blueprints**: aparece `wfb-prod` (no se instancia solo); edítalo, márcalo **Enabled** y pulsa **Apply**. Alternativa por consola: `docker exec <authentik-worker> ak apply_blueprint /blueprints/custom/wfb-prod.example.yaml`.
4. Añade los usuarios al grupo `wfb-users` y a los grupos que uses en `shares.yaml`.

El blueprint de desarrollo (`wfb-dev.yaml`) es solo para el stack local y E2E: contiene contraseñas de prueba.

### Authentik delante de AD/LDAP

Si Authentik sincroniza usuarios desde AD (**Directory → Federation & Social login → LDAP Source** con _Sync groups_), los grupos de AD llegan a wfb en el claim `groups` con su nombre (CN). Así una misma ACL de `shares.yaml` sirve para el login directo con AD y para el login por Authentik.

## 5. Grupos → ACL en `shares.yaml`

```yaml
shares:
  - id: comun
    name: Común
    path: /data/shares/comun
    visibility: public # todos los usuarios autenticados lo ven
    permissions: [read] # permisos base para todos
    acl:
      - group: Personal # AD: CN=Personal,OU=Grupos,... | Authentik: grupo "Personal"
        permissions: [read, write]

  - id: finanzas
    name: Finanzas
    path: /data/shares/finanzas
    visibility: private # solo quien aparece en acl
    acl:
      - group: CN=Finanzas,OU=Grupos,DC=corp,DC=example,DC=com # equivale a "finanzas"
        permissions: [read, write, delete]
      - group: Auditoria
        permissions: [read]
      - user: alice # sAMAccountName / uid / preferred_username
        permissions: [read]
```

- Permisos efectivos = permisos base (solo shares `public`) ∪ todas las entradas que coinciden.
- `write` permite crear, subir, renombrar y mover hacia el share; `delete` permite eliminar (a la papelera).
- Las entradas `user:` comparan el nombre de usuario en minúsculas **sin importar el proveedor**. Si activas LDAP/AD y OIDC a la vez, asegúrate de que el mismo nombre corresponde a la misma persona en ambos (por ejemplo, Authentik sincronizado desde AD), o usa solo grupos.
- Con OIDC, si Authentik no envía `preferred_username` el nombre será el email: escribe la entrada `user:` con ese valor.
- El sistema de archivos también manda: el usuario `PUID` del contenedor necesita permisos reales de escritura donde la ACL concede `write`/`delete`.
- Los cambios en `shares.yaml` se aplican en caliente; los cambios de pertenencia a grupos, en el siguiente login.

## 6. Problemas frecuentes

| Síntoma                                                                                           | Revisión                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Usuario o contraseña incorrectos" con credenciales válidas                                       | El filtro no encuentra exactamente un usuario (prueba con `ldapsearch` y el mismo filtro y base), la cuenta está deshabilitada o, en modo UPN, el usuario escribió el dominio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| "El servicio de directorio no está disponible"                                                    | Conectividad al puerto 389/636, certificado (`self-signed certificate`, `Hostname/IP does not match`) o `LDAP_BIND_DN`/`LDAP_BIND_PASSWORD` erróneos. Busca `directory unavailable` en los logs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| El usuario entra pero no ve shares privados                                                       | `/api/auth/me` no muestra el grupo: en OpenLDAP activa `memberof` o usa `groupOfNames`; en Authentik comprueba el scope `groups` y `OIDC_GROUPS_CLAIM`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `?authError=oidc_unavailable`                                                                     | wfb no puede descargar el discovery del issuer: URL, barra final, DNS desde el servidor de Coolify o CA privada.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Authentik muestra _Redirect URI Error_ (`missing, invalid, or mismatching redirection URI`)       | El `redirect_uri` que envía wfb no coincide **exactamente** con uno de los Redirect URIs del provider. wfb lo construye como `APP_URL` + `/api/auth/oidc/callback` (sin puerto, sin barra final). Míralo en el log de arranque (`oidcRedirectUri` en `wfb api ready`) o en el parámetro `redirect_uri=` de la URL de la página de error, y cópialo tal cual en **Providers → wfb → Redirect URIs** (modo `Strict`). Errores típicos: `http` en lugar de `https` (el dominio de `app` en Coolify debe empezar por `https://`), el dominio autogenerado de Coolify (`app-<uuid>.…`, o `sslip.io`) porque sigue siendo el **primero** de la lista de dominios de `app` (déjalo solo con el tuyo y haz Redeploy, o define `PUBLIC_URL`), `:3000` añadido a mano, o la URI de desarrollo `http://localhost:3000/...`. Si en los logs aparece `oidc login requested on a host that does not match APP_URL`, entras por un dominio distinto al configurado para `app` en Coolify. |
| _No se pudo completar el inicio de sesión_ (`?authError=oidc_failed`) tras loguearte en Authentik | Busca `oidc callback failed` en los logs de `app`: el campo `hint` indica la causa. Las habituales: el provider **no tiene Signing Key** (Authentik firma entonces con HS256, que wfb no acepta; elige un certificado, p. ej. _authentik Self-signed Certificate_, en **Providers → wfb → Signing Key**); `invalid_client` (client secret distinto o `OIDC_TOKEN_AUTH_METHOD` no es `client_secret_post`); `issuer` distinto de `OIDC_ISSUER`; relojes desincronizados; o la app no alcanza el token endpoint de Authentik (DNS/TLS; CA privada → `NODE_EXTRA_CA_CERTS`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| Authentik muestra "Redirect URI Error"                                                            | La URI registrada no coincide (http/https, dominio, barra final). `SERVICE_URL_APP` debe ser el dominio público con `https://`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Authentik muestra "Permission denied" al entrar                                                   | El usuario no pertenece al grupo vinculado a la aplicación (`wfb-users`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
