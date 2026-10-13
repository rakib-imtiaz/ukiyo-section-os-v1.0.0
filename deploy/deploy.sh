#!/usr/bin/env bash
# ThemeBot Cloud — ship a new version from your PC to the server (Git Bash on Windows, or a macOS /
# Linux terminal), from the repository folder:
#
#   HOST=203.0.113.10 ./deploy/deploy.sh                build, test, upload, switch, restart, check
#   HOST=203.0.113.10 ./deploy/deploy.sh --rollback     back to the previous release
#   HOST=203.0.113.10 ./deploy/deploy.sh --rollback 20261004-153012-1a2b3c4d5e6f   to a named one
#   HOST=203.0.113.10 ./deploy/deploy.sh --status       running release, health, recent log lines
#   HOST=203.0.113.10 ./deploy/deploy.sh --list         releases on the server
#   HOST=203.0.113.10 ./deploy/deploy.sh --logs         follow the live log (Ctrl+C to stop)
#
# A deploy:
#   1. builds build/cloud with scripts/cloud/build.mjs and smoke-tests it on this PC (production mode,
#      throwaway secrets, 127.0.0.1 only);
#   2. uploads it as /opt/themebot-cloud/releases/<time>-<commit> (older releases stay on the server);
#   3. backs up the database, points /opt/themebot-cloud/current at the new release and restarts;
#   4. checks http://127.0.0.1:8800/v1/health on the server for up to ~40 s; if it is not healthy it
#      switches back to the previous release, restarts that, and exits with an error.
#
# Settings (environment variables):
#   HOST           required: the server's IP address or host name
#   SSH_USER       default root (another user needs passwordless sudo)
#   SSH_PORT       default 22
#   SSH_KEY        path to your SSH private key (default: ssh's own choice, e.g. ~/.ssh/id_ed25519)
#   KEEP_RELEASES  releases kept on the server (default 5)
#   SKIP_BUILD=1   upload build/cloud as it is (no build, no smoke test)
#   THEMEBOT_CLOUD_URL, THEMEBOT_CLOUD_PUBKEY   optional: the values your installers are built with;
#                  when set, the deploy also checks https://<domain>/v1/health from this PC and that
#                  the server still serves the same public key.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$ROOT/build/cloud"
HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
usage() { sed -n '2,29p' "${BASH_SOURCE[0]}"; exit "${1:-0}"; }

# --- The part that runs on the server (fed to `bash -s` over SSH) ----------------------------------
# Everything is inside functions and `main` is called on the last line, so bash has read the whole
# script before any command runs (nothing can swallow the rest of it from stdin).
IFS= read -r -d '' REMOTE_SCRIPT <<'REMOTE' || true
set -euo pipefail
APP_DIR=/opt/themebot-cloud
RELEASES="$APP_DIR/releases"
CURRENT="$APP_DIR/current"
ENV_FILE=/etc/themebot-cloud/cloud.env
DB=/var/lib/themebot-cloud/cloud.sqlite
SERVICE=themebot-cloud
BASE_URL=http://127.0.0.1:8800

say() { printf '    [server] %s\n' "$*"; }
fail() { printf '\033[31m    [server] ERROR: %s\033[0m\n' "$*" >&2; exit 1; }

lock() {
  exec 9>/run/lock/themebot-cloud-deploy.lock
  flock -n 9 || fail "another deploy or rollback is running on this server"
}

current_release() {
  if [[ -L "$CURRENT" ]]; then basename "$(readlink -f "$CURRENT")"; fi
}

# The newest release older than the current one (release names start with a UTC timestamp).
previous_release() {
  local cur
  cur="$(current_release)"
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | { grep -Ev '\.(failed|partial)$' || true; } | sort \
    | awk -v cur="$cur" 'cur == "" || $0 < cur' | tail -n 1
}

switch_to() {
  ln -sfn "$RELEASES/$1" "$APP_DIR/current.new"
  mv -Tf "$APP_DIR/current.new" "$CURRENT"
}

restart_service() {
  systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
  systemctl enable --quiet "$SERVICE"
  systemctl restart "$SERVICE" </dev/null
}

answers() {
  local body
  body="$(curl -fsS --max-time 3 "$BASE_URL/v1/health" 2>/dev/null </dev/null || true)"
  [[ "$body" == *'"ok":true'* ]]
}

# Healthy = active, answers /v1/health, and is still the same process 5 s later (no crash loop).
healthy() {
  local pid
  for _ in $(seq 1 30); do
    if systemctl is-active --quiet "$SERVICE" && answers; then
      pid="$(systemctl show -p MainPID --value "$SERVICE")"
      sleep 5
      if systemctl is-active --quiet "$SERVICE" && [[ "$(systemctl show -p MainPID --value "$SERVICE")" == "$pid" ]] && answers; then
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

preflight() {
  [[ -f "$ENV_FILE" ]] || fail "$ENV_FILE is missing — run setup-server.sh on this server first (deploy/README.md)"
  systemctl cat "$SERVICE" >/dev/null 2>&1 || fail "$SERVICE.service is not installed — run setup-server.sh first"
  [[ -x /usr/bin/node ]] || fail "/usr/bin/node is missing — run setup-server.sh first"
  local missing=() name
  for name in CLOUD_SIGNING_KEY CLOUD_PEPPER RESEND_API_KEY MAIL_FROM; do
    grep -Eq "^${name}=.+" "$ENV_FILE" || missing+=("$name")
  done
  ((${#missing[@]} == 0)) || fail "fill in ${missing[*]} in $ENV_FILE first:  nano $ENV_FILE"
}

prune() {
  local keep="$1" cur old
  cur="$(current_release)"
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r | awk -v keep="$keep" 'NR > keep' \
    | while read -r old; do
        [[ "$old" == "$cur" ]] && continue
        rm -rf "${RELEASES:?}/$old"
        say "removed old release $old"
      done
}

show_key() {
  local key
  key="$(curl -fsS --max-time 3 "$BASE_URL/v1/public-key" 2>/dev/null </dev/null || true)"
  key="$(sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p' <<<"$key")"
  say "public key (THEMEBOT_CLOUD_PUBKEY for installer builds): ${key:-unknown}"
}

cmd_activate() {
  local rel="$1" keep="$2" tarball="/tmp/themebot-cloud-$1.tar.gz" prev staging recipe_version
  lock
  preflight
  [[ -f "$tarball" ]] || fail "the upload $tarball is missing"
  [[ ! -e "$RELEASES/$rel" ]] || fail "release $rel already exists on the server"
  prev="$(current_release)"

  staging="$RELEASES/$rel.partial"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$tarball" -C "$staging" --no-same-owner --no-same-permissions </dev/null
  rm -f "$tarball"
  [[ -f "$staging/cloud.mjs" && -f "$staging/recipe/manifest.json" && -f "$staging/release.json" ]] \
    || { rm -rf "$staging"; fail "the upload is incomplete (cloud.mjs, recipe/manifest.json or release.json missing)"; }
  # release.json and the shipped recipe must agree (scripts/cloud/build.mjs checks the same at build time).
  recipe_version="$(/usr/bin/node -e '
    const fs = require("fs"); const dir = process.argv[1];
    const claimed = JSON.parse(fs.readFileSync(dir + "/release.json", "utf8")).recipeVersion;
    const shipped = JSON.parse(fs.readFileSync(dir + "/recipe/manifest.json", "utf8")).recipe_version;
    if (!shipped || claimed !== shipped) { console.error("release.json says recipe " + claimed + ", recipe/manifest.json says " + shipped); process.exit(1); }
    console.log(shipped);
  ' "$staging" </dev/null)" || { rm -rf "$staging"; fail "the upload's recipe does not match its release.json"; }
  chown -R root:root "$staging"
  chmod -R u=rwX,go=rX "$staging"
  mv "$staging" "$RELEASES/$rel"
  say "unpacked $rel ($(du -sh "$RELEASES/$rel" | cut -f1), recipe $recipe_version)"

  # The new version may migrate the database at start: keep a copy from just before.
  if [[ -f "$DB" ]]; then
    if [[ -x /usr/local/sbin/themebot-cloud-backup ]]; then
      /usr/local/sbin/themebot-cloud-backup backup "pre-deploy-$rel" </dev/null \
        || { rm -rf "${RELEASES:?}/$rel"; fail "the pre-deploy backup failed; nothing was changed"; }
    else
      say "warning: /usr/local/sbin/themebot-cloud-backup is missing (run setup-server.sh again) — no pre-deploy backup"
    fi
  fi

  switch_to "$rel"
  say "current -> $rel${prev:+ (was $prev)}"
  restart_service
  if healthy; then
    say "healthy: $rel is live"
    show_key
    prune "$keep"
    return 0
  fi

  say "$rel is NOT healthy. Last log lines:"
  journalctl -u "$SERVICE" -n 40 --no-pager </dev/null || true
  mv "$RELEASES/$rel" "$RELEASES/$rel.failed"
  if [[ -n "$prev" && -d "$RELEASES/$prev" ]]; then
    say "rolling back to $prev"
    switch_to "$prev"
    restart_service
    if healthy; then fail "deploy of $rel failed; rolled back to $prev, which is healthy (the failed release is kept as $rel.failed)"; fi
    fail "deploy of $rel failed AND $prev is not healthy either — see: journalctl -u $SERVICE -n 100"
  fi
  systemctl stop "$SERVICE" </dev/null || true
  rm -f "$CURRENT"
  fail "the first deploy failed (nothing to roll back to). The log above says why — usually a setting in $ENV_FILE."
}

cmd_rollback() {
  local target="${1:-}" from
  lock
  preflight
  from="$(current_release)"
  [[ -n "$target" ]] || target="$(previous_release)"
  [[ -n "$target" ]] || fail "there is no older release to roll back to"
  [[ -d "$RELEASES/$target" ]] || fail "release $target does not exist (see --list)"
  [[ "$target" != "$from" ]] || fail "$target is already the current release"
  switch_to "$target"
  say "current -> $target (was ${from:-nothing})"
  restart_service
  if healthy; then say "healthy: $target is live"; show_key; return 0; fi
  journalctl -u "$SERVICE" -n 40 --no-pager </dev/null || true
  if [[ -n "$from" && -d "$RELEASES/$from" ]]; then
    switch_to "$from"
    restart_service
    healthy && fail "$target was not healthy; switched back to $from, which is healthy"
  fi
  fail "$target was not healthy and switching back did not help — see: journalctl -u $SERVICE -n 100"
}

cmd_list() {
  local cur
  cur="$(current_release)"
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r | while read -r rel; do
    if [[ "$rel" == "$cur" ]]; then echo "  * $rel   (current)"; else echo "    $rel"; fi
  done
}

cmd_status() {
  local cur
  cur="$(current_release)"
  echo "release:  ${cur:-none}"
  [[ -n "$cur" && -f "$CURRENT/release.json" ]] && sed 's/^/          /' "$CURRENT/release.json"
  echo "service:  $(systemctl is-active "$SERVICE" || true) since $(systemctl show -p ActiveEnterTimestamp --value "$SERVICE")"
  if answers; then echo "health:   ok"; show_key; else echo "health:   NOT answering on $BASE_URL/v1/health"; fi
  echo "disk:     $(df -h /var/lib/themebot-cloud | awk 'NR == 2 { print $4 " free of " $2 }')"
  echo "backups:"
  /usr/local/sbin/themebot-cloud-backup list 2>/dev/null </dev/null | head -n 3 | sed 's/^/          /' || true
  echo "last log lines:"
  journalctl -u "$SERVICE" -n 15 --no-pager -o cat </dev/null || true
}

main() {
  case "${1:-}" in
    activate) cmd_activate "$2" "$3" ;;
    rollback) cmd_rollback "${2:-}" ;;
    list) cmd_list ;;
    status) cmd_status ;;
    *) fail "unknown remote command ${1:-}" ;;
  esac
}
main "$@"
REMOTE
REMOTE_SCRIPT="${REMOTE_SCRIPT//$'\r'/}"

# --- Local side -------------------------------------------------------------------------------------
MODE=deploy
ROLLBACK_TO=""
case "${1:-}" in
  "") ;;
  --rollback) MODE=rollback; ROLLBACK_TO="${2:-}" ;;
  --status) MODE=status ;;
  --list) MODE=list ;;
  --logs) MODE=logs ;;
  -h|--help) usage 0 ;;
  *) echo "Unknown option: $1"; usage 1 ;;
esac
[[ -n "$HOST" ]] || { echo "Set HOST to your server's IP address, e.g.:  HOST=203.0.113.10 ./deploy/deploy.sh"; exit 1; }
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ && "$KEEP_RELEASES" -ge 2 ]] || die "KEEP_RELEASES must be a number of at least 2"
[[ -z "$ROLLBACK_TO" || "$ROLLBACK_TO" =~ ^[A-Za-z0-9._-]+$ ]] || die "not a release name: $ROLLBACK_TO"
for tool in ssh scp tar; do command -v "$tool" >/dev/null 2>&1 || die "'$tool' is not installed (on Windows, use Git Bash)"; done

TARGET="$SSH_USER@$HOST"
SSH_OPTS=(-p "$SSH_PORT" -o ConnectTimeout=20 -o ServerAliveInterval=15)
SCP_OPTS=(-P "$SSH_PORT" -o ConnectTimeout=20)
if [[ -n "${SSH_KEY:-}" ]]; then SSH_OPTS+=(-i "$SSH_KEY"); SCP_OPTS+=(-i "$SSH_KEY"); fi
SUDO=""
[[ "$SSH_USER" == "root" ]] || SUDO="sudo -n"

# The arguments are expanded here on purpose (a command word and a release name checked above).
# shellcheck disable=SC2029
remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$SUDO bash -s -- $*" <<<"$REMOTE_SCRIPT"; }

case "$MODE" in
  status) remote status; exit ;;
  list) remote list; exit ;;
  logs) exec ssh -t "${SSH_OPTS[@]}" "$TARGET" "$SUDO journalctl -u themebot-cloud -n 100 -f" ;;
  rollback)
    say "Rolling back on $HOST${ROLLBACK_TO:+ to $ROLLBACK_TO}"
    remote rollback "$ROLLBACK_TO"
    exit ;;
esac

# 1. Build + smoke test
if [[ "${SKIP_BUILD:-}" == "1" ]]; then
  say "Using the existing build in build/cloud (SKIP_BUILD=1)"
else
  command -v node >/dev/null 2>&1 || die "Node.js is not installed on this PC"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || die "Node.js 24 or newer is needed on this PC (node --version: $(node --version))"
  say "Building and smoke-testing ThemeBot Cloud"
  node "$ROOT/scripts/cloud/build.mjs" --smoke --out "$BUILD_DIR"
fi
[[ -f "$BUILD_DIR/cloud.mjs" && -f "$BUILD_DIR/recipe/manifest.json" ]] || die "no build in $BUILD_DIR (run without SKIP_BUILD)"

# 2. Package
commit="$(git -C "$ROOT" rev-parse --short=12 HEAD 2>/dev/null || echo nogit)"
REL="$(date -u +%Y%m%d-%H%M%S)-$commit"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TARBALL="$WORK/themebot-cloud-$REL.tar.gz"
tar -czf "$TARBALL" -C "$BUILD_DIR" .
say "Release $REL ($(du -h "$TARBALL" | cut -f1) packed)"

# 3. Upload + activate (the server rolls back by itself when the new release is not healthy)
say "Uploading to $TARGET"
scp "${SCP_OPTS[@]}" -q "$TARBALL" "$TARGET:/tmp/"
say "Activating on the server"
if ! remote activate "$REL" "$KEEP_RELEASES"; then
  die "deploy failed — see the server messages above. The server is on the previous release (if there was one)."
fi

# 4. Optional checks from outside, through Caddy and HTTPS
if [[ -n "${THEMEBOT_CLOUD_URL:-}" ]]; then
  url="${THEMEBOT_CLOUD_URL%/}"
  health="$(curl -fsS --max-time 10 "$url/v1/health" 2>/dev/null || true)"
  if [[ "$health" == *'"ok":true'* ]]; then
    say "$url/v1/health answers"
  else
    printf '\033[33m    ! %s/v1/health does not answer from here (DNS, firewall or certificate?) — the server itself is healthy.\033[0m\n' "$url"
  fi
  if [[ -n "${THEMEBOT_CLOUD_PUBKEY:-}" ]]; then
    live="$(curl -fsS --max-time 10 "$url/v1/public-key" 2>/dev/null || true)"
    live="$(sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p' <<<"$live")"
    if [[ "$live" == "$THEMEBOT_CLOUD_PUBKEY" ]]; then
      say "public key matches THEMEBOT_CLOUD_PUBKEY"
    elif [[ -n "$live" ]]; then
      printf '\033[31m    ! The server signs with a DIFFERENT key than THEMEBOT_CLOUD_PUBKEY. Installed apps built with\n      the old key cannot sign in. Restore the old CLOUD_SIGNING_KEY in cloud.env, or rebuild the installers.\033[0m\n'
    fi
  fi
fi
say "Done: $REL is live on $HOST"
