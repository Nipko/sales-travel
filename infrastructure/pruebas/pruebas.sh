#!/usr/bin/env bash
# Operación del ambiente de pruebas (Mac mini). Ver README.md de esta carpeta.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/.env"
TUNNEL_NAME="sales-travel-pruebas"
HOSTNAME_PUBLIC="pruebas.planetour.cloud"

compose() { docker compose --env-file "$ENV_FILE" -f "$HERE/docker-compose.yml" "$@"; }

need_env() {
  [[ -f "$ENV_FILE" ]] || { echo "Falta $ENV_FILE: corre primero ./pruebas.sh init" >&2; exit 1; }
}

cmd_init() {
  if [[ -f "$ENV_FILE" ]]; then echo "$ENV_FILE ya existe; no lo toco."; return; fi
  umask 077
  local b64='openssl rand -base64 32'
  cat >"$ENV_FILE" <<EOF
# Secretos PROPIOS del ambiente de pruebas, generados en esta Mac. No sirven en producción ni al revés.
POSTGRES_ADMIN_PASSWORD=$(openssl rand -hex 24)
APP_USER_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
INTERNAL_PROXY_SECRET=$(openssl rand -hex 32)
PROVIDER_CREDENTIALS_KEY=$($b64)
PROVIDER_PAYLOADS_KEY=$($b64)

# --- Proveedores: SOLO credenciales de sandbox/test. Vacío = proveedor sin credencial global. ---
# Sabre y TBO van por agencia (BYOC): se cargan desde el panel, en la bóveda de este ambiente.
LATAM_API_URL=https://sandbox.api.latam.com
LATAM_API_KEY=
LATAM_API_SECRET=
LATAM_AGENCY_ID=
LATAM_AGENCY_IATA=
LATAM_AGENCY_NAME=
LATAM_TRAVEL_AGENT_ID=
LATAM_COUNTRY=
DESPEGAR_API_KEY=
DESPEGAR_BASE_URL=https://api-dev.despegar.com/v3
AGENT_CARS_ACCESS_TOKEN=
AGENT_CARS_BASE_URL=https://api.dev.agentcars.com/v2/sites
SABRE_OPERATIONS=
EOF
  echo "Creado $ENV_FILE (permisos 600). Completa las credenciales de sandbox que tengas."
}

cmd_up() {
  need_env
  compose up -d --build --wait --wait-timeout 600 postgres redis migrate seed api web-b2b mailpit
  if [[ -f "$HOME/.cloudflared/config.yml" ]]; then compose --profile tunnel up -d tunnel; fi
  cmd_status
}

cmd_status() {
  need_env
  compose --profile tunnel ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
  printf '\napi:   '; curl -fsS http://127.0.0.1:4201/api/health || echo 'sin respuesta'
  printf '\npanel: '; curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3201/login || echo 'sin respuesta'
}

cmd_e2e() {
  need_env
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  cd "$REPO"
  command -v pnpm >/dev/null || corepack enable pnpm
  [[ -d node_modules ]] || pnpm install --frozen-lockfile
  cd apps/web-b2b
  npx playwright install chromium >/dev/null
  # Este stack sí tiene sandboxes: también corren las ventas @real (Sabre CERT, TBO test, Despegar).
  E2E_REAL=1 \
  E2E_WEB_URL=http://127.0.0.1:3201 \
  E2E_API_URL=http://127.0.0.1:4201 \
  E2E_PG_URL="postgres://postgres:${POSTGRES_ADMIN_PASSWORD}@127.0.0.1:5532/sales_travel" \
    npx playwright test "$@"
}

cmd_tunnel_setup() {
  command -v cloudflared >/dev/null || brew install cloudflared
  [[ -f "$HOME/.cloudflared/cert.pem" ]] || {
    echo "Abre la URL que aparece abajo, entra a Cloudflare y autoriza la zona planetour.cloud."
    cloudflared tunnel login
  }
  cloudflared tunnel info "$TUNNEL_NAME" >/dev/null 2>&1 || cloudflared tunnel create "$TUNNEL_NAME"
  local id
  id="$(cloudflared tunnel list --name "$TUNNEL_NAME" --output json | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"
  cat >"$HOME/.cloudflared/config.yml" <<EOF
tunnel: $id
credentials-file: /etc/cloudflared/$id.json
ingress:
  - hostname: $HOSTNAME_PUBLIC
    service: http://web-b2b:3001
  - service: http_status:404
EOF
  cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME_PUBLIC"
  need_env
  compose --profile tunnel up -d tunnel
  echo "Túnel listo: https://$HOSTNAME_PUBLIC (falta la política de Cloudflare Access, README §3)."
}

case "${1:-}" in
  init) cmd_init ;;
  up) cmd_up ;;
  down) need_env; compose --profile tunnel down ;;
  status) cmd_status ;;
  logs) need_env; shift; compose logs -f --tail 200 "$@" ;;
  e2e) shift; cmd_e2e "$@" ;;
  tunnel-setup) cmd_tunnel_setup ;;
  reset-db) need_env; compose --profile tunnel down -v ;;
  *) echo "Uso: $0 {init|up|down|status|logs [servicio]|e2e [args de playwright]|tunnel-setup|reset-db}" >&2; exit 2 ;;
esac
