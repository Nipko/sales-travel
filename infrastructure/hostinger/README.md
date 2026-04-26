# Hostinger VPS · provisioning & deploy

Infraestructura de fase 1: VPS único en Hostinger detrás de Cloudflare. Stack levantado con Docker Compose, deploy automatizado desde GitHub Actions.

## Topología

```
Internet
   │
   ▼
Cloudflare  (TLS edge · WAF · DDoS · cache)
   │  (Full strict, sólo IPs Cloudflare permitidas en origen)
   ▼
Hostinger VPS (Ubuntu 24.04 LTS)
   │
   └── Docker network "edge"
       ├── caddy        :80 / :443  (TLS origin · reverse proxy)
       ├── api          :3000       (NestJS — api.parallext.cloud)
       ├── web-b2b      :3001       (Next.js — app.parallext.cloud)
       ├── postgres     :5432       (TimescaleDB + pgvector, no expuesto)
       └── redis        :6379       (no expuesto)
```

Servicios diferidos hasta que un feature los requiera: `typesense`, `minio`, `temporal`, `ai-sidecar`.

---

## 1. Provisioning del VPS (one-time, manual)

Cuando contrates el VPS Hostinger:

1. Plan recomendado mínimo: **KVM 4** (4 vCPU · 16 GB RAM · 200 GB NVMe).
2. SO: **Ubuntu 24.04 LTS**.
3. Conectate por SSH como root con tu clave pública ya cargada.
4. Subí y ejecutá `provision.sh`:

   ```bash
   scp infrastructure/hostinger/provision.sh root@<IP>:/root/
   ssh root@<IP> "bash /root/provision.sh"
   ```

   El script instala Docker + Compose, crea usuario `deploy`, configura UFW (sólo IPs Cloudflare en 80/443 + tu IP en 22), y prepara `/opt/sales-travel/`.

5. Loguear en GHCR para imágenes privadas (única vez):

   ```bash
   ssh deploy@<IP>
   echo "<GHCR_PAT>" | docker login ghcr.io -u <github-user> --password-stdin
   ```

   El PAT debe tener scope `read:packages`.

---

## 2. DNS en Cloudflare

En la zona `parallext.cloud` agregá registros **proxied (orange cloud)**:

| Tipo | Nombre | Valor |
|---|---|---|
| A | `api`  | `<IP del VPS>` |
| A | `app`  | `<IP del VPS>` |

SSL/TLS mode: **Full (strict)**. Caddy obtiene cert via Let's Encrypt automáticamente.

---

## 3. Secrets en GitHub Actions

`Settings → Secrets and variables → Actions → New repository secret`:

| Secret | Contenido |
|---|---|
| `HOSTINGER_HOST`           | IP pública del VPS |
| `HOSTINGER_USER`           | `deploy` |
| `HOSTINGER_SSH_KEY`        | Clave privada SSH del usuario `deploy` (formato OpenSSH) |
| `POSTGRES_ADMIN_PASSWORD`  | Password del superuser `postgres` — sólo lo usan migraciones (`openssl rand -base64 32`) |
| `APP_USER_PASSWORD`        | Password del rol `app_user` (no-superuser, respeta RLS) — lo usa `apps/api` (`openssl rand -base64 32`) |
| `REDIS_PASSWORD`           | Password de Redis (`openssl rand -base64 32`) |
| `JWT_SECRET`               | Secret para firmas JWT (`openssl rand -base64 64`) |

---

## 4. Deploy

Push a `main` dispara `.github/workflows/deploy.yml`:

1. Build de imágenes Docker (`api`, `web-b2b`, `migrate`).
2. Push a `ghcr.io/nipko/sales-travel-{api,web-b2b,migrate}` con tag `<sha>` y `latest`.
3. SSH al VPS:
   - rsync de `docker-compose.prod.yml` + `Caddyfile` + `db/migrations` + `postgres-init` → `/opt/sales-travel/`
   - render de `.env` desde GitHub Secrets → `/opt/sales-travel/.env`
   - `docker compose pull && docker compose up -d --remove-orphans`
   - El servicio `migrate` corre antes que `api` (Compose `service_completed_successfully`) y aplica las migraciones SQL pendientes
   - `docker image prune -f`

Rollback: `docker compose pull` con el tag anterior + `up -d`. Cada SHA queda en GHCR.

---

## 5. Operaciones comunes

```bash
# Logs en vivo
ssh deploy@<IP> "cd /opt/sales-travel && docker compose logs -f api"

# Restart de un servicio
ssh deploy@<IP> "cd /opt/sales-travel && docker compose restart api"

# Backup de Postgres
ssh deploy@<IP> "docker compose exec -T postgres pg_dumpall -U postgres" > backup-$(date +%F).sql

# Estado
ssh deploy@<IP> "cd /opt/sales-travel && docker compose ps"
```

---

## 6. Cuándo migrar a AWS

Triggers definidos en `docs/discovery/02-decisiones-segunda-ronda.md`. Resumen:
- > 500 reservas/día sostenido
- SLA contractual > 99.5%
- NDC/proveedor adicional con requerimiento PCI L1
- > 100 k USD/mes en pagos procesados

Diseño portable: imágenes corren idéntico en ECS/Fargate. Postgres → RDS. MinIO → S3. Redis → ElastiCache. Sin cambios de código en `apps/`.
