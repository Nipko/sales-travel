# Hostinger VPS · deploy via Portainer

Deploy gestionado por **Portainer** sobre el VPS Hostinger detrás de Cloudflare.
GitHub Actions se ocupa sólo de buildear y publicar imágenes a GHCR; Portainer
las pulla y orquesta el stack.

## Topología

```
Internet
   │
   ▼
Cloudflare  (TLS edge · WAF · DDoS · cache)
   │  (Full strict, sólo IPs Cloudflare permitidas en origen)
   ▼
Hostinger VPS (Portainer instalado)
   │
   └── Stack "sales-travel" (Portainer)
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

## 1. Configurar GHCR como registry en Portainer

Las imágenes del proyecto son privadas (`ghcr.io/nipko/sales-travel-*`).
Portainer necesita credenciales:

1. En GitHub: crear un Personal Access Token (classic) con scope `read:packages`.
2. Portainer → **Registries → Add registry → Custom**:
   - URL: `ghcr.io`
   - Username: tu usuario de GitHub
   - Password: el PAT
3. Guardar.

---

## 2. Crear el stack desde GitHub (Repository mode)

Portainer → **Stacks → Add stack**:

- **Name:** `sales-travel`
- **Build method:** *Repository*
- **Repository URL:** `https://github.com/Nipko/sales-travel`
- **Repository reference:** `refs/heads/main`
- **Compose path:** `infrastructure/hostinger/docker-compose.prod.yml`
- **Authentication:** sólo si el repo es privado (token con `repo` scope).
- **Automatic updates:** activar **Re-pull image** y **Force redeployment**.
- **Polling interval:** `5m` o usar **Webhook** (recomendado, ver §4).

### Environment variables (en el panel "Environment variables" del stack)

| Variable | Cómo generarla |
|---|---|
| `IMAGE_TAG`              | `latest` (o un SHA específico para pinear versión) |
| `POSTGRES_ADMIN_PASSWORD`| `openssl rand -base64 32` |
| `APP_USER_PASSWORD`      | `openssl rand -base64 32` |
| `REDIS_PASSWORD`         | `openssl rand -base64 32` |
| `JWT_SECRET`             | `openssl rand -base64 64` (mínimo 32 chars) |

Click **Deploy the stack**.

---

## 3. DNS en Cloudflare

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
| A | `*.tenants`  | `apps/web-b2b` (wildcard) | cuando se active routing white-label por tenant |

> Para `*.tenants` se requiere cambiar Caddy a DNS-01 challenge (Cloudflare API token con permiso `Zone:DNS:Edit`); HTTP-01 no soporta wildcards.

SSL/TLS mode: **Full (strict)**. Caddy obtiene certificado vía Let's Encrypt
automáticamente al primer tráfico. El `Caddyfile` ya tiene los bloques para
`web-b2c`, `web-admin` y wildcard de tenants comentados — basta descomentar
cuando llegue el momento.

---

## 4. Auto-redeploy desde GitHub Actions (recomendado)

GitHub Actions buildea las 3 imágenes en cada push a `main` y las publica como
`ghcr.io/nipko/sales-travel-{api,web-b2b,migrate}:{sha,latest}`. Para que
Portainer redeploye automáticamente al terminar el build:

1. En Portainer → Stack `sales-travel` → **Webhooks → Create webhook**. Copiar la URL.
2. En GitHub → Repo Settings:
   - **Variables → New repository variable**: `PORTAINER_WEBHOOK_ENABLED = true`
   - **Secrets → New repository secret**: `PORTAINER_WEBHOOK_URL = <url copiada>`
3. Próximo push a `main` ejecuta build → push GHCR → hit webhook → Portainer pulla y redeploya.

Sin webhook: Portainer puede pollear el repo cada N minutos (configurado en §2).
Con webhook: redeploy en segundos al terminar el build.

---

## 5. Hardening del firewall (opcional pero recomendado)

Si el VPS no tiene UFW configurado para limitar 80/443 a IPs de Cloudflare,
ejecutar `infrastructure/hostinger/provision.sh` como root. Idempotente; sólo
toca UFW + fail2ban + unattended-upgrades. No instala nada que rompa Portainer.

```bash
scp infrastructure/hostinger/provision.sh root@<IP>:/tmp/
ssh root@<IP> "bash /tmp/provision.sh"
```

---

## 6. Operaciones comunes (vía Portainer UI)

- **Logs:** Stack → servicio → *Logs*
- **Restart de un servicio:** Stack → servicio → *Restart*
- **Redeploy manual:** Stack → *Update the stack* → activar *Re-pull image*
- **Pinear una versión:** cambiar `IMAGE_TAG` env var al SHA deseado y redeploy
- **Backup Postgres:** Container `postgres` → *Console* → `pg_dumpall -U postgres > /tmp/backup.sql`, luego *Files* o `docker cp`

---

## 7. Cuándo migrar a AWS

Triggers definidos en `docs/discovery/02-decisiones-segunda-ronda.md`:
- > 500 reservas/día sostenido
- SLA contractual > 99.5%
- NDC/proveedor adicional con requerimiento PCI L1
- > 100 k USD/mes en pagos procesados

El stack está diseñado portable: las mismas imágenes corren idéntico en
ECS/Fargate. Postgres → RDS, MinIO → S3, Redis → ElastiCache. Sin cambios
de código en `apps/`.
