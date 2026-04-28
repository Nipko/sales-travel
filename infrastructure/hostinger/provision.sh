#!/usr/bin/env bash
# Provisiona desde cero un VPS Ubuntu 24.04 LTS para sales-travel.
# Ejecutar como root. Idempotente — se puede correr varias veces sin romper nada.
#
# Variables opcionales:
#   DEPLOY_USER   (default: deploy)
#   SSH_PORT      (default: 22) — si lo cambiás, ajustar la var HOSTINGER_SSH_PORT en GH Actions
#   APP_DIR       (default: /opt/sales-travel)
#
# Al final, si está conectado a una TTY, pide credenciales GHCR para hacer
# `docker login` como el usuario deploy.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/sales-travel}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
SSH_PORT="${SSH_PORT:-22}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Este script debe correr como root." >&2
  exit 1
fi

echo "==> 1/8 Actualizando sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg ufw fail2ban unattended-upgrades \
  rsync git jq openssl

echo "==> 2/8 Instalando Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

echo "==> 3/8 Creando usuario $DEPLOY_USER"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"

mkdir -p "/home/$DEPLOY_USER/.ssh"
if [ -f /root/.ssh/authorized_keys ] && [ ! -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ]; then
  cp /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
fi
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
chmod 700 "/home/$DEPLOY_USER/.ssh"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys" 2>/dev/null || true

echo "==> 4/8 Creando $APP_DIR"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$APP_DIR"

echo "==> 5/8 SSH hardening en :$SSH_PORT"
SSHD_CONF="/etc/ssh/sshd_config.d/99-sales-travel.conf"
cat > "$SSHD_CONF" <<EOF
Port $SSH_PORT
PermitRootLogin prohibit-password
PasswordAuthentication no
PubkeyAuthentication yes
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
MaxAuthTries 3
LoginGraceTime 30
EOF
systemctl reload ssh || systemctl reload sshd

echo "==> 6/8 UFW (sólo Cloudflare en 80/443, SSH abierto en :$SSH_PORT)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow "${SSH_PORT}/tcp" comment 'SSH'
for ip in $(curl -fsSL https://www.cloudflare.com/ips-v4); do
  ufw allow from "$ip" to any port 80,443 proto tcp comment 'Cloudflare v4'
done
for ip in $(curl -fsSL https://www.cloudflare.com/ips-v6); do
  ufw allow from "$ip" to any port 80,443 proto tcp comment 'Cloudflare v6'
done
ufw --force enable

echo "==> 7/8 fail2ban + unattended-upgrades + sysctl + journald"
systemctl enable --now unattended-upgrades
systemctl enable --now fail2ban

cat >/etc/sysctl.d/99-sales-travel.conf <<'EOF'
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
fs.file-max = 2097152
vm.swappiness = 10
EOF
sysctl --system >/dev/null

mkdir -p /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/sales-travel.conf <<'EOF'
[Journal]
SystemMaxUse=500M
SystemKeepFree=1G
EOF
systemctl restart systemd-journald

echo "==> 8/8 Login a GHCR"
ALREADY_LOGGED=false
if sudo -u "$DEPLOY_USER" cat "/home/$DEPLOY_USER/.docker/config.json" 2>/dev/null | grep -q ghcr.io; then
  ALREADY_LOGGED=true
fi

if [ "$ALREADY_LOGGED" = false ]; then
  if [ -t 0 ]; then
    read -r -p "GitHub username (para GHCR): " GHCR_USER
    read -r -s -p "GHCR PAT (con scope read:packages): " GHCR_PAT
    echo
    if [ -n "$GHCR_USER" ] && [ -n "$GHCR_PAT" ]; then
      sudo -u "$DEPLOY_USER" bash -c "echo '$GHCR_PAT' | docker login ghcr.io -u '$GHCR_USER' --password-stdin"
    else
      echo "  (skipped — usuario o PAT vacío)"
    fi
  else
    echo "  (skipped — no hay TTY interactiva. Loguear manualmente:"
    echo "    sudo -iu $DEPLOY_USER bash -lc 'echo <PAT> | docker login ghcr.io -u <user> --password-stdin')"
  fi
else
  echo "  ✓ ya logueado a ghcr.io"
fi

echo
echo "✅ VPS listo."
echo
echo "Verificación rápida:"
echo "  - sudo -iu $DEPLOY_USER docker pull hello-world"
echo "  - sudo ufw status verbose"
echo
echo "Próximos pasos:"
echo "  1. Configurar secrets/vars en GitHub Actions (ver infrastructure/hostinger/README.md §3)."
echo "  2. Apuntar DNS api.planetour.cloud y app.planetour.cloud al IP de este VPS (Cloudflare proxied)."
echo "  3. Push a main → GitHub Actions deploya."
