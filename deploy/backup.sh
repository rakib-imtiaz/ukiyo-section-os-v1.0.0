#!/usr/bin/env bash
# ThemeBot Cloud — database backups. setup-server.sh installs this as /usr/local/sbin/themebot-cloud-backup
# and runs it nightly through themebot-cloud-backup.timer (as the themebot user).
#
#   themebot-cloud-backup [backup [label]]   online backup of cloud.sqlite into $BACKUP_DIR (default)
#   themebot-cloud-backup list               the backups there, newest first
#   sudo themebot-cloud-backup restore FILE  put a backup back (stops and restarts the Cloud)
#
# A backup is an online, consistent copy made by SQLite itself while the Cloud keeps running
# (sqlite3 ".backup", or node:sqlite backup() when the sqlite3 tool is missing), checked with
# PRAGMA integrity_check, gzipped, and kept $KEEP_DAYS days (default 14).
#
# NOT in a backup: /etc/themebot-cloud/cloud.env (the signing key and the pepper). Keep that file in
# your password manager — a database backup is useless without the same CLOUD_PEPPER.
#
# Cron instead of the systemd timer (one line in /etc/cron.d/themebot-cloud-backup):
#   17 3 * * * themebot /usr/local/sbin/themebot-cloud-backup backup nightly
set -euo pipefail

DATA_DIR="${CLOUD_DATA_DIR:-/var/lib/themebot-cloud}"
DB="${CLOUD_DB_FILE:-$DATA_DIR/cloud.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/themebot-cloud}"
KEEP_DAYS="${KEEP_DAYS:-14}"
SERVICE="${SERVICE:-themebot-cloud}"
SERVICE_USER="${SERVICE_USER:-themebot}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8800/v1/health}"

# --- Optional offsite copy ----------------------------------------------------------------------
# A backup on the same server does not survive losing the server. To also copy each new backup
# elsewhere: install rclone (https://rclone.org/install/), run `sudo -u themebot rclone config` to
# add a remote (Backblaze B2, S3, Google Drive, ...; use an encrypted "crypt" remote — the database
# holds customer emails), then in /etc/systemd/system/themebot-cloud-backup.service add
#   Environment=OFFSITE_REMOTE=mycrypt:themebot-cloud
# and delete the ProtectHome=yes line there (rclone keeps its config in the themebot user's home),
# then: sudo systemctl daemon-reload && sudo systemctl start themebot-cloud-backup
OFFSITE_REMOTE="${OFFSITE_REMOTE:-}"

SELF="$(readlink -f "$0")"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# sqlite_backup SRC DEST — a consistent online copy, safe while the Cloud is writing.
sqlite_backup() {
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 -bail -cmd '.timeout 20000' "$1" ".backup '$2'"
  else
    node --input-type=module -e '
      import { DatabaseSync, backup } from "node:sqlite";
      const source = new DatabaseSync(process.argv[1]);
      source.exec("PRAGMA busy_timeout = 20000");
      await backup(source, process.argv[2]);
      source.close();
    ' "$1" "$2"
  fi
}

# sqlite_check FILE — prints "ok" when the copy is sound (else the first problems found).
sqlite_check() {
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 -bail "$1" 'PRAGMA integrity_check;' | sed -n '1,5p'
  else
    node --input-type=module -e '
      import { DatabaseSync } from "node:sqlite";
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      for (const row of db.prepare("PRAGMA integrity_check").all().slice(0, 5)) console.log(Object.values(row)[0]);
      db.close();
    ' "$1"
  fi
}

do_backup() {
  local label="$1"
  [[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || die "label may only contain letters, digits, . _ -"
  if [[ ! -f "$DB" ]]; then
    log "no database yet at $DB — nothing to back up"
    return 0
  fi
  umask 077
  mkdir -p "$BACKUP_DIR"
  local stamp out partial check
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$BACKUP_DIR/cloud-$stamp-$label.sqlite.gz"
  partial="$BACKUP_DIR/.cloud-$stamp-$label.sqlite.partial"
  # shellcheck disable=SC2064 # expanded now on purpose: the locals are gone when the trap fires
  trap "rm -f '$partial' '$partial.gz'" EXIT

  sqlite_backup "$DB" "$partial"
  check="$(sqlite_check "$partial")"
  [[ "$check" == "ok" ]] || die "integrity check of the new backup failed: $check"
  gzip -9 "$partial"
  mv "$partial.gz" "$out"
  trap - EXIT
  log "backup written: $out ($(du -h "$out" | cut -f1))"

  # Keep KEEP_DAYS days. This only runs after a good backup, so at least one always remains.
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'cloud-*.sqlite.gz' -mtime "+$((KEEP_DAYS - 1))" -print -delete \
    | sed 's/^/removed old backup: /'

  if [[ -n "$OFFSITE_REMOTE" ]]; then
    command -v rclone >/dev/null 2>&1 || die "OFFSITE_REMOTE is set but rclone is not installed"
    rclone copy --max-age 48h --include 'cloud-*.sqlite.gz' "$BACKUP_DIR" "$OFFSITE_REMOTE"
    log "offsite copy done: $OFFSITE_REMOTE"
  fi
}

# Started as root (deploy.sh's pre-deploy backup, a manual sudo run): run as the service user, so
# SQLite never leaves root-owned files beside the live database and the backup belongs to themebot.
backup_command() {
  local label="${1:-nightly}"
  if [[ "$(id -u)" -eq 0 ]] && id "$SERVICE_USER" >/dev/null 2>&1; then
    if runuser -u "$SERVICE_USER" -- test -r "$SELF"; then
      exec runuser -u "$SERVICE_USER" -- env CLOUD_DATA_DIR="$DATA_DIR" CLOUD_DB_FILE="$DB" \
        BACKUP_DIR="$BACKUP_DIR" KEEP_DAYS="$KEEP_DAYS" OFFSITE_REMOTE="$OFFSITE_REMOTE" \
        bash "$SELF" backup "$label"
    fi
    die "$SELF is not readable by $SERVICE_USER; run the installed copy: sudo themebot-cloud-backup backup $label"
  fi
  do_backup "$label"
}

do_list() {
  [[ -d "$BACKUP_DIR" ]] || { log "no backups yet ($BACKUP_DIR does not exist)"; return 0; }
  # Names start with a UTC timestamp, so name order is age order.
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'cloud-*.sqlite.gz' -printf '%f  %s bytes\n' | sort -r
}

do_restore() {
  local file="${1:-}"
  [[ -n "$file" ]] || die "usage: sudo themebot-cloud-backup restore /var/backups/themebot-cloud/cloud-<time>-<label>.sqlite.gz"
  [[ "$(id -u)" -eq 0 ]] || die "restore needs root: sudo themebot-cloud-backup restore $file"
  [[ -f "$file" ]] || die "$file not found"

  local stamp work restored check aside
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  work="$(mktemp -d)"
  # shellcheck disable=SC2064 # expanded now on purpose: the locals are gone when the trap fires
  trap "rm -rf '$work'" EXIT
  restored="$work/cloud.sqlite"
  case "$file" in
    *.gz) gzip -dc "$file" > "$restored" ;;
    *) cp "$file" "$restored" ;;
  esac
  check="$(sqlite_check "$restored")"
  [[ "$check" == "ok" ]] || die "$file failed its integrity check ($check) — not restoring it"

  if [[ -f "$DB" ]]; then
    log "safety backup of the current database first"
    # A separate process, so its own `set -e` applies (it switches to the service user itself).
    bash "$SELF" backup pre-restore || die "could not back up the current database; nothing was changed"
  fi

  log "stopping $SERVICE"
  systemctl stop "$SERVICE"
  aside="$DATA_DIR/replaced-$stamp"
  mkdir -p "$aside"
  for suffix in "" "-wal" "-shm"; do
    if [[ -e "$DB$suffix" ]]; then mv "$DB$suffix" "$aside/"; fi
  done
  install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 600 "$restored" "$DB"
  chown -R "$SERVICE_USER:$SERVICE_USER" "$aside"
  chmod 700 "$aside"

  log "starting $SERVICE"
  systemctl start "$SERVICE"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      log "restored $file — the Cloud is healthy."
      log "the replaced database is kept in $aside (delete it once you are sure)."
      return 0
    fi
    sleep 1
  done
  die "the Cloud did not become healthy after the restore. Check: journalctl -u $SERVICE -n 50. The previous database is in $aside."
}

command="${1:-backup}"
case "$command" in
  backup) backup_command "${2:-nightly}" ;;
  list) do_list ;;
  restore) do_restore "${2:-}" ;;
  -h|--help|help) sed -n '2,17p' "$SELF" ;;
  *) die "unknown command '$command' (backup [label] | list | restore FILE)" ;;
esac
