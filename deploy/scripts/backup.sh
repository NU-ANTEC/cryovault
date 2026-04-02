#!/bin/sh
# =============================================================================
# deploy/scripts/backup.sh — Database Backup Script
# =============================================================================
#
# PURPOSE
#   Creates a timestamped compressed backup of the SQLite database file.
#   Run this manually or schedule it with cron for automatic backups.
#
# USAGE (manual)
#   ./deploy/scripts/backup.sh
#
# USAGE (scheduled via cron — run  `crontab -e`  to edit cron jobs)
#   # Back up every day at 2:00 AM:
#   0 2 * * * /path/to/cryovault/deploy/scripts/backup.sh >> /var/log/cryovault-backup.log 2>&1
#
# USAGE (scheduled inside Docker container — add to docker-compose.yml or a
#   separate cron container):
#   docker exec cryovault-app sh /app/deploy/scripts/backup.sh
#
# WHAT IT DOES
#   1. Reads config from .env (or uses defaults)
#   2. Copies the live .db file using SQLite's online backup mechanism
#   3. Compresses the copy with gzip
#   4. Deletes backups older than BACKUP_KEEP_DAYS
# =============================================================================

set -e    # Exit immediately if any command fails (safer than continuing)

# ── Load configuration from .env if it exists ────────────────────────────────
# The . (dot) command sources a file — like "import" for shell scripts.
# We use || true so the script doesn't fail if .env doesn't exist.
[ -f "$(dirname "$0")/../../.env" ] && . "$(dirname "$0")/../../.env" || true

# ── Configuration with defaults ───────────────────────────────────────────────
# ${VAR:-default} uses $VAR if set, otherwise uses the default value.
DB_PATH="${DB_PATH:-./cryovault.db}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"

# Timestamp format: YYYY-MM-DD_HH-MM-SS (filesystem-safe, sorts chronologically)
TIMESTAMP=$(date +"%Y-%m-%d_%H-%M-%S")
BACKUP_FILE="${BACKUP_DIR}/cryovault-${TIMESTAMP}.db.gz"

# ── Check dependencies ────────────────────────────────────────────────────────
# Fail early with a clear message if required tools aren't installed.
command -v sqlite3 >/dev/null 2>&1 || { echo "[backup] ERROR: sqlite3 is not installed"; exit 1; }
command -v gzip    >/dev/null 2>&1 || { echo "[backup] ERROR: gzip is not installed"; exit 1; }

# ── Verify the database file exists ──────────────────────────────────────────
if [ ! -f "$DB_PATH" ]; then
  echo "[backup] ERROR: Database file not found at $DB_PATH"
  exit 1
fi

# ── Create backup directory if it doesn't exist ──────────────────────────────
mkdir -p "$BACKUP_DIR"

echo "[backup] Starting backup of $DB_PATH → $BACKUP_FILE"

# ── Perform the backup using SQLite's online backup ──────────────────────────
# The  .backup  command in the sqlite3 CLI uses SQLite's C-level backup API.
# This is safe to run while the database is being actively used (hot backup):
# it creates a consistent snapshot even if writers are active concurrently.
#
# Alternative: just copy the file with `cp`. That works too if the server
# is stopped, but risks a corrupted backup if writers are active.
TEMP_FILE="${BACKUP_DIR}/.backup_temp_${TIMESTAMP}.db"

sqlite3 "$DB_PATH" ".backup '${TEMP_FILE}'"

# ── Compress the backup file ──────────────────────────────────────────────────
# -c writes compressed output to stdout, which we redirect to the final file.
# This lets us stream-compress without needing 2× the disk space.
# -9 is maximum compression (slightly slower, meaningfully smaller for DB files).
gzip -9 -c "$TEMP_FILE" > "$BACKUP_FILE"

# Clean up the uncompressed temp file
rm "$TEMP_FILE"

# ── Verify the backup is readable ─────────────────────────────────────────────
# Decompress to /dev/null (discarding output) just to confirm the file is valid.
# If gzip reports an error, the backup is corrupt and we want to know now.
if gzip -t "$BACKUP_FILE"; then
  SIZE=$(du -sh "$BACKUP_FILE" | cut -f1)
  echo "[backup] ✓ Backup complete: $BACKUP_FILE ($SIZE)"
else
  echo "[backup] ERROR: Backup file appears corrupt: $BACKUP_FILE"
  rm -f "$BACKUP_FILE"
  exit 1
fi

# ── Prune old backups ─────────────────────────────────────────────────────────
# Delete backup files older than BACKUP_KEEP_DAYS to prevent unbounded disk growth.
# `find` with -mtime +N finds files modified MORE THAN N days ago.
PRUNED=$(find "$BACKUP_DIR" -name "cryovault-*.db.gz" -mtime +"$BACKUP_KEEP_DAYS" -print -delete | wc -l)

if [ "$PRUNED" -gt 0 ]; then
  echo "[backup] Pruned $PRUNED backup(s) older than $BACKUP_KEEP_DAYS days"
fi

echo "[backup] Done. Backups in: $BACKUP_DIR"
