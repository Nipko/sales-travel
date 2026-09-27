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
   │  (Full strict, sólo IPs Cloudflare permitidas en origen)
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
6. UFW: deny incoming por default. Sólo permite `:22` (SSH) y `:80/:443` desde rangos de Cloudflare.
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

| Variable             | Default | Uso                                          |
| -------------------- | ------- | -------------------------------------------- |
| `HOSTINGER_SSH_PORT` | `22`    | Si cambiaste el puerto SSH en `provision.sh` |

> El PAT de GHCR se usa **una sola vez** durante el provisioning del VPS para `docker login`. **No** va en GitHub Actions: el push a GHCR usa `GITHUB_TOKEN` automáticamente.

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
3. CI hace SSH al VPS, sincroniza compose+Caddyfile+postgres-init, render `.env` desde secrets, `docker compose pull && up -d`.
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

---

## 7. Crear el primer superadmin

Después del primer deploy verde, crear tu cuenta superadmin con la imagen
`seed-superadmin` (one-shot, idempotente). Como `deploy` en el VPS:

```bash
cd /opt/sales-travel
set -a; source .env; set +a   # exporta POSTGRES_ADMIN_PASSWORD al entorno

docker run --rm --network sales-travel_internal \
  -e PGHOST=postgres \
  -e PGPORT=5432 \
  -e PGUSER=postgres \
  -e PGPASSWORD="${POSTGRES_ADMIN_PASSWORD}" \
  -e PGDATABASE=sales_travel \
  -e SUPERADMIN_EMAIL="nirlevin89@gmail.com" \
  -e SUPERADMIN_PASSWORD="<una-contraseña-fuerte>" \
  -e SUPERADMIN_NAME="Nir Levin" \
  ghcr.io/nipko/sales-travel-seed-superadmin:latest
```

Output esperado: `{"ok":true,"action":"created","userId":"...","tenantId":"...","tenantSlug":"platform","email":"..."}`.

Vars opcionales (defaults): `SUPERADMIN_TENANT_SLUG=platform`, `SUPERADMIN_TENANT_NAME=Platform`,
`SUPERADMIN_TENANT_COUNTRY=CO`, `SUPERADMIN_TENANT_CURRENCY=USD`.

Re-correrlo con el mismo email **rota la contraseña** (idempotente).

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

| Variable                                | Por defecto                  | Uso                                                                                  |
| --------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `CERT_CURRENCY`                         | `USD`                        | Moneda del tenant y de la cartera: la de perfil de la cuenta de test (`check`)       |
| `CERT_VENDEDOR_EMAIL`                   | `tbo.tester@planetour.cloud` | Usuario de login de los testers                                                      |
| `CERT_VENDEDOR_NAME`                    | `TBO Tester`                 | Nombre visible del usuario                                                           |
| `CERT_VENDEDOR_STATUS`                  | `active`                     | `suspended` tras el sign-off: cierra sus sesiones y no vuelve a entrar               |
| `CERT_TENANT_NAME`                      | `Sales-Travel Certification` | Nombre neutro del tenant (07 §7.3.1)                                                 |
| `CERT_COUNTRY`                          | `CO`                         | País del tenant                                                                      |
| `CERT_WALLET_BALANCE`                   | `50000`                      | Saldo ficticio, en unidades mayores, al que se recarga la cartera en cada despliegue |
| `CERT_HOTEL_MARKUP_PERCENT`             | `5`                          | Markup de hoteles del tenant                                                         |
| `CERT_TBO_BASE_URL`                     | la de test del ACL           | Sólo el host de test de TBO; cualquier otro se rechaza                               |
| `CERT_PROVIDERS_DISABLED`               | vacío                        | Kill-switch del stack: `tbo-hotels` o `tbo-hotels:ventas`                            |
| `CERT_PROVIDER_PAYLOADS_RETENTION_DAYS` | `30`                         | Retención de la bóveda de RQ/RS                                                      |

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

### 9.4 Operaciones

```bash
cd /opt/sales-travel-cert
docker compose -f docker-compose.cert.yml --env-file .env ps
docker compose -f docker-compose.cert.yml --env-file .env logs -f cert-api

# Borrar el stack y sus datos al cerrar la certificación.
docker compose -f docker-compose.cert.yml --env-file .env down -v
```

Para apagar TBO en el stack sin tocar la imagen: variable `CERT_PROVIDERS_DISABLED=tbo-hotels` y desplegar.

### 9.5 Lo que falta para que el tester busque

- **Destinos.** Las sugerencias de destino (`GET /hotels/suggestions`) salen hoy del proveedor de plataforma
  (`despegar-hotels`), y el mapa de destinos de TBO (`hotel_destination_map`) usa como origen los ids de destino de
  Despegar. En este stack no hay credenciales de Despegar (RC-07): el vendedor no puede elegir destino hasta que el api
  sugiera destinos desde el catálogo local cuando no hay proveedor de plataforma.
- **Catálogo.** La base del stack empieza sin el catálogo de TBO (07 §7.3.6): hay que correr `sync-tbo-hotel-inventory`
  contra `sales_travel_cert`, al menos para las ciudades de los `HotelCodes` de test.
