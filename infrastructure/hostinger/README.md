# Hostinger VPS · provisioning & deploy via GitHub Actions

Deploy directo de GitHub Actions a un VPS Ubuntu 24.04 vía SSH. La CI buildea
imágenes, las publica a GHCR, las pulla en el VPS y levanta el stack con
Docker Compose.

## Topología

```
Internet
   │
   ▼
Cloudflare  (TLS edge · WAF · DDoS · cache)
   │  (Full strict; IP del usuario en CF-Connecting-IP, §10)
   ▼
Ubuntu 24.04 VPS  (Docker + Compose)
   │
   └── /opt/sales-travel/  (compose stack)
       ├── caddy        :80 / :443  (TLS origin · reverse proxy)
       ├── api          :3000       (api.planetour.cloud)
       ├── web-b2b      :3001       (app.planetour.cloud)
       ├── migrate                  (one-shot, corre antes que api)
       ├── postgres     :5432       (TimescaleDB + pgvector, sólo red interna)
       └── redis        :6379       (sólo red interna)
```

Servicios diferidos hasta que un feature los requiera: `typesense`, `minio`,
`temporal`, `ai-sidecar`.

---

## 1. Provisioning del VPS (one-time)

VPS Ubuntu 24.04 LTS recién provisionado. Como root con tu pubkey ya cargada:

```bash
# Subir el script
scp infrastructure/hostinger/provision.sh root@<IP>:/tmp/

# Ejecutarlo (interactivo: pide credenciales GHCR al final)
ssh root@<IP> "bash /tmp/provision.sh"
```

Lo que hace `provision.sh`:

1. Update sistema + paquetes base.
2. Instala Docker Engine + Compose plugin.
3. Crea usuario `deploy` con grupo `docker` y autoriza tu pubkey.
4. Crea `/opt/sales-travel/`.
5. SSH hardening: deshabilita password auth, root sólo con clave, max 3 intentos.
6. UFW: deny incoming por default. Sólo permite `:22` (SSH) y `:80/:443` desde rangos de Cloudflare. **Ojo:** las reglas
   de 80/443 no filtran los puertos que publica Docker (Caddy), que se saltan UFW: el origen sigue abierto a cualquiera
   (§10.5).
7. fail2ban + unattended-upgrades + sysctl tuning + journald limits.
8. `docker login ghcr.io` interactivo como `deploy` (usar PAT con scope `read:packages`).

Si necesitás otro puerto SSH:

```bash
SSH_PORT=2222 ssh root@<IP> "SSH_PORT=2222 bash /tmp/provision.sh"
```

Y luego configurar la var `HOSTINGER_SSH_PORT=2222` en GitHub.

---

## 2. DNS en Cloudflare

Zona `planetour.cloud`, registros **proxied (orange cloud)**:

### Sprint 0 (ahora)

| Tipo | Nombre | Valor      | Apunta a                       |
| ---- | ------ | ---------- | ------------------------------ |
| A    | `api`  | IP del VPS | `apps/api` (NestJS)            |
| A    | `app`  | IP del VPS | `apps/web-b2b` (panel agencia) |

### Certificación de TBO (§9)

| Tipo | Nombre     | Valor      | Apunta a                                            |
| ---- | ---------- | ---------- | --------------------------------------------------- |
| A    | `cert-app` | IP del VPS | `cert-web-b2b`, el panel del stack de certificación |

### Sprint posterior (a medida que se sumen apps)

| Tipo | Nombre      | Apunta a                  | Cuándo                             |
| ---- | ----------- | ------------------------- | ---------------------------------- |
| A    | `@` y `www` | `apps/web-b2c`            | cuando exista el sitio público B2C |
| A    | `admin`     | `apps/web-admin`          | cuando exista el panel superadmin  |
| A    | `*.tenants` | `apps/web-b2b` (wildcard) | white-label dinámico               |

> Para `*.tenants` se requiere cambiar Caddy a DNS-01 challenge (Cloudflare API token con permiso `Zone:DNS:Edit`); HTTP-01 no soporta wildcards.

SSL/TLS mode: **Full (strict)**. Caddy obtiene certificado vía Let's Encrypt
automáticamente. El `Caddyfile` ya tiene los bloques para `web-b2c`, `web-admin`
y wildcard de tenants comentados — basta descomentar cuando llegue el momento.

---

## 3. GitHub Actions — secrets y variables

### Repository → Settings → Secrets and variables → Actions

#### Secrets (todos requeridos)

| Secret                    | Cómo generarlo / qué poner                                                                                                                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `HOSTINGER_HOST`          | IP pública del VPS (ej. `203.0.113.42`)                                                                                                   |
| `HOSTINGER_USER`          | `deploy`                                                                                                                                  |
| `HOSTINGER_SSH_KEY`       | Clave privada SSH (formato OpenSSH, contenido completo `-----BEGIN…END-----`) cuyo público está en `~deploy/.ssh/authorized_keys` del VPS |
| `POSTGRES_ADMIN_PASSWORD` | `openssl rand -base64 32` — superuser, sólo migraciones                                                                                   |
| `APP_USER_PASSWORD`       | `openssl rand -base64 32` — rol runtime de `apps/api`, respeta RLS                                                                        |
| `REDIS_PASSWORD`          | `openssl rand -base64 32`                                                                                                                 |
| `JWT_SECRET`              | `openssl rand -base64 64` (mínimo 32 chars; el código lo valida)                                                                          |

#### Variables (opcionales)

| Variable                  | Default | Uso                                                           |
| ------------------------- | ------- | ------------------------------------------------------------- |
| `HOSTINGER_SSH_PORT`      | `22`    | Si cambiaste el puerto SSH en `provision.sh`                  |
| `PROVIDERS_DISABLED`      | vacío   | Kill-switch de emergencia por proveedor (§6.1)                |
| `FLIGHT_PROVIDERS_OPT_IN` | `sabre` | **Legado.** Los proveedores los enciende el superadmin (§6.1) |
| `HOTEL_PROVIDERS_OPT_IN`  | vacío   | **Legado.** Los proveedores los enciende el superadmin (§6.1) |

> El PAT de GHCR se usa **una sola vez** durante el provisioning del VPS para `docker login`. **No** va en GitHub Actions: el push a GHCR usa `GITHUB_TOKEN` automáticamente.

> Las cuentas de proveedor **no** son secrets de GitHub: se cargan desde el panel del superadmin y quedan cifradas en la
> bóveda (`provider_accounts`) con `PROVIDER_CREDENTIALS_KEY`. Eso incluye la cuenta de TBO que usa el sync del
> catálogo (workflow `Sync TBO Hotel Inventory`): el contenedor la lee de la bóveda de Planetour con esa misma clave,
> que el workflow toma del `.env` del VPS (D-TBO-04, 2026-09-29;
> [`tools/sync-tbo-hotel-inventory`](../../tools/sync-tbo-hotel-inventory/README.md)). `TBO_SYNC_USERNAME` y
> `TBO_SYNC_PASSWORD` quedan sólo como override opcional y no hace falta crearlos.

---

## 4. Generar el par de claves SSH del usuario `deploy`

En tu máquina local:

```bash
# 1. Generar clave dedicada al deploy (sin passphrase, identificable por nombre)
ssh-keygen -t ed25519 -f ~/.ssh/sales-travel-deploy -C "github-actions@planetour" -N ""

# 2. Subir la pubkey al VPS (entrá como root primero)
ssh-copy-id -i ~/.ssh/sales-travel-deploy.pub root@<IP>
# Luego provision.sh la copia al usuario deploy automáticamente.

# 3. Probar conexión como deploy
ssh -i ~/.ssh/sales-travel-deploy deploy@<IP> "docker ps"

# 4. Pegar el contenido de la PRIVADA en el secret HOSTINGER_SSH_KEY
cat ~/.ssh/sales-travel-deploy
```

---

## 5. Primer deploy

1. Push a `main` (o ejecutá `Deploy` workflow manualmente desde la pestaña Actions).
2. CI buildea api + web-b2b + migrate, las pushea a `ghcr.io/nipko/sales-travel-*:{sha,latest}`.
3. CI hace SSH al VPS, sincroniza compose+Caddyfile+postgres-init, render `.env` desde secrets, `docker compose pull && up -d`. El Caddyfile se valida antes del `up` y se aplica con `caddy reload` (§10.3).
4. Smoke test: `curl https://api.planetour.cloud/api/health` (5 reintentos cada 10s).

Tiempo total ~6–8 min en frío (build con cache caliente baja a ~3 min).

---

## 6. Operaciones comunes

```bash
# Logs en vivo
ssh deploy@<IP> "cd /opt/sales-travel && docker compose logs -f api"

# Restart de un servicio
ssh deploy@<IP> "cd /opt/sales-travel && docker compose restart api"

# Pinear una versión específica (rollback)
# Ejecutar Deploy workflow desde Actions → "Run workflow" → eligiendo el SHA deseado.
# Alternativa rápida: en el VPS, editar .env IMAGE_TAG=<sha> y `docker compose up -d`.
# Si ese `up` falla con "network sales-travel-cert-ingress declared as external, but could not be
# found" (la borró un `docker network prune` con el Caddy parado), crearla y repetir (§9):
ssh deploy@<IP> "docker network create --internal sales-travel-cert-ingress"

# Backup de Postgres
ssh deploy@<IP> "docker compose -f /opt/sales-travel/docker-compose.yml exec -T postgres pg_dumpall -U postgres" \
  > backup-$(date +%F).sql

# Estado del stack
ssh deploy@<IP> "cd /opt/sales-travel && docker compose ps"
```

### 6.1 Proveedores: quién los enciende y cómo se apagan en una emergencia

Desde el 2026-09-28 qué proveedores usa cada agencia lo decide el **superadmin desde el panel**, no el entorno
([`docs/tbo/08`](../../docs/tbo/08-requisitos-maestro.md#d-tbo-18--en-qué-búsquedas-se-consulta-tbo) D-TBO-18). El
estado de un proveedor para una agencia sale de lo primero que opine, en este orden:

1. `PROVIDERS_DISABLED`, el kill-switch de emergencia: le gana a todo.
2. El ajuste de la agencia o, si no tiene, el del ancestro más cercano de su red.
3. El ajuste global del proveedor.
4. Las variables legado `FLIGHT_PROVIDERS_OPT_IN` y `HOTEL_PROVIDERS_OPT_IN`, sólo si la base no tiene ningún ajuste de
   ese proveedor para esa agencia, sus ancestros ni global.
5. La política del proveedor: `opt-in` apagado (TBO), `always` encendido (Despegar, LATAM, Sabre).

**Lo normal: el panel.** En `https://app.planetour.cloud`, con un usuario `superadmin` (§7; `platform_admin` no
alcanza):

- _Proveedores de la plataforma_ (`/admin/plataforma/proveedores`): por proveedor, el interruptor _Todos los tenants_ y
  las excepciones por agencia (_Heredar_, _Habilitado_, _Deshabilitado_), con motivo y confirmación antes de apagar.
  Muestra el estado efectivo de cada una y de dónde sale.
- _Gestión de Agencias_ → una agencia (`/admin/tenants/<id>`): sus proveedores, con el mismo control.

No hace falta desplegar: la réplica del api que recibe el cambio lo aplica al instante y las demás en 10 s como mucho.
Apagar un proveedor para una agencia corta sus búsquedas y ventas nuevas; lo ya vendido se sigue consultando,
cancelando y conciliando con la cuenta de la orden. Cada cambio queda en `domain_events` como
`platform.provider_enablement.updated`, con quién lo hizo, el antes y el después. Los ajustes, desde el VPS:

```bash
ssh deploy@<IP> "cd /opt/sales-travel && docker compose exec -T postgres psql -U postgres -d sales_travel -c \
  'SELECT provider_code, tenant_id, enabled, reason, updated_at FROM provider_enablement ORDER BY 1, 2 NULLS FIRST'"
```

**Emergencia: `PROVIDERS_DISABLED`.** Variable de GitHub, lista separada por comas: `código` apaga el proveedor del
todo, post-venta incluida; `código:ventas` apaga sólo búsqueda, PreBook y Book, y deja leer y cancelar lo vendido. Vale
para toda la plataforma y le gana a cualquier ajuste del panel, que la muestra como _Apagado de emergencia de
operaciones_. Es para incidentes (el proveedor responde mal, un bug nuestro), no para decidir quién vende con qué, y
exige desplegar (Actions → **Deploy** → Run workflow). Editar `PROVIDERS_DISABLED` en el `.env` del VPS y hacer
`docker compose up -d api` es más rápido, pero el despliegue siguiente reescribe el `.env` con la variable de GitHub:
hay que cambiar las dos.

**Legado: `FLIGHT_PROVIDERS_OPT_IN` y `HOTEL_PROVIDERS_OPT_IN`.** Hasta el 2026-09-28 eran la única forma de encender un
proveedor `opt-in` (`código` para todas las agencias, `código@<tenantId>` para una) y cada cambio exigía desplegar.
Siguen contando, sólo para encender y sólo donde la base no tiene ningún ajuste, para no apagar el día del despliegue lo
que ya estaba encendido; el panel las muestra como origen _legado_. Se validan al arrancar: una entrada mal escrita
tumba el despliegue. `deploy.yml` escribe `sabre` en la de vuelos si la variable no existe, sin efecto mientras Sabre
sea `always`; la de hoteles va vacía. **No se usan para encender nada nuevo.** Para retirar una entrada: poner el
ajuste equivalente en el panel, comprobar que el origen ya no dice _legado_, y después quitar la entrada de la
variable y desplegar.

---

## 7. El superadmin

El superadmin es un usuario de Planetour, el tenant `platform` de tipo `platform` y raíz de la red. Ve y ajusta toda la
red, pero **no vende**: las búsquedas, reservas, órdenes y carteras le responden 403 `PLATFORM_ROLE_CANNOT_SELL`, en
cualquier nodo donde también sea miembro. Planetour vende a nombre propio con **sucursales**: agencias hijas de
Planetour, con sus propios vendedores.

Lo asigna la imagen `seed-superadmin`. Es one-shot e idempotente, y su comportamiento y sus negativas están en
[`tools/seed-superadmin`](../../tools/seed-superadmin/README.md). En resumen:

- Promueve `platform` a tipo `platform` si hace falta, sin renombrarlo.
- Cambia a `superadmin` la membership que tu cuenta tiene en `platform`.
- No toca tu contraseña.
- Se niega si `platform` cuelga de otro nodo o si la base ya tiene otra plataforma.

**Antes:** el despliegue de `main` con las migraciones 0049 a 0051 tiene que estar verde. La imagen tiene que ser la del
mismo despliegue (`IMAGE_TAG`). No uses una `seed-superadmin` anterior a este cambio: rota la contraseña y, sin
`SUPERADMIN_TENANT_NAME`, renombra "Planetour S.A.S" a "Platform".

### 7.1 En producción, con tu cuenta actual

Hoy tu cuenta es `consolidator_admin` de `platform`. Como `deploy` en el VPS, cambiando sólo el correo:

```bash
cd /opt/sales-travel
TAG=$(sed -n 's/^IMAGE_TAG=//p' .env)
# Sin `source .env`: un valor con espacios (p. ej. MAIL_PASS) se ejecutaría como comando.
# `-e PGPASSWORD` sin valor lo toma del entorno: la contraseña no queda en la línea de comandos, que
# cualquier usuario del VPS ve en `ps`, ni en el historial de la shell.
export PGPASSWORD="$(grep -m1 '^POSTGRES_ADMIN_PASSWORD=' .env | cut -d= -f2-)"

docker run --rm --network sales-travel_internal \
  -e PGHOST=postgres \
  -e PGPORT=5432 \
  -e PGUSER=postgres \
  -e PGPASSWORD \
  -e PGDATABASE=sales_travel \
  -e SUPERADMIN_TENANT_SLUG=platform \
  -e SUPERADMIN_EMAIL='<el correo con el que entras hoy>' \
  "ghcr.io/nipko/sales-travel-seed-superadmin:${TAG}"

unset PGPASSWORD
```

No se pasa `SUPERADMIN_PASSWORD`. Si el correo tiene un error, el seed no crea una cuenta nueva: sale con
`SUPERADMIN_PASSWORD:required_to_create_user` y no escribe nada.

Salida esperada: sale con `0` e imprime una sola línea, que aquí se muestra formateada.

```json
{
  "ok": true,
  "tenantId": "…",
  "tenantSlug": "platform",
  "tenant": "unchanged",
  "previousTenantType": null,
  "tenantStatus": "active",
  "userId": "…",
  "user": "existing",
  "userStatus": "active",
  "membership": "updated",
  "previousRole": "consolidator_admin",
  "passwordIgnored": false
}
```

- `"previousRole"` distinto de `"consolidator_admin"` (por ejemplo `null`) significa que el correo es de **otra** cuenta
  que ya existía, y ahora esa cuenta es superadmin. Compruébalo con la primera consulta de abajo, que muestra el correo.
  Si no es el tuyo, no sigas: devuélvele a esa membership lo que dice `before` en su evento `MembershipRoleChanged` (la
  segunda consulta), o bórrala si `before` es `null`.
- `"tenant": "promoted"` en lugar de `"unchanged"` significa que 0049 no había promovido `platform` y lo hizo el seed.
- Correrlo otra vez da `"membership": "unchanged"` y no escribe nada.
- Si sale con `1`, la línea trae el motivo (`reason` o `issues`) y la base queda como estaba.

Al entrar al panel, pide activar MFA si tu cuenta no lo tiene: es obligatorio para el superadmin.

Para comprobarlo:

```bash
docker compose exec -T postgres psql -U postgres -d sales_travel -c \
  "SELECT u.email, t.slug, t.tenant_type, m.role, m.status FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN users u ON u.id = m.user_id WHERE m.role = 'superadmin'"
docker compose exec -T postgres psql -U postgres -d sales_travel -c \
  "SELECT occurred_at, event_type, payload FROM domain_events WHERE payload->>'source' = 'seed-superadmin' ORDER BY occurred_at"
```

**Después:**

- Cuelga `amazon-minimalist` de Planetour. Hoy es una raíz suelta y no hereda las credenciales de Planetour; la
  migración 0050 lo avisa con un `WARNING` en el log de `postgres`. Se hace como superadmin desde _Gestión de
  Agencias_ → **Mover bajo Planetour S.A.S** (por API: `POST /admin/tenants/<id de amazon-minimalist>/move` con
  `{"parentTenantId": "<tenantId de la salida>"}`).
- Crea las sucursales de Planetour y sus vendedores.

El paso a paso completo, con las comprobaciones, está en el runbook de
[`docs/platform/13`](../../docs/platform/13-validacion-modelo-red.md#5-runbook-del-vps) §5.

### 7.2 Con una cuenta nueva

Si el correo no tiene cuenta, el seed la crea. Hacen falta dos variables más, y la contraseña se escribe sin eco en
lugar de ir en la línea de comandos. `TAG` y `PGPASSWORD` se preparan igual que en §7.1. En una base sin plataforma
hace falta además `SUPERADMIN_TENANT_NAME`, el nombre con el que se crea.

```bash
read -rsp 'Contraseña del superadmin (12+ caracteres): ' SUPERADMIN_PASSWORD && echo
export SUPERADMIN_PASSWORD
docker run --rm --network sales-travel_internal \
  -e PGHOST=postgres -e PGPORT=5432 -e PGUSER=postgres -e PGPASSWORD -e PGDATABASE=sales_travel \
  -e SUPERADMIN_TENANT_SLUG=platform \
  -e SUPERADMIN_EMAIL='<correo>' \
  -e SUPERADMIN_NAME='<nombre y apellido>' \
  -e SUPERADMIN_PASSWORD \
  "ghcr.io/nipko/sales-travel-seed-superadmin:${TAG}"
unset SUPERADMIN_PASSWORD PGPASSWORD
```

El seed **nunca cambia la contraseña de una cuenta que ya existe**: si llega `SUPERADMIN_PASSWORD`, la ignora y lo dice
con `"passwordIgnored": true`. Para cambiar una contraseña está _Olvidé mi contraseña_.

---

## 8. Cuándo migrar a AWS

Triggers en `docs/discovery/02-decisiones-segunda-ronda.md`:

- > 500 reservas/día sostenido
- SLA contractual > 99.5%
- NDC/proveedor adicional con requerimiento PCI L1
- > 100 k USD/mes en pagos procesados

Stack diseñado portable: las mismas imágenes corren en ECS/Fargate. Postgres → RDS,
MinIO → S3, Redis → ElastiCache. Sin cambios de código en `apps/`.

---

## 9. Stack de certificación de TBO

El portal que recorren los testers de TBO en la verificación de portal ([`docs/tbo/07`](../../docs/tbo/07-certificacion.md)
§7.2 opción A; D-TBO-35 A; RC-07). Es un **segundo proyecto compose** en el mismo VPS
([`docker-compose.cert.yml`](./docker-compose.cert.yml)), con su base (`sales_travel_cert`), su Redis y las **mismas
imágenes que producción**. Su `.env` no tiene ninguna credencial de proveedor: la única cuenta que resuelve es la
`tbo-hotels` de test que [`tools/seed-tbo-cert-tenant`](../../tools/seed-tbo-cert-tenant/README.md) cifra en su bóveda.
Un tester logueado como `vendedor` no tiene con qué reservar en Despegar, LATAM, Sabre ni AgentCars aunque falle un flag
o la herencia de cuentas.

```
Cloudflare ── cert-app.planetour.cloud
   │
   ▼
caddy (producción) ──[sales-travel-cert-ingress]── cert-web-b2b ──[internal]── cert-api ──[egress]── TBO test
                                                                                   │
/opt/sales-travel-cert (proyecto sales-travel-cert)                   postgres, redis (sólo internal)
```

- La única red compartida con producción es `sales-travel-cert-ingress`, y en ella sólo están el Caddy y el panel del
  stack. El api y la base de producción no la tocan, y el api del stack tampoco: ningún stack puede llamar al otro por
  la red interna.
- No hay subdominio para el api del stack: el navegador sólo habla con el panel y el panel llama al api por la red
  interna. Si una prueba necesitara el api desde fuera (por ejemplo, Playwright de PR-6.6), se añade un bloque
  `cert-api.planetour.cloud` al Caddyfile, `cert-api` a la red `ingress` y su registro DNS.
- Sin SMTP: el stack no envía correo.

### 9.1 Una sola vez

1. **DNS** (§2): registro `A` `cert-app` → IP del VPS, **proxied**. Primer nivel bajo la zona a propósito: el
   certificado universal de Cloudflare cubre `*.planetour.cloud` y no `*.cert.planetour.cloud`.
2. **Directorio en el VPS**, como root (en un VPS nuevo lo hace `provision.sh`):
   `install -d -o deploy -g deploy -m 0750 /opt/sales-travel-cert`.
3. **Desplegar producción desde `main`** con este cambio: crea la red `sales-travel-cert-ingress` y recrea el Caddy con
   el bloque de `cert-app` y la red nueva. El job del stack comprueba las dos cosas y no sigue sin ellas.
4. **Entorno de GitHub `tbo-cert`** (Settings → Environments), con revisores si alguien tiene que aprobar cada
   despliegue, y en él los secrets y variables de §9.2. También valen a nivel de repositorio.

### 9.2 Secrets y variables

Todos llevan el prefijo `CERT_` y **no se reutilizan los de producción**: con el mismo `JWT_SECRET` una sesión de un
stack serviría en el otro, y con la misma clave de credenciales un volcado de una base se leería en la otra. Los valores
del `.env` del stack van sin comillas, así que el render sólo acepta `A-Z a-z 0-9 + / = . _ ~ -` en esos secrets:
`openssl rand -base64 64` parte la línea y no sirve.

| Secret                          | Qué poner                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `CERT_POSTGRES_ADMIN_PASSWORD`  | `openssl rand -hex 32`                                                                           |
| `CERT_APP_USER_PASSWORD`        | `openssl rand -hex 32`                                                                           |
| `CERT_REDIS_PASSWORD`           | `openssl rand -hex 32`                                                                           |
| `CERT_JWT_SECRET`               | `openssl rand -hex 48` (mínimo 32 caracteres)                                                    |
| `CERT_PROVIDER_CREDENTIALS_KEY` | `openssl rand -base64 32`. Perderla deja ilegibles la cuenta de TBO y los documentos de clientes |
| `CERT_PROVIDER_PAYLOADS_KEY`    | `openssl rand -base64 32`, distinta de la anterior (RQ/RS de TBO, D-TBO-31 A)                    |
| `CERT_TBO_USERNAME`             | Usuario de la cuenta de **test** de TBO                                                          |
| `CERT_TBO_PASSWORD`             | Su contraseña. Llega literal al seed: `$`, `#`, comillas y espacios valen; un salto de línea no  |
| `CERT_VENDEDOR_PASSWORD`        | La del usuario de los testers (12 caracteres o más). Se entrega por un canal distinto del zip    |

| Variable                                | Por defecto                     | Uso                                                                                  |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `CERT_CURRENCY`                         | `USD`                           | Moneda del tenant y de la cartera: la de perfil de la cuenta de test (`check`)       |
| `CERT_VENDEDOR_EMAIL`                   | `tbo.tester@planetour.cloud`    | Usuario de login de los testers                                                      |
| `CERT_VENDEDOR_NAME`                    | `TBO Tester`                    | Nombre visible del usuario                                                           |
| `CERT_VENDEDOR_STATUS`                  | `active`                        | `suspended` tras el sign-off: cierra sus sesiones y no vuelve a entrar               |
| `CERT_TENANT_NAME`                      | `Sales-Travel Certification`    | Nombre neutro del tenant (07 §7.3.1)                                                 |
| `CERT_COUNTRY`                          | `CO`                            | País del tenant                                                                      |
| `CERT_SUPPORT_EMAIL`                    | `reservas.cert@planetour.cloud` | Contacto que el Book manda a TBO (`EmailId`): buzón de rol, nunca personal           |
| `CERT_SUPPORT_PHONE`                    | `+1 202 555 0100`               | Teléfono del Book (`PhoneNumber`), con `+` y prefijo. Ficticio: 555-01xx de NANPA    |
| `CERT_WALLET_BALANCE`                   | `50000`                         | Saldo ficticio, en unidades mayores, al que se recarga la cartera en cada despliegue |
| `CERT_HOTEL_MARKUP_PERCENT`             | `5`                             | Markup de hoteles del tenant                                                         |
| `CERT_TBO_BASE_URL`                     | la de test del ACL              | Sólo el host de test de TBO; cualquier otro se rechaza                               |
| `CERT_PROVIDERS_DISABLED`               | vacío                           | Kill-switch: `tbo-hotels` o `tbo-hotels:ventas`. Le gana al ajuste del seed          |
| `CERT_PROVIDER_PAYLOADS_RETENTION_DAYS` | `30`                            | Retención de la bóveda de RQ/RS                                                      |
| `CERT_CATALOG_COUNTRIES`                | ninguno                         | Países ISO2 del catálogo de TBO (hasta 5). Obligatoria para el sync del catálogo     |
| `CERT_CATALOG_CITIES`                   | ninguno                         | `CityCode` de TBO (hasta 20). Obligatoria con `cert_catalog: hotels`                 |
| `CERT_CATALOG_MAX_CALLS`                | `500`                           | Llamadas a TBO por corrida del sync del catálogo (1 a 5000)                          |

Sin `CERT_SUPPORT_EMAIL` y `CERT_SUPPORT_PHONE` el seed carga los de por defecto, porque el Book no reserva sin un
contacto de la agencia (D-TBO-23 A) y el `vendedor` no puede cargarlo: _Mi Agencia_ es de administradores. El teléfono
va con `+` y el prefijo de país, no en dígitos sueltos como el `TBO_CERT_PHONE` del arnés, y puede quedarse ficticio.
Si alguien tiene que leer lo que TBO mande al buzón, se crea ese alias en el dominio o se pone un buzón de rol que ya
exista, como el `TBO_CERT_EMAIL` del arnés; nunca uno personal.

Del lado de producción sólo usa el acceso SSH (`HOSTINGER_HOST`, `HOSTINGER_USER`, `HOSTINGER_SSH_KEY`,
`HOSTINGER_SSH_PORT`).

### 9.3 Desplegar

Actions → **Deploy** → Run workflow → `target: cert`. Sin `image_tag` usa la imagen que corre producción en ese momento
(lo que TBO certifica es lo que se vende); con `image_tag`, esa. No construye nada.

El job escribe `.env` y `seed.env` con [`render-cert-env.mjs`](./render-cert-env.mjs) (lista cerrada), los copia a
`/opt/sales-travel-cert`, hace `pull` y `up`, corre el seed con `docker run --env-file seed.env` en la red interna del
stack, **borra `seed.env`** y espera a que `cert-api` responda `/api/health`. Un paso con `if: always()` vuelve a
borrar `seed.env` aunque el del seed no llegue a correr (rsync a medias, job cancelado), y si no puede, el job queda en
rojo. El smoke test final pide `https://cert-app.planetour.cloud/login`.

El seed corre en cada despliegue y es idempotente: cambiar un secret o una variable y volver a desplegar es la forma de
rotar la contraseña del vendedor, cambiar la cuenta de TBO o suspender al usuario.

Con `cert_catalog` distinto de `none`, al final corre además el sync del catálogo de TBO (§9.4).

### 9.4 Catálogo de TBO

La base del stack empieza sin el catálogo de TBO (`docs/tbo/07` §7.3 punto 6): sin él, _Destino_ no sugiere nada y la
búsqueda responde que el catálogo no está sincronizado. Lo baja
[`tools/sync-tbo-hotel-inventory`](../../tools/sync-tbo-hotel-inventory/README.md), la misma imagen que el sync de
producción y con el tag del stack, desde el job `deploy-cert` y **sólo si se pide** con el input `cert_catalog`:

| `cert_catalog` | Etapas | Qué baja                                                                               | Llamadas a TBO                |
| -------------- | ------ | -------------------------------------------------------------------------------------- | ----------------------------- |
| `none`         | —      | Nada (por defecto)                                                                     | 0                             |
| `cities`       | E1, E2 | La lista de ciudades de `CERT_CATALOG_COUNTRIES`, para elegir los `CityCode`           | 1 + una por país              |
| `hotels`       | E3, E4 | Hoteles (nombre, estrellas, dirección) y contenido en español de `CERT_CATALOG_CITIES` | una por ciudad + hoteles / 10 |

Siempre sobre una lista cerrada: hasta 5 países y 20 ciudades, `CERT_CATALOG_MAX_CALLS` llamadas (500 por defecto) y
20 minutos por corrida. Sin `CERT_CATALOG_CITIES`, `hotels` no despliega: recorrería todas las ciudades del país en el
orden de sus códigos.

- **Cuenta.** La de **test** del stack (`CERT_TBO_USERNAME`, `CERT_TBO_PASSWORD`, `CERT_TBO_BASE_URL`), la misma que el
  seed guarda en la bóveda; nunca las `TBO_SYNC_*` de producción. Llega al sync como **override** (`TBO_SYNC_USERNAME`
  y `TBO_SYNC_PASSWORD` en `catalog.env`), no por la bóveda como en producción: el seed la guarda en el consolidador
  `tbo-cert` y el sync sólo lee la raíz `platform`, así que `catalog.env` no lleva `PROVIDER_CREDENTIALS_KEY`. Comparte
  el cupo de peticiones con las búsquedas de los testers (D-TBO-04, [Q-93](../../docs/tbo/10-preguntas-para-tbo.md#q-93)):
  se corre antes de enviar la guía del portal, no mientras TBO la recorre.
- **Credenciales.** `render-cert-env.mjs` escribe `catalog.env` con lista cerrada, como `seed.env`. El paso lo copia al
  VPS, crea el contenedor con `--env-file` y lo borra antes de llamar a TBO. El paso de limpieza del final
  (`Remove seed.env and catalog.env`, `if: always()`) lo vuelve a borrar pase lo que pase.
- **Redes.** `sales-travel-cert_internal` (Postgres) y `sales-travel-cert_egress` (TBO), las del api del stack.
- **Mientras corre**, un push a `main` espera: el job comparte el grupo de `concurrency` de producción.
- **Cada despacho redespliega el stack**, y el seed recarga la cartera a `CERT_WALLET_BALANCE` (§9.3).

Primera corrida, con `gh` (o Actions → **Deploy** → Run workflow con los mismos valores):

```bash
# 1. Países de la lista cerrada, en el entorno tbo-cert (una vez).
gh variable set CERT_CATALOG_COUNTRIES --env tbo-cert --body 'CO'

# 2. Lista de ciudades de esos países: E1 y E2, sin hoteles.
gh workflow run deploy.yml -f target=cert -f cert_catalog=cities
```

```bash
# 3. En el VPS: elegir los CityCode. `name_norm` va en minúsculas y sin acentos. Para las ciudades de los HotelCodes
#    de test de docs/tbo/07 §4.1, su `CityId` sale de HotelDetails (Postman: `Hotel Details`).
cd /opt/sales-travel-cert
docker compose -f docker-compose.cert.yml --env-file .env exec -T postgres \
  psql -U postgres -d sales_travel_cert -c "
    SELECT provider_city_code, name, country_code
      FROM hotel_provider_city
     WHERE provider_code = 'tbo-hotels' AND name_norm LIKE '%bogota%'
     ORDER BY name"
```

```bash
# 4. Hoteles y contenido de esas ciudades (CityCode separados por coma, sin espacios).
gh variable set CERT_CATALOG_CITIES --env tbo-cert --body '<CityCode>,<CityCode>'
gh workflow run deploy.yml -f target=cert -f cert_catalog=hotels
```

El log del paso `Sync TBO catalog` termina con una línea `tbo.sync.result` con `ok: true`. Con `outcome: "partial"` el
presupuesto no alcanzó: se repite el paso 4 y la corrida sigue donde quedó (las ciudades ya recorridas no se vuelven a
pedir en 7 días). Una línea `tbo.sync.cities_unknown` nombra los `CityCode` que no están en la lista de ciudades de
esos países: un código mal copiado o un país que falta en `CERT_CATALOG_COUNTRIES`.

Comprobación en el VPS: cada ciudad de la lista con `synced_at`, hoteles activos y contenido en español.

```bash
docker compose -f docker-compose.cert.yml --env-file .env exec -T postgres \
  psql -U postgres -d sales_travel_cert -c "
    SELECT c.provider_city_code, c.name, c.synced_at,
           count(DISTINCT h.hotel_id) AS hoteles_activos,
           count(DISTINCT hc.hotel_id) AS con_contenido_es
      FROM hotel_provider_city c
      LEFT JOIN hotel_inventory h
        ON h.provider_code = c.provider_code AND h.provider_city_code = c.provider_city_code AND h.active
      LEFT JOIN hotel_content hc
        ON hc.provider_code = h.provider_code AND hc.hotel_id = h.hotel_id
       AND hc.lang = 'es' AND hc.source = 'details'
     WHERE c.provider_code = 'tbo-hotels' AND c.synced_at IS NOT NULL
     GROUP BY 1, 2, 3
     ORDER BY 1"
```

Después, en `https://cert-app.planetour.cloud`, _Hoteles_ → _Destino_ sugiere esas ciudades.

### 9.5 Operaciones

```bash
cd /opt/sales-travel-cert
docker compose -f docker-compose.cert.yml --env-file .env ps
docker compose -f docker-compose.cert.yml --env-file .env logs -f cert-api

# Borrar el stack y sus datos al cerrar la certificación.
docker compose -f docker-compose.cert.yml --env-file .env down -v
```

TBO queda encendido para `tbo-cert` por un ajuste de tenant en `provider_enablement` que el seed repone en cada
despliegue ([`docs/tbo/07`](../../docs/tbo/07-certificacion.md) §7.3 punto 9), y el compose del stack mantiene además
la variable legado `HOTEL_PROVIDERS_OPT_IN: tbo-hotels` (§6.1). El job del stack no siembra un superadmin, así que su
panel de plataforma no se usa para esto. Para apagar TBO en el stack sin tocar la imagen: variable
`CERT_PROVIDERS_DISABLED=tbo-hotels` (o `tbo-hotels:ventas`, que deja consultar y cancelar lo reservado) y desplegar;
le gana al ajuste del seed.

### 9.6 Lo que falta para que el tester busque

- **Destinos.** Las sugerencias de destino (`GET /hotels/suggestions`) salen del proveedor de plataforma
  (`despegar-hotels`) cuando la agencia lo tiene; en este stack no lo tiene (RC-07), así que salen del catálogo local
  de TBO (`hotel_provider_city`, sólo ciudades con hoteles activos) con ids `tbo-hotels:<CityCode>` que la búsqueda
  resuelve sin el mapa de destinos ([`docs/tbo/05`](../../docs/tbo/05-contenido-estatico-e-inventario.md) §8.5).
  Requiere la imagen con ese cambio y el catálogo del punto siguiente: sin ciudades sincronizadas no hay qué sugerir.
- **Catálogo.** La base del stack empieza sin el catálogo de TBO (07 §7.3.6): hay que correr el sync del catálogo
  (§9.4) al menos para las ciudades de los `HotelCodes` de test.

---

## 10. Quién es el cliente: la IP real del usuario

El api usa la IP del usuario (`currentContext().ip`) en:

- la clave del rate limiting (`IpThrottlerGuard`: 10 logins por minuto, 300 peticiones por minuto);
- `sessions.ip`: los dispositivos de _Seguridad_ y las sesiones que ve un admin en _Puestos_ y en el paso de puestos
  llenos del login;
- `trusted_devices.ip` ("recordar este equipo") y `password_reset_tokens.requested_ip`;
- la auditoría (los eventos de `domain_events`).

Tiene que ser la del usuario, la misma entre por donde entre, y nadie tiene que poder elegirla. Todas cambian de valor
con el primer despliegue de esta cadena: hasta ahí guardaban la IP del contenedor del panel (lo que entraba por el
panel) o la del borde de Cloudflare (lo que llegaba directo al api).

### 10.1 La cadena

```
navegador ──▶ Cloudflare ──▶ Caddy ──┬──▶ api                 (api.planetour.cloud)
                                     └──▶ web-b2b ──(red interna)──▶ api
```

1. **Cloudflare** escribe `CF-Connecting-IP` con la IP del usuario, pisando la que mande el cliente.
2. **Caddy decide.** Cree `CF-Connecting-IP` sólo si la conexión TCP viene de un rango de Cloudflare
   (`trusted_proxies` + `client_ip_headers` en las opciones globales del [`Caddyfile`](./Caddyfile)). Si viene de
   cualquier otro lado, el usuario es el peer TCP, que no se falsifica. El resultado es `{client_ip}`, y el snippet
   `client_origin` lo escribe en `X-Edge-Peer-IP` (y en `X-Real-IP` y `X-Forwarded-For`) hacia el api y los paneles,
   pisando lo que haya mandado el cliente. El nombre `X-Edge-Peer-IP` es histórico: ya no lleva el peer TCP, que
   detrás de Cloudflare es un servidor de su borde que rota entre conexiones.
3. **El panel reenvía.** web-b2b llama al api por la red interna, sin Caddy: sin más, el api vería la IP del contenedor
   para todos los usuarios del panel. Manda la `X-Edge-Peer-IP` que recibió en `x-client-ip`, el navegador en
   `x-client-user-agent` y `x-internal-proxy: <INTERNAL_PROXY_SECRET>`
   ([`apps/web-b2b/src/lib/api.ts`](../../apps/web-b2b/src/lib/api.ts)). También las rutas que llaman al api sin
   `api()`, como `/api/airports`: un test del panel falla si alguna lee `INTERNAL_API_URL` sin `clientOriginHeaders`.
4. **El api confía** en `x-client-*` sólo con el secreto correcto; si no, usa `X-Edge-Peer-IP`
   ([`client-origin.ts`](../../apps/api/src/request-context/client-origin.ts)). Nunca lee `CF-Connecting-IP`. El
   throttler cuenta una IPv4 sola y una IPv6 por su red /64, que es lo mínimo que tiene cualquier conexión IPv6 y
   dentro de la cual elige la dirección libremente.

Caddy borra `x-internal-proxy`, `x-client-ip` y `x-client-user-agent` de todo request que llega de afuera: aunque el
secreto se filtrara, desde internet no serviría. `INTERNAL_PROXY_SECRET` lo deriva `deploy.yml` del `JWT_SECRET` (§3).

Dos reglas del `Caddyfile` que vigila el test
[`caddyfile-client-ip.guard.test.ts`](../../apps/api/src/request-context/caddyfile-client-ip.guard.test.ts):

- **Nunca borrar una cabecera que también se escribe.** Caddy aplica primero todos los `header_up X valor` y después
  todos los `header_up -X`, sin importar el orden en que están escritos. Hasta 2026-09-29 el Caddyfile tenía
  `header_up -X-Edge-Peer-IP` antes de `header_up X-Edge-Peer-IP {remote_host}`: la cabecera no llegaba nunca, el
  panel no mandaba IP y todo el panel contaba como un solo cliente (el usuario 11 del minuto recibía 429 al entrar).
- **Sin `private_ranges` en `trusted_proxies`.** Cloudflare llega por IPv4 (los registros son `A`), y Docker entrega
  esas conexiones con la IP de origen intacta. Lo único privado que conecta a Caddy es el `docker-proxy` que atiende la
  IPv6 del VPS, y confiar en él dejaría inventar `CF-Connecting-IP` a quien llegue directo al origen por IPv6.

### 10.2 Rangos de Cloudflare

`trusted_proxies` lleva la lista de https://www.cloudflare.com/ips-v4 y https://www.cloudflare.com/ips-v6 (al
2026-09-29), y el test de arriba tiene la misma lista en `CLOUDFLARE_RANGES`. Para comprobar si sigue igual, desde la
raíz del repo:

```bash
diff <(curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6; echo) \
     <(grep -m1 'trusted_proxies static' infrastructure/hostinger/Caddyfile | tr -s ' \t' '\n' | tail -n +4)
```

El job `deploy` corre esta misma comparación (paso _Cloudflare ranges vs trusted_proxies_) y, si hay diferencias, deja
un `::warning::` en el resumen del run sin frenar el despliegue.

Sin diferencias no hay nada que hacer. Si las hay: actualizar la línea `trusted_proxies static …` del Caddyfile (una
sola línea: `static` sólo lee los argumentos de la suya), en el orden de las dos listas, y `CLOUDFLARE_RANGES` del
test, y desplegar. Mientras falte un rango, los usuarios que Cloudflare atienda desde él quedan identificados por el
servidor de Cloudflare y no por su IP: comparten cupo con miles de otros y pueden recibir 429 al entrar. Las reglas de
UFW de `provision.sh` bajan la lista en vivo y no dependen de esto.

**A `trusted_proxies` entra SÓLO lo que publican esas dos listas, nunca una IP vista en `sessions` o en un log.**
Cloudflare también es dueña de direcciones que no son de su borde: 104.28.x en adelante son las salidas de WARP, Zero
Trust e iCloud Private Relay, o sea, IPs de usuarios. Confiar en un rango así dejaría a cualquiera con el cliente
gratuito de WARP llegar directo al origen e inventarse `CF-Connecting-IP` (un cupo nuevo en cada intento, o la IP de
otro en sesiones y auditoría). El test fija la lista exacta a propósito: no "arreglarlo" agregando rangos.

### 10.3 Cómo se aplica un Caddyfile nuevo

Caddy monta `./Caddyfile` como archivo suelto, y un bind mount de archivo sigue al inodo que existía al crear el
contenedor. `rsync` no escribe encima: crea un archivo nuevo y lo renombra. Hasta 2026-09-29 un Caddyfile nuevo quedaba
en disco sin que Caddy lo viera, hasta que algo recreara el contenedor.

Ahora el job `deploy` de [`deploy.yml`](../../.github/workflows/deploy.yml):

1. Copia el Caddyfile al VPS como `Caddyfile.next`, sin tocar el montado.
2. Después de `pull` y **antes de `up`**, lo valida con la imagen de Caddy que va a correr
   (`docker compose run --rm --no-deps -T caddy caddy validate --adapter caddyfile --config - < Caddyfile.next`). Si no
   carga, el paso queda en rojo y en el VPS no cambió nada. Los avisos `Unnecessary header_up X-Forwarded-Host` y
   `…-Proto` son esperables: suponen que Caddy no confía en ningún proxy (comentario del snippet `client_origin`).
3. Si cambió, guarda el anterior en `Caddyfile.prev` y escribe el nuevo encima del montado con
   `cat Caddyfile.next > Caddyfile`, que conserva el inodo. También **antes de `up`**: si el `pull` trajo otra imagen de
   Caddy, `up` recrea el contenedor, y así arranca con el archivo que se acaba de validar en esa imagen.
4. Tras `up`, si el contenedor ya ve el archivo nuevo, `caddy reload` lo aplica sin cortar conexiones (y no hace nada
   si la configuración no cambió). Lo intenta hasta cinco veces, cada 3 s: si `up` acaba de recrear Caddy, su API de
   admin puede no estar escuchando todavía. Si los cinco fallan, Caddy sigue con la configuración que tenía (el reload
   es atómico), el paso devuelve `Caddyfile.prev` al disco para que un reinicio no cargue lo que no cargó, y queda en
   rojo con un `::error::`.
5. Si el contenedor no ve el archivo nuevo, porque monta un inodo que un rsync anterior ya reemplazó, lo recrea (unos
   segundos sin servir; los certificados siguen en el volumen `caddy_data`) y lo avisa con un `::warning::`. Eso pasa
   una vez: en el primer despliegue con este paso.

A mano en el VPS, lo mismo:

```bash
cd /opt/sales-travel
docker compose --env-file .env exec -T caddy caddy validate --adapter caddyfile --config - < Caddyfile.next
cat Caddyfile.next > Caddyfile
docker compose --env-file .env exec -T caddy caddy reload --adapter caddyfile --config /etc/caddy/Caddyfile
```

No editar `Caddyfile` en el VPS con un editor que guarda en un archivo nuevo (renombrando): el contenedor volvería a
quedarse con el viejo. El próximo despliegue lo detecta y recrea Caddy.

### 10.4 Verificar después del despliegue

Primero, en el run de _Deploy_ (paso _Pull & up_): sin `::error::`. El primer despliegue con este cambio deja además
el `::warning::` "Caddy montaba un Caddyfile viejo" (§10.3, punto 5); en los siguientes ya no debería aparecer.

```bash
cd /opt/sales-travel

# 1. Caddy ve el MISMO archivo que está en disco (no un inodo viejo que dejó un rsync).
docker compose exec -T caddy cat /etc/caddy/Caddyfile | cmp - Caddyfile && echo "OK: Caddy ve ./Caddyfile"

# 2. Y lo cargó: la configuración EN USO (API de admin de Caddy) tiene CF-Connecting-IP y los rangos de Cloudflare.
docker compose exec -T caddy wget -qO- http://localhost:2019/config/apps/http/servers \
  | grep -o '"client_ip_headers":\[[^]]*\]'
# → "client_ip_headers":["CF-Connecting-IP"]
docker compose exec -T caddy wget -qO- http://localhost:2019/config/apps/http/servers \
  | grep -o '"trusted_proxies":{[^}]*}'
# → los 22 rangos de §10.2 y "source":"static"

# 3. X-Edge-Peer-IP trae la IP del usuario (root; tráfico HTTP plano de la red de Docker). Mientras corre (30 s),
#    abrí https://app.planetour.cloud en tu navegador. Muestra IPs de otros usuarios: no guardar la salida.
#    El grep deja afuera x-internal-proxy (el secreto).
sudo timeout 30 tcpdump -i any -l -A -s0 'tcp dst port 3001 or tcp dst port 3000' 2>/dev/null \
  | grep -iE --line-buffered '^(x-edge-peer-ip|x-client-ip):'
# → X-Edge-Peer-Ip: <tu IP>   (Caddy → panel y Caddy → api)
# → X-Client-Ip: <tu IP>      (panel → api, por la red interna)

# 4. Las sesiones nuevas guardan IPs de usuarios, no de Docker (172.x) ni del borde de Cloudflare.
docker compose exec -T postgres psql -U postgres -d sales_travel -c \
  "SELECT issued_at, host(ip) AS ip, left(user_agent, 40) AS navegador FROM sessions ORDER BY issued_at DESC LIMIT 10"
```

Y desde tu equipo: la IP con la que te ve Cloudflare (`curl -s https://app.planetour.cloud/cdn-cgi/trace | grep ^ip=`)
tiene que ser la del paso 3, la de tu sesión más reciente en el paso 4 y la de _Seguridad_, después de volver a entrar
al panel.

Opcional, el cupo por cliente: desde tu equipo, 11 POST vacíos al login (el throttler cuenta antes de validar el cuerpo,
así que no hace falta ninguna credencial). El 11.º tiene que dar `429`, y en ese mismo minuto el panel tiene que dejar
entrar desde otra red (el móvil con datos, sin Wi-Fi). Antes de este cambio el 429 le llegaba a todos.

```bash
for i in $(seq 1 11); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.planetour.cloud/api/auth/login \
    -H 'content-type: application/json' -d '{}'
done
# → diez 400 y un 429
```

- Si aparece una IP que está dentro de la lista de §10.2 (el borde de Cloudflare: 104.16.x–104.27.x, 172.64.x–172.71.x,
  162.158.x–162.159.x…; compararla con la lista, no a ojo), Caddy no la está resolviendo: el Caddyfile en uso no es el
  nuevo (paso 1) o Cloudflare llega por un camino que no preserva la IP (por ejemplo, un registro `AAAA` que haga
  entrar el tráfico por el `docker-proxy`, §10.5).
- Una 104.28.x o más alta **no** es un error: es un usuario detrás de WARP o de iCloud Private Relay (§10.2). No se
  agrega a `trusted_proxies`.
- Si aparece una IP privada de Docker (172.16.x–172.31.x), Caddy no está escribiendo `X-Edge-Peer-IP` o el panel no la
  reenvía: revisar el paso 1 y que api y panel tengan el mismo `INTERNAL_PROXY_SECRET` (§10.1).

### 10.5 Límites conocidos

- **El origen no está cerrado a Cloudflare.** Docker publica 80/443 con reglas propias de iptables que se evalúan antes
  que las de UFW, así que las de `provision.sh` no filtran esos puertos. Para la IP no importa (lo que no viene de
  Cloudflare se identifica por su peer TCP), pero quien conozca la IP del VPS esquiva el WAF. Cerrarlo es configuración
  del host (cadena `DOCKER-USER`), no de este Caddyfile.
- **IPv6 del VPS.** Si algún día Cloudflare llega por IPv6 (un registro `AAAA`) con la red de Docker sólo IPv4, esas
  conexiones pasan por el `docker-proxy` y Caddy ve una IP de Docker: todos esos usuarios compartirían cupo. Habilitar
  IPv6 en la red `edge` antes de publicar un `AAAA`.
- **El cupo de una IPv6 es su /64, en los dos sentidos.** Es la IPv6 equivalente de una IPv4 detrás de NAT: una casa o
  una oficina recibe un /64 y todos sus equipos comparten cupo, como comparten la IPv4 pública. Dos consecuencias
  aceptadas a sabiendas:
  - _Usuarios distintos en el mismo /64 comparten los 10 logins y las 300 peticiones por minuto._ Pasa con iCloud
    Private Relay (Apple publica sus salidas IPv6 como un puñado de /64 por ciudad) y con hostings que reparten /128 de
    un /64 común entre clientes (una integración que llame directo al api desde un VPS así). Hoy el volumen del panel no
    llega a esos topes; si aparecen 429 legítimos, la salida es subir el tope global para claves `…::/64` o contar por
    dirección fuera de las rutas de login, no volver a la dirección entera en el login.
  - _Quien tiene un prefijo más grande sigue teniendo varios cupos._ Un /56 residencial son 256 cupos y un /48 (gratis
    en túneles como Hurricane Electric) 65.536. Frente a lo anterior (un cupo por dirección, 2^64 por /64) es un límite
    real, y el bloqueo por cuenta del login (`locked_until`) no depende de la IP; lo que queda expuesto es probar pocas
    contraseñas contra muchas cuentas. Un segundo cupo por /48 en las rutas de login lo cerraría.
