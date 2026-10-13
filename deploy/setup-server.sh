#!/usr/bin/env bash
# ThemeBot Cloud — first-time server setup for Ubuntu 24.04 LTS (a Hostinger KVM VPS or any other).
#
# Run it ON THE SERVER, as root, from the copied deploy/ folder (deploy/README.md, part 3):
#
#   CLOUD_DOMAIN=cloud.example.com ACME_EMAIL=you@example.com bash setup-server.sh
#
# Safe to run again: every step checks first, cloud.env is never overwritten (only empty secrets are
# filled), and a config file it replaces is kept beside it as <file>.bak-<time>.
#
# What it does:
#   * installs updates, then curl, sqlite3, ufw, unattended-upgrades (security updates every day)
#   * Node.js 24 (NodeSource apt repository; NODE_INSTALL=tarball uses the official nodejs.org build)
#   * Caddy (official apt repository) — HTTPS certificates are automatic
#   * a locked system user `themebot` that runs the Cloud (no shell, no password, no sudo)
#   * /opt/themebot-cloud/{releases,current}   code, root-owned (deploy.sh fills it)
#     /var/lib/themebot-cloud                  database, themebot only (700)
#     /var/backups/themebot-cloud              nightly backups, themebot only (700)
#     /etc/themebot-cloud/cloud.env            settings + secrets, root only (600)
#   * the systemd units (themebot-cloud, nightly backup timer) and the Caddyfile
#   * firewall: only SSH, 80 and 443 open
#
# Settings (environment variables):
#   CLOUD_DOMAIN    required. The (sub)domain for the Cloud; its DNS A record must point here.
#   ACME_EMAIL      required. Your email address, for Let's Encrypt (certificate problems).
#   SSH_PORT        the SSH port to keep open (default: what sshd uses, else 22).
#   NODE_INSTALL    nodesource (default) | tarball
#   SKIP_FIREWALL=1 leave the firewall alone.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER=themebot
APP_DIR=/opt/themebot-cloud
DATA_DIR=/var/lib/themebot-cloud
BACKUP_DIR=/var/backups/themebot-cloud
CONF_DIR=/etc/themebot-cloud
ENV_FILE="$CONF_DIR/cloud.env"
LIB_DIR=/usr/local/lib/themebot-cloud
NODE_MAJOR=24
STAMP="$(date +%Y%m%d-%H%M%S)"
export DEBIAN_FRONTEND=noninteractive

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# install_file SOURCE DEST MODE — copies a file from this folder (Windows line endings removed),
# keeping the old DEST as DEST.bak-<time> when it changes.
install_file() {
  local src="$HERE/$1" dest="$2" mode="$3" tmp
  [[ -f "$src" ]] || die "$src is missing — copy the whole deploy/ folder to the server."
  tmp="$(mktemp)"
  sed 's/\r$//' "$src" > "$tmp"
  if [[ -f "$dest" ]] && cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    note "unchanged: $dest"
    return 0
  fi
  if [[ -f "$dest" ]]; then
    cp -p "$dest" "$dest.bak-$STAMP"
    note "updated:   $dest (previous version: $dest.bak-$STAMP)"
  else
    note "installed: $dest"
  fi
  install -o root -g root -m "$mode" "$tmp" "$dest"
  rm -f "$tmp"
}

# --- 0. Checks ------------------------------------------------------------------------------------
[[ "${EUID}" -eq 0 ]] || die "run this as root (on Hostinger: log in as root, or use: sudo bash setup-server.sh)"
CLOUD_DOMAIN="${CLOUD_DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
[[ -n "$CLOUD_DOMAIN" ]] || die "set CLOUD_DOMAIN, e.g.: CLOUD_DOMAIN=cloud.example.com ACME_EMAIL=you@example.com bash setup-server.sh"
[[ "$CLOUD_DOMAIN" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || die "CLOUD_DOMAIN '$CLOUD_DOMAIN' is not a domain name (no https://, no slash)"
[[ "$ACME_EMAIL" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || die "set ACME_EMAIL to your email address"
for file in themebot-cloud.service themebot-cloud-backup.service themebot-cloud-backup.timer Caddyfile cloud.env.example backup.sh gen-secrets.mjs; do
  [[ -f "$HERE/$file" ]] || die "$HERE/$file is missing — copy the whole deploy/ folder to the server."
done
# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
  warn "this script is written for Ubuntu 24.04 LTS; this is ${PRETTY_NAME:-unknown}. Continuing anyway."
fi

# --- 1. System packages + automatic security updates -----------------------------------------------
step "Updating the system and installing the basics"
# Keep any config file the provider customised (e.g. sshd_config) instead of stopping to ask.
APT_OPTS=(-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
apt-get update -q
apt-get "${APT_OPTS[@]}" upgrade
apt-get "${APT_OPTS[@]}" install ca-certificates curl gnupg sqlite3 ufw unattended-upgrades tar gzip
timedatectl set-ntp true 2>/dev/null || true   # passes expire after 15 minutes: the clock must be right

step "Turning on automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
// Written by ThemeBot setup-server.sh: refresh package lists and install security updates daily.
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52themebot-unattended-upgrades <<'EOF'
// Written by ThemeBot setup-server.sh.
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
// Kernel updates only take effect after a reboot. To let the server reboot itself when one is
// waiting (the Cloud is offline for about a minute; customers' running builds carry on), change
// "false" to "true" below. Otherwise reboot by hand now and then (deploy/README.md, Maintenance).
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
systemctl enable --now unattended-upgrades >/dev/null
note "unattended-upgrades: on"

# --- 2. Node.js 24 ------------------------------------------------------------------------------------
node_major() { /usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

step "Installing Node.js ${NODE_MAJOR}"
if [[ "$(node_major)" -ge "$NODE_MAJOR" ]]; then
  note "already installed: $(/usr/bin/node --version) at /usr/bin/node"
elif [[ "${NODE_INSTALL:-nodesource}" == "tarball" ]]; then
  [[ -e /usr/bin/node ]] && die "/usr/bin/node is an older Node.js ($(/usr/bin/node --version)). Remove it first: apt-get remove -y nodejs"
  case "$(uname -m)" in
    x86_64) node_arch=x64 ;;
    aarch64) node_arch=arm64 ;;
    *) die "no official Node.js build for $(uname -m)" ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  work="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  tarball="$(grep -oE "node-v${NODE_MAJOR}\.[0-9]+\.[0-9]+-linux-${node_arch}\.tar\.gz" "$work/SHASUMS256.txt" | awk 'NR == 1')"
  [[ -n "$tarball" ]] || die "could not find the Node.js ${NODE_MAJOR} download in $base/SHASUMS256.txt"
  curl -fsSL "$base/$tarball" -o "$work/$tarball"
  (cd "$work" && grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "checksum mismatch for $tarball"
  mkdir -p /usr/local/lib/nodejs
  tar -xzf "$work/$tarball" -C /usr/local/lib/nodejs
  node_home="/usr/local/lib/nodejs/${tarball%.tar.gz}"
  for bin in node npm npx; do ln -sfn "$node_home/bin/$bin" "/usr/local/bin/$bin"; done
  ln -sfn "$node_home/bin/node" /usr/bin/node   # themebot-cloud.service runs /usr/bin/node
  rm -rf "$work"
  note "installed $(/usr/bin/node --version) from nodejs.org (update: run this script again after removing $node_home)"
else
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  # Prefer NodeSource's nodejs over Ubuntu's older one.
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodejs
  apt-get update -q
  apt-get "${APT_OPTS[@]}" install nodejs
  note "installed $(/usr/bin/node --version) from NodeSource"
fi
[[ "$(node_major)" -ge "$NODE_MAJOR" ]] || die "Node.js ${NODE_MAJOR}+ is not at /usr/bin/node after installing"
/usr/bin/node -e 'require("node:sqlite")' || die "this Node.js has no node:sqlite"

# --- 3. Caddy -----------------------------------------------------------------------------------------
step "Installing Caddy"
if command -v caddy >/dev/null 2>&1; then
  note "already installed: $(caddy version | awk 'NR == 1')"
else
  install -d -m 0755 /usr/share/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get "${APT_OPTS[@]}" install caddy
  note "installed $(caddy version | awk 'NR == 1')"
fi

# --- 4. User and folders ----------------------------------------------------------------------------
step "Creating the themebot user and folders"
if id "$APP_USER" >/dev/null 2>&1; then
  note "user $APP_USER exists"
else
  useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$APP_USER"
  note "created system user $APP_USER (no login shell, no password)"
fi
install -d -o root -g root -m 0755 "$APP_DIR" "$APP_DIR/releases" "$LIB_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$DATA_DIR" "$BACKUP_DIR"
install -d -o root -g root -m 0700 "$CONF_DIR"
note "$APP_DIR (code), $DATA_DIR (data, 700), $BACKUP_DIR (backups, 700), $CONF_DIR (settings, 700)"

# --- 5. Settings: /etc/themebot-cloud/cloud.env -----------------------------------------------------
step "Settings file $ENV_FILE"
install_file gen-secrets.mjs "$LIB_DIR/gen-secrets.mjs" 0644
if [[ -f "$ENV_FILE" ]]; then
  note "exists — left as it is"
else
  sed 's/\r$//' "$HERE/cloud.env.example" > "$ENV_FILE"
  note "created from cloud.env.example"
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"
# Generates CLOUD_SIGNING_KEY, CLOUD_PEPPER and ADMIN_TOKEN where they are still empty; never replaces one.
PUBKEY_LINE="$(/usr/bin/node "$LIB_DIR/gen-secrets.mjs" --fill "$ENV_FILE" | tee /dev/stderr | grep '^THEMEBOT_CLOUD_PUBKEY=' || true)"
chmod 600 "$ENV_FILE"

# --- 6. systemd units, backup script, Caddy ---------------------------------------------------------
step "Installing the services"
install_file backup.sh /usr/local/sbin/themebot-cloud-backup 0755
install_file themebot-cloud.service /etc/systemd/system/themebot-cloud.service 0644
install_file themebot-cloud-backup.service /etc/systemd/system/themebot-cloud-backup.service 0644
install_file themebot-cloud-backup.timer /etc/systemd/system/themebot-cloud-backup.timer 0644

printf '# Written by ThemeBot setup-server.sh — read by the caddy service (caddy.service.d/themebot.conf).\nCLOUD_DOMAIN=%s\nACME_EMAIL=%s\n' \
  "$CLOUD_DOMAIN" "$ACME_EMAIL" > /etc/caddy/themebot.env
chmod 0644 /etc/caddy/themebot.env
install -d -m 0755 /etc/systemd/system/caddy.service.d
# shellcheck disable=SC2016 # the {$...} are Caddy placeholders, meant literally
printf '# Written by ThemeBot setup-server.sh: gives the Caddyfile its {$CLOUD_DOMAIN} and {$ACME_EMAIL}.\n[Service]\nEnvironmentFile=/etc/caddy/themebot.env\n' \
  > /etc/systemd/system/caddy.service.d/themebot.conf
install -d -o caddy -g caddy -m 0755 /var/log/caddy

# Validate the new Caddyfile BEFORE it replaces the old one, as the caddy user: run as root, Caddy
# could leave root-owned files (log, certificate storage) that the caddy service cannot write later.
caddy_new="$(mktemp)"
sed 's/\r$//' "$HERE/Caddyfile" > "$caddy_new"
chmod 0644 "$caddy_new"
if ! runuser -u caddy -- env CLOUD_DOMAIN="$CLOUD_DOMAIN" ACME_EMAIL="$ACME_EMAIL" \
    caddy validate --config "$caddy_new" --adapter caddyfile >/dev/null; then
  rm -f "$caddy_new"
  die "the new Caddyfile does not validate (see above); /etc/caddy/Caddyfile was left as it was"
fi
rm -f "$caddy_new"
chown -R caddy:caddy /var/log/caddy
install_file Caddyfile /etc/caddy/Caddyfile 0644

systemctl daemon-reload
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy
note "Caddy serves https://$CLOUD_DOMAIN (the certificate arrives once DNS points here)"

systemctl enable --now themebot-cloud-backup.timer >/dev/null 2>&1
note "nightly backup timer: on"

if [[ -L "$APP_DIR/current" ]]; then
  systemctl enable themebot-cloud >/dev/null 2>&1
  systemctl restart themebot-cloud
  note "themebot-cloud restarted (release: $(readlink -f "$APP_DIR/current"))"
else
  note "themebot-cloud starts on the first deploy (deploy.sh) — there is no release yet"
fi

# --- 7. Firewall ---------------------------------------------------------------------------------------
step "Firewall"
if [[ "${SKIP_FIREWALL:-}" == "1" ]]; then
  note "skipped (SKIP_FIREWALL=1)"
else
  # awk reads to the end on purpose: exiting early makes sshd die of SIGPIPE, which pipefail + set -e
  # turn into a silent exit 141 of this whole script.
  ssh_port="${SSH_PORT:-$(sshd -T 2>/dev/null | awk '$1 == "port" && !p { p = $2 } END { print p }')}"
  ssh_port="${ssh_port:-22}"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow "${ssh_port}/tcp" comment 'SSH' >/dev/null
  ufw allow 80/tcp comment 'HTTP (certificates, redirect to HTTPS)' >/dev/null
  ufw allow 443/tcp comment 'HTTPS' >/dev/null
  ufw allow 443/udp comment 'HTTPS (HTTP/3)' >/dev/null
  ufw --force enable >/dev/null
  note "open: ${ssh_port}/tcp (SSH), 80/tcp, 443/tcp+udp — everything else is closed"
fi

# --- 8. Checks and next steps ---------------------------------------------------------------------------
step "Checks"
server_ips="$(hostname -I 2>/dev/null || true)"
dns_ip="$(getent ahostsv4 "$CLOUD_DOMAIN" 2>/dev/null | awk 'NR == 1 { print $1 }')"
if [[ -z "$dns_ip" ]]; then
  warn "$CLOUD_DOMAIN does not resolve yet — add the DNS A record (README part 2); HTTPS starts working once it does."
elif [[ " $server_ips " != *" $dns_ip "* ]]; then
  warn "$CLOUD_DOMAIN points at $dns_ip, but this server's addresses are: $server_ips"
else
  note "DNS: $CLOUD_DOMAIN -> $dns_ip (this server)"
fi

missing=()
for name in CLOUD_SIGNING_KEY CLOUD_PEPPER ADMIN_TOKEN RESEND_API_KEY MAIL_FROM; do
  grep -Eq "^${name}=.+" "$ENV_FILE" || missing+=("$name")
done
grep -Eq '^LEMONSQUEEZY_WEBHOOK_SECRET=.+' "$ENV_FILE" || warn "LEMONSQUEEZY_WEBHOOK_SECRET is empty: purchases will not create accounts until you set it."

step "Done"
if ((${#missing[@]})); then
  echo "  1. Fill in ${missing[*]} in the settings file:"
  echo "       nano $ENV_FILE"
else
  echo "  1. Settings are complete ($ENV_FILE)."
fi
echo "  2. Save a copy of that whole file in your password manager:  cat $ENV_FILE"
echo "  3. From your PC, deploy the app:  HOST=<this server's IP> ./deploy/deploy.sh"
if [[ -n "$PUBKEY_LINE" ]]; then
  echo "  4. Build the installers with (not a secret):"
  echo "       THEMEBOT_CLOUD_URL=https://$CLOUD_DOMAIN"
  echo "       $PUBKEY_LINE"
fi
