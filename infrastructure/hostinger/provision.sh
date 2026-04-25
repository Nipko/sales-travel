#!/usr/bin/env bash
# Provisioning one-time del VPS Hostinger para sales-travel.
# Ejecutar como root en Ubuntu 24.04 LTS recién instalado.
#
# Idempotente: se puede correr múltiples veces sin romper nada.

set -euo pipefail

APP_DIR="/opt/sales-travel"
DEPLOY_USER="deploy"
SSH_PORT="${SSH_PORT:-22}"

echo "==> 1/7 Actualizando sistema"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg ufw fail2ban unattended-upgrades \
  rsync git jq openssl

echo "==> 2/7 Instalando Docker Engine + Compose plugin"
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

echo "==> 3/7 Creando usuario $DEPLOY_USER"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$DEPLOY_USER"
  usermod -aG docker "$DEPLOY_USER"
fi
mkdir -p "/home/$DEPLOY_USER/.ssh"
if [ -f /root/.ssh/authorized_keys ] && [ ! -s "/home/$DEPLOY_USER/.ssh/authorized_keys" ]; then
  cp /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
fi
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
chmod 700 "/home/$DEPLOY_USER/.ssh"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys" 2>/dev/null || true

echo "==> 4/7 Creando $APP_DIR"
mkdir -p "$APP_DIR"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$APP_DIR"

echo "==> 5/7 Configurando UFW (sólo Cloudflare en 80/443, SSH abierto)"
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

echo "==> 6/7 Activando unattended-upgrades + fail2ban"
systemctl enable --now unattended-upgrades
systemctl enable --now fail2ban

echo "==> 7/7 Hardening sysctl + journald limits"
cat >/etc/sysctl.d/99-sales-travel.conf <<'EOF'
net.ipv4.tcp_syncookies = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
fs.file-max = 2097152
EOF
sysctl --system >/dev/null

mkdir -p /etc/systemd/journald.conf.d
cat >/etc/systemd/journald.conf.d/sales-travel.conf <<'EOF'
[Journal]
SystemMaxUse=500M
SystemKeepFree=1G
EOF
systemctl restart systemd-journald

echo
echo "✅ VPS provisionado."
echo
echo "Próximos pasos manuales:"
echo "  1. Login a GHCR como usuario $DEPLOY_USER:"
echo "       sudo -iu $DEPLOY_USER bash -lc 'echo <GHCR_PAT> | docker login ghcr.io -u <user> --password-stdin'"
echo "  2. Configurar secrets en GitHub Actions (ver infrastructure/hostinger/README.md §3)."
echo "  3. Apuntar DNS api.parallext.cloud y app.parallext.cloud al IP del VPS (proxied)."
echo "  4. Push a main → GitHub Actions deploya."
