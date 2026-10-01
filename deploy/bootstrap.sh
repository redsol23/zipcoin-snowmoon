#!/usr/bin/env bash
# Bootstraps a fresh Ubuntu 24.04 VPS for the one-box zipnet deployment. Idempotent: safe to run again, it only
# changes what differs. Run as root (or with sudo) on the server:
#
#   bash bootstrap.sh --admin tailscale  [options]     SSH only over Tailscale; no inbound port on the public IP
#   bash bootstrap.sh --admin console    [options]     no SSH from the internet at all; the provider's web console only
#   bash bootstrap.sh --admin public-ssh [options]     SSH on the public IP, rate-limited (transition only)
#
# Options:
#   --user NAME          the non-root admin/service user (default zipnet)
#   --ssh-key "KEY"      public key for that user (default: copy root's authorized_keys)
#   --root DIR           data root (default /srv/zipnet)
#   --couriers N         create dirs and secret files for courier1..N (default 1)
#   --swap-gb N          swap size when RAM is under 8 GB (default 4)
#   --no-auto-reboot     unattended-upgrades never reboots (default: reboots at 04:30 UTC when a kernel update needs it)
#   TS_AUTHKEY=...       env: a Tailscale auth key, so --admin tailscale can join the tailnet unattended
#
# What it does: admin user with key-only SSH (UsePAM stays yes: Ubuntu 24.04 needs it), ufw deny-all inbound,
# optional Tailscale, unattended-upgrades, fail2ban, Docker Engine + compose plugin with log rotation, time sync, swap
# when RAM < 8 GB, and the $ZIPNET_ROOT layout (env/, secrets/, config/, deployments/, data/, backups/) with 700/600
# permissions. It never opens a port for the services: they are reached through the Cloudflare Tunnel only.
set -euo pipefail

ADMIN=""
USER_NAME="zipnet"
SSH_KEY=""
ZIPNET_ROOT="/srv/zipnet"
COURIERS=1
SWAP_GB=4
AUTO_REBOOT=true

while [ $# -gt 0 ]; do
  case "$1" in
    --admin) ADMIN="${2:?}"; shift ;;
    --user) USER_NAME="${2:?}"; shift ;;
    --ssh-key) SSH_KEY="${2:?}"; shift ;;
    --root) ZIPNET_ROOT="${2:?}"; shift ;;
    --couriers) COURIERS="${2:?}"; shift ;;
    --swap-gb) SWAP_GB="${2:?}"; shift ;;
    --no-auto-reboot) AUTO_REBOOT=false ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n== %s\n' "$*"; }
die() { echo "bootstrap: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run as root (sudo bash bootstrap.sh ...)"
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != "ubuntu" ] || [ "${VERSION_ID:-}" != "24.04" ]; then
  echo "warning: written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}" >&2
fi
case "$ADMIN" in
  tailscale|console|public-ssh) ;;
  *) die "choose how you will administer the box: --admin tailscale | console | public-ssh (see --help)" ;;
esac
[[ "$COURIERS" =~ ^[1-9][0-9]*$ ]] || die "--couriers must be a positive integer"
[[ "$SWAP_GB" =~ ^[1-9][0-9]*$ ]] || die "--swap-gb must be a positive integer"

export DEBIAN_FRONTEND=noninteractive

# Writes $2 to $1 only if it differs; returns 0 when it changed the file
put() {
  local file="$1" content="$2"
  if [ -f "$file" ] && [ "$(cat "$file")" = "$content" ]; then return 1; fi
  printf '%s\n' "$content" > "$file"
  return 0
}

# ---------------------------------------------------------------------------------------------------------------------
log "packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg git jq age ufw fail2ban unattended-upgrades apt-listchanges \
  systemd-timesyncd openssl cron

# ---------------------------------------------------------------------------------------------------------------------
log "time sync (UTC, systemd-timesyncd)"
timedatectl set-timezone UTC
systemctl enable --now systemd-timesyncd
timedatectl set-ntp true

# ---------------------------------------------------------------------------------------------------------------------
log "admin user: $USER_NAME"
if ! id "$USER_NAME" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$USER_NAME"
fi
usermod -aG sudo "$USER_NAME"
put "/etc/sudoers.d/90-$USER_NAME" "$USER_NAME ALL=(ALL) NOPASSWD:ALL" || true
chmod 440 "/etc/sudoers.d/90-$USER_NAME"
visudo -cf "/etc/sudoers.d/90-$USER_NAME" >/dev/null

HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
AUTH="$HOME_DIR/.ssh/authorized_keys"
touch "$AUTH"
if [ -n "$SSH_KEY" ]; then
  grep -qxF "$SSH_KEY" "$AUTH" || printf '%s\n' "$SSH_KEY" >> "$AUTH"
elif [ -s /root/.ssh/authorized_keys ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && { grep -qxF "$line" "$AUTH" || printf '%s\n' "$line" >> "$AUTH"; }
  done < /root/.ssh/authorized_keys
fi
chown "$USER_NAME:$USER_NAME" "$AUTH"
chmod 600 "$AUTH"
grep -qE '^(ssh-|ecdsa-|sk-)' "$AUTH" || die "$USER_NAME has no SSH public key; pass --ssh-key \"ssh-ed25519 ...\" (refusing to lock SSH down without one)"

# ---------------------------------------------------------------------------------------------------------------------
log "SSH: key-only, no root, only $USER_NAME (UsePAM yes)"
# A drop-in sorts before cloud-init's 50-cloud-init.conf, and the first value sshd reads wins.
SSHD_DROPIN="PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
# Keep PAM on: Ubuntu 24.04 uses it for account and session setup; turning it off breaks logins
UsePAM yes
AllowUsers $USER_NAME
X11Forwarding no
AllowAgentForwarding no
MaxAuthTries 3
LoginGraceTime 30
ClientAliveInterval 300
ClientAliveCountMax 2"
if put /etc/ssh/sshd_config.d/10-zipnet.conf "$SSHD_DROPIN"; then
  sshd -t || { rm -f /etc/ssh/sshd_config.d/10-zipnet.conf; die "sshd rejected the config; removed it"; }
  systemctl reload ssh || systemctl restart ssh
fi

# ---------------------------------------------------------------------------------------------------------------------
if [ "$ADMIN" = "tailscale" ]; then
  log "Tailscale"
  if ! command -v tailscale >/dev/null; then
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg
    curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list
    apt-get update -q
    apt-get install -y -q tailscale
  fi
  systemctl enable --now tailscaled
  if ! tailscale status >/dev/null 2>&1; then
    if [ -n "${TS_AUTHKEY:-}" ]; then
      tailscale up --authkey "$TS_AUTHKEY" --hostname "zipnet"
    else
      echo "Tailscale is installed but not logged in. Run: sudo tailscale up --hostname zipnet   (then re-run this script)"
    fi
  fi
fi

# ---------------------------------------------------------------------------------------------------------------------
log "firewall: deny all inbound ($ADMIN)"
ufw --force default deny incoming
ufw --force default allow outgoing
ufw --force default deny routed
case "$ADMIN" in
  tailscale)
    # SSH only arrives over the tailnet interface; 41641/udp lets Tailscale make direct (not relayed) connections
    ufw allow in on tailscale0 to any port 22 proto tcp comment "ssh over tailscale" >/dev/null
    ufw allow 41641/udp comment "tailscale direct" >/dev/null
    if tailscale status >/dev/null 2>&1; then
      ufw delete limit 22/tcp >/dev/null 2>&1 || true
    else
      # Not on the tailnet yet: closing public SSH now would lock you out. Keep it (rate-limited) until a re-run.
      ufw limit 22/tcp comment "ssh until tailscale is up" >/dev/null
      echo "WARNING: public SSH stays open until Tailscale is logged in; run 'sudo tailscale up', test SSH over the tailnet, then re-run this script."
    fi
    ;;
  public-ssh)
    ufw limit 22/tcp comment "ssh (transition: move to tailscale or console)" >/dev/null
    ;;
  console)
    ufw delete limit 22/tcp >/dev/null 2>&1 || true
    ;;
esac
ufw --force enable >/dev/null
ufw status verbose

# ---------------------------------------------------------------------------------------------------------------------
log "fail2ban (sshd jail)"
if put /etc/fail2ban/jail.d/zipnet.local "[sshd]
enabled = true
backend = systemd
maxretry = 4
findtime = 10m
bantime = 1h"; then
  systemctl restart fail2ban
fi
systemctl enable --now fail2ban

# ---------------------------------------------------------------------------------------------------------------------
log "unattended-upgrades (security updates; reboot: $AUTO_REBOOT)"
put /etc/apt/apt.conf.d/20auto-upgrades 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";' || true
put /etc/apt/apt.conf.d/52zipnet-unattended "Unattended-Upgrade::Automatic-Reboot \"$AUTO_REBOOT\";
Unattended-Upgrade::Automatic-Reboot-Time \"04:30\";
Unattended-Upgrade::Remove-Unused-Dependencies \"true\";" || true
systemctl enable --now unattended-upgrades

# ---------------------------------------------------------------------------------------------------------------------
log "swap (RAM under 8 GB)"
MEM_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
if [ "$MEM_KB" -lt $((8 * 1024 * 1024)) ]; then
  if ! swapon --show=NAME --noheadings | grep -q .; then
    if [ ! -f /swapfile ]; then
      fallocate -l "${SWAP_GB}G" /swapfile
      chmod 600 /swapfile
      mkswap /swapfile >/dev/null
    fi
    swapon /swapfile
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  put /etc/sysctl.d/90-zipnet-swap.conf "vm.swappiness=10" && sysctl -q --system || true
  swapon --show
else
  echo "RAM $((MEM_KB / 1024)) MB: no swap needed"
fi

# ---------------------------------------------------------------------------------------------------------------------
log "Docker Engine + compose plugin"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
install -d -m 755 /etc/docker
# Log rotation for every container (compose sets the same per service), keep containers up across daemon restarts,
# no userland proxy (nothing is published anyway)
if put /etc/docker/daemon.json '{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true,
  "userland-proxy": false
}'; then
  systemctl restart docker
fi
systemctl enable --now docker containerd
usermod -aG docker "$USER_NAME"
docker compose version

# ---------------------------------------------------------------------------------------------------------------------
log "layout: $ZIPNET_ROOT"
U="$USER_NAME"
install -d -m 755 -o "$U" -g "$U" "$ZIPNET_ROOT" "$ZIPNET_ROOT/deployments" "$ZIPNET_ROOT/config"
install -d -m 700 -o "$U" -g "$U" "$ZIPNET_ROOT/env" "$ZIPNET_ROOT/secrets" "$ZIPNET_ROOT/backups" "$ZIPNET_ROOT/data"
for d in postman veridia web archive; do install -d -m 700 -o "$U" -g "$U" "$ZIPNET_ROOT/data/$d"; done

# One file per secret, 600. Empty = not configured (the entrypoint leaves the variable unset).
secret() {
  local f="$ZIPNET_ROOT/secrets/$1"
  [ -e "$f" ] || : > "$f"
  chown "$U:$U" "$f"
  chmod 600 "$f"
}
# Random values the owner never needs to see
random_secret() {
  secret "$1"
  [ -s "$ZIPNET_ROOT/secrets/$1" ] || openssl rand -hex 32 > "$ZIPNET_ROOT/secrets/$1"
}
for s in postman_key veridia_key archive_key deepseek_api_key cloudflared_credentials.json; do secret "$s"; done
random_secret emerald_session_secret
for i in $(seq 1 "$COURIERS"); do
  install -d -m 700 -o "$U" -g "$U" "$ZIPNET_ROOT/data/courier$i"
  secret "courier${i}_key"
  secret "courier${i}_cover_mnemonic"
done
find "$ZIPNET_ROOT/env" -type f -exec chmod 600 {} + -exec chown "$U:$U" {} +

# Backups and the healthcheck run from the zipnet user's crontab (deploy/README.md step 9); the log dir is theirs
install -d -m 750 -o "$U" -g "$U" /var/log/zipnet
put /etc/logrotate.d/zipnet "/var/log/zipnet/*.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  su $U $U
}" || true

log "done"
cat <<EOF
User:        $USER_NAME (uid $(id -u "$USER_NAME"), gid $(id -g "$USER_NAME")): put these in deploy/compose/.env
Admin:       $ADMIN
Data root:   $ZIPNET_ROOT
Next:        deploy/README.md step 4 (clone the repo into $ZIPNET_ROOT/src as $USER_NAME).
Check:       from your laptop, ssh $USER_NAME@<tailscale name or IP> works BEFORE you close this session.
EOF
