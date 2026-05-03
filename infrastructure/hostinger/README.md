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

| Tipo | Nombre | Valor | Apunta a |
|---|---|---|---|
| A | `api`  | IP del VPS | `apps/api` (NestJS) |
| A | `app`  | IP del VPS | `apps/web-b2b` (panel agencia) |

### Sprint posterior (a medida que se sumen apps)

| Tipo | Nombre | Apunta a | Cuándo |
|---|---|---|---|
| A | `@` y `www`  | `apps/web-b2c`     | cuando exista el sitio público B2C |
| A | `admin`      | `apps/web-admin`   | cuando exista el panel superadmin |
| A | `*.tenants`  | `apps/web-b2b` (wildcard) | white-label dinámico |

> Para `*.tenants` se requiere cambiar Caddy a DNS-01 challenge (Cloudflare API token con permiso `Zone:DNS:Edit`); HTTP-01 no soporta wildcards.

SSL/TLS mode: **Full (strict)**. Caddy obtiene certificado vía Let's Encrypt
automáticamente. El `Caddyfile` ya tiene los bloques para `web-b2c`, `web-admin`
y wildcard de tenants comentados — basta descomentar cuando llegue el momento.

---

## 3. GitHub Actions — secrets y variables

### Repository → Settings → Secrets and variables → Actions

#### Secrets (todos requeridos)

| Secret | Cómo generarlo / qué poner |
|---|---|
| `HOSTINGER_HOST`           | IP pública del VPS (ej. `203.0.113.42`) |
| `HOSTINGER_USER`           | `deploy` |
| `HOSTINGER_SSH_KEY`        | Clave privada SSH (formato OpenSSH, contenido completo `-----BEGIN…END-----`) cuyo público está en `~deploy/.ssh/authorized_keys` del VPS |
| `POSTGRES_ADMIN_PASSWORD`  | `openssl rand -base64 32` — superuser, sólo migraciones |
| `APP_USER_PASSWORD`        | `openssl rand -base64 32` — rol runtime de `apps/api`, respeta RLS |
| `REDIS_PASSWORD`           | `openssl rand -base64 32` |
| `JWT_SECRET`               | `openssl rand -base64 64` (mínimo 32 chars; el código lo valida) |

#### Variables (opcionales)

| Variable | Default | Uso |
|---|---|---|
| `HOSTINGER_SSH_PORT` | `22` | Si cambiaste el puerto SSH en `provision.sh` |

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
