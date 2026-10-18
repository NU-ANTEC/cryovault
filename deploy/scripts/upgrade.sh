#!/usr/bin/env bash
# =============================================================================
# deploy/scripts/upgrade.sh — Back up the database, then upgrade CryoVault
# =============================================================================
#
# WHAT THIS UPGRADE CHANGES
#   Older versions allowed one database row per vial position (and per box
#   slot), archived rows included. An archived vial therefore kept "owning"
#   its cell. This version allows one ACTIVE vial per position and one ACTIVE
#   box per slot. Archived items stay as records but no longer block anything.
#   The new version converts the database by itself on its first start
#   (db.js → migrateToActiveOnlyUniqueness).
#
# WHAT THIS SCRIPT DOES
#   1. Builds the new image while the current version keeps running.
#   2. Stops the app (about a minute of downtime), so nothing changes while
#      the backups are taken.
#   3. Backs up the database three ways into backups/upgrade-<time>/ and
#      checks each copy against the live database:
#        cryovault.db             exact copy of the database file
#        cryovault-export.json    full JSON snapshot — every tank, every
#                                 column, archived items included. Importable
#                                 from Admin → Data Import → JSON (Replace).
#        cryovault-history.json   the full change history
#      plus bug-report.txt, a list of vials affected by the old bug.
#   4. Starts the new version on the same database. It migrates the data in
#      place, in one transaction; if anything goes wrong it rolls back and
#      the database is left exactly as it was.
#   5. Checks the result: app healthy, same counts as before, new rules in
#      force.
#   If anything fails before step 4, the old version is started again
#   untouched. If step 4 or 5 fails, the script tells you how to roll back.
#
# USAGE (from the cryovault folder, after `git pull`)
#   bash deploy/scripts/upgrade.sh                 # interactive
#   bash deploy/scripts/upgrade.sh --yes           # no confirmation prompt
#   bash deploy/scripts/upgrade.sh --rollback backups/upgrade-<time>
#       Puts back the database from that backup and the previous version of
#       the code. The database as it was at the moment of rollback is kept
#       in a before-rollback-<time> folder next to it, so nothing is lost.
#
# Backups go to ./backups unless CRYOVAULT_BACKUP_DIR is set.
# The new version gets CRYOVAULT_HEALTH_TIMEOUT seconds (default 120) to start.
# =============================================================================

set -Eeuo pipefail

# The last release before this database change. --rollback returns to it.
PREVIOUS_RELEASE="4d6c45c"

# ── Output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; BLUE=''; NC=''
fi
info()    { echo -e "${BLUE}[upgrade]${NC} $*"; }
success() { echo -e "${GREEN}[upgrade]${NC} $*"; }
warn()    { echo -e "${YELLOW}[upgrade]${NC} $*" >&2; }
die()     { echo -e "${RED}[upgrade] ERROR:${NC} $*" >&2; exit 1; }

# ── Arguments ────────────────────────────────────────────────────────────────
ASSUME_YES=0
ROLLBACK_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)   ASSUME_YES=1 ;;
    --rollback) [ $# -ge 2 ] || die "--rollback needs a backup folder, e.g. backups/upgrade-20261018-101500"
                ROLLBACK_DIR="$2"; shift ;;
    -h|--help)  sed -n '2,/^# =====/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)          die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# Rollback checks out older code, which deletes this file. Run from a copy so
# bash never reads a script that changed underneath it.
if [ -n "$ROLLBACK_DIR" ] && [ -z "${CRYOVAULT_UPGRADE_COPY:-}" ]; then
  ROLLBACK_DIR="$(cd "$ROLLBACK_DIR" 2>/dev/null && pwd)" || die "backup folder not found"
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  copy="$(mktemp "${TMPDIR:-/tmp}/cryovault-upgrade.XXXXXX")"
  cp "${BASH_SOURCE[0]}" "$copy"
  extra=(); [ "$ASSUME_YES" = 1 ] && extra=(--yes)
  CRYOVAULT_UPGRADE_COPY=1 CRYOVAULT_REPO_ROOT="$REPO_ROOT" exec bash "$copy" --rollback "$ROLLBACK_DIR" ${extra[@]+"${extra[@]}"}
fi

# ── Work from the repository root (where docker-compose.yml lives) ──────────
cd "${CRYOVAULT_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || die "not running in a terminal; re-run with --yes to confirm"
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]] || die "cancelled — nothing was changed"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# ── Running the tools in a throwaway container ──────────────────────────────
# `docker compose run` starts a one-off container from the app image with the
# same volumes and environment as the app (so $DB_PATH points at the real
# database), runs one command and removes itself. It works while the app is
# stopped, which is what lets the backups be taken with nothing writing.
# Each one-off container gets its own name; the compose file's fixed
# container_name would otherwise collide with the (stopped) app container.
in_app() {
  docker compose run --rm --no-deps -T --name "cryovault-upgrade-$$-$RANDOM$RANDOM" app "$@"
}
dbtools() { in_app node lib/dbtools.js "$@"; }

app_running() { [ -n "$(docker compose ps --status running -q app 2>/dev/null)" ]; }

# nginx looks up the app's address once, when it starts. A recreated app
# container can come back on a different address, and nginx would keep
# sending requests to the old one (502 errors) — so restart it too.
restart_proxy() {
  docker compose config --services 2>/dev/null | grep -qx nginx || return 0
  [ -n "$(docker compose ps --status running -q nginx 2>/dev/null)" ] || return 0
  info "Restarting nginx so it connects to the new app container ..."
  docker compose restart nginx >/dev/null || warn "could not restart nginx: run 'docker compose restart nginx'"
}

wait_until_healthy() {
  # Ask the app itself, from inside its container, until it answers.
  # shellcheck disable=SC2016  # ${process.env.PORT} is JavaScript, not shell
  local probe='fetch(`http://127.0.0.1:${process.env.PORT||3000}/api/health`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'
  local deadline=$(( SECONDS + ${CRYOVAULT_HEALTH_TIMEOUT:-120} ))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if app_running && docker compose exec -T app node -e "$probe" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

preflight() {
  command -v docker >/dev/null 2>&1        || die "docker is not installed"
  docker compose version >/dev/null 2>&1   || die "the Docker Compose plugin is missing (docker compose)"
  docker info >/dev/null 2>&1              || die "cannot reach Docker — is it running, and can this user use it (try sudo)?"
  [ -f docker-compose.yml ]                || die "docker-compose.yml not found in $(pwd)"
  [ -f lib/dbtools.js ]                    || die "lib/dbtools.js missing — run 'git pull' first"
  docker compose config --services 2>/dev/null | grep -qx app \
                                           || die "docker-compose.yml has no 'app' service"
}

make_backup_dir() {
  local root="${CRYOVAULT_BACKUP_DIR:-./backups}" dir
  dir="$root/upgrade-$(date +%Y%m%d-%H%M%S)"
  if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
    # ./backups is often created by Docker and owned by root.
    root="$HOME/cryovault-backups"
    warn "Cannot write to ${CRYOVAULT_BACKUP_DIR:-./backups}; using $root instead"
    dir="$root/upgrade-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dir" || die "cannot create a backup folder (set CRYOVAULT_BACKUP_DIR to a writable path)"
  fi
  (cd "$dir" && pwd)
}


# =============================================================================
# ROLLBACK
# =============================================================================
rollback() {
  local dir="$ROLLBACK_DIR"
  [ -f "$dir/cryovault.db" ] || die "$dir/cryovault.db not found"
  preflight

  info "Checking the backup in $dir ..."
  local expected=""
  [ -f "$dir/upgrade-info.txt" ] && expected="$(sed -n 's/^counts: //p' "$dir/upgrade-info.txt")"
  local got
  got="$(in_app sh -c 'cat > /tmp/check.db && node lib/dbtools.js check /tmp/check.db' < "$dir/cryovault.db")" \
    || die "the backup file fails its integrity check — not restoring it"
  info "Backup contains: $got"
  if [ -n "$expected" ] && [ "$got" != "$expected" ]; then
    die "backup does not match what was recorded at upgrade time ($expected)"
  fi

  if ! git diff --quiet || ! git diff --cached --quiet; then
    die "this folder has uncommitted code changes; commit or stash them first (git status)"
  fi

  echo
  warn "This will:"
  warn "  • stop CryoVault"
  warn "  • put back the database from $dir"
  warn "    (the current database is kept alongside it as …before-rollback-<time>)"
  warn "  • switch the code back to the previous release ($PREVIOUS_RELEASE)"
  warn "Anything added or changed in CryoVault since that backup will not be in the"
  warn "restored database (it stays in the before-rollback folder, but is not merged back)."
  confirm "Roll back?"

  info "Stopping the app ..."
  docker compose stop app

  info "Restoring the database ..."
  local stamp
  # shellcheck disable=SC2016  # $DB_PATH must expand inside the container
  # The current database is moved, not deleted: its files (main, -wal, -shm)
  # go together, names unchanged, into a before-rollback-<time> folder next
  # to it. SQLite finds the -wal file by name, so they must stay a set —
  # recent changes may live only in the -wal file.
  stamp="$(in_app sh -c '
      set -e
      ts=$(date +%Y%m%d-%H%M%S)
      keep="$(dirname "$DB_PATH")/before-rollback-$ts"
      mkdir "$keep"
      for f in "$DB_PATH" "$DB_PATH-wal" "$DB_PATH-shm"; do
        if [ -e "$f" ]; then mv "$f" "$keep/"; fi
      done
      cat > "$DB_PATH.restoring"
      mv "$DB_PATH.restoring" "$DB_PATH"
      echo "$ts"' < "$dir/cryovault.db")" || die "restore failed — the app is stopped; the previous database files are in a before-rollback-* folder next to it"
  local now
  now="$(dbtools check)" || die "restored database failed its check"
  [ "$now" = "$got" ] || die "restored database differs from the backup ($now)"
  success "Database restored ($now)"

  info "Switching the code to $PREVIOUS_RELEASE and rebuilding ..."
  git checkout --quiet --detach "$PREVIOUS_RELEASE" \
    || die "could not check out $PREVIOUS_RELEASE (try: git fetch origin). Database is restored; the app is stopped."
  # Prefer the previous image kept at upgrade time (no rebuild, no network
  # needed); otherwise build the previous code.
  local old_image="" current_name=""
  [ -f "$dir/upgrade-info.txt" ] && old_image="$(sed -n 's/^old-image: //p' "$dir/upgrade-info.txt")"
  current_name="$(docker inspect --format '{{.Config.Image}}' "$(docker compose ps -aq app | head -n1)" 2>/dev/null || true)"
  local quick=0
  if [ -n "$old_image" ] && [ -n "$current_name" ] && docker image inspect "$old_image" >/dev/null 2>&1 \
     && docker tag "$old_image" "$current_name"; then
    info "Using the previous image kept at upgrade time ($old_image)"
    if docker compose up -d --no-build --force-recreate app; then quick=1
    else warn "starting the kept image failed; rebuilding instead"; fi
  fi
  if [ "$quick" = 0 ]; then
    info "Rebuilding the previous version ..."
    docker compose build app || die "could not build the previous version. Database is restored; the app is stopped."
    docker compose up -d app || die "could not start the previous version — check: docker compose logs app"
  fi
  restart_proxy
  wait_until_healthy || die "the previous version did not come up — check: docker compose logs app"

  success "Rolled back. CryoVault is running the previous version on the restored database."
  echo
  info "The database as it was before this rollback is kept in the before-rollback-$stamp"
  info "folder next to the live database (open cryovault.db there with its -wal file beside it)."
  info "The code is on $PREVIOUS_RELEASE (detached). To upgrade again later:"
  info "  git checkout master && git pull && bash deploy/scripts/upgrade.sh"
}


# =============================================================================
# UPGRADE
# =============================================================================
upgrade() {
  preflight

  local commit; commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  info "Upgrading CryoVault to $commit"
  echo
  info "This stops the app for about a minute, backs up the database, and starts"
  info "the new version, which converts the database on its first start."
  confirm "Continue?"

  # ── 1. Build first, while the current version keeps running ──────────────
  # Building moves the image name to the new image, so first give the current
  # image a name of its own. --rollback can then go back without a rebuild.
  OLD_IMAGE=""
  local old_id; old_id="$(docker compose images -q app 2>/dev/null | head -n1 || true)"
  if [ -n "$old_id" ]; then
    OLD_IMAGE="cryovault-rollback:$(date +%Y%m%d-%H%M%S)"
    docker tag "$old_id" "$OLD_IMAGE" || { warn "could not tag the current image (rollback will rebuild instead)"; OLD_IMAGE=""; }
  fi
  info "Building the new image (the current version keeps running) ..."
  docker compose build app || die "build failed — nothing was changed"

  # ── 2. Stop the app ───────────────────────────────────────────────────────
  WAS_RUNNING=0
  app_running && WAS_RUNNING=1
  info "Stopping the app ..."
  docker compose stop app

  # Until the new version is started, ANY exit (a failed check, a failed
  # command, Ctrl-C) brings the old version back exactly as it was:
  # `docker compose start` reuses the existing old container.
  restart_old() {
    if [ "$WAS_RUNNING" = 1 ]; then
      warn "Stopped before the upgrade — starting the previous version again (nothing was changed)."
      docker compose start app >/dev/null 2>&1 || warn "could not restart it: run 'docker compose start app'"
    fi
  }
  trap restart_old EXIT
  trap 'exit 130' INT TERM

  # ── 3. Check the database and take the backups ────────────────────────────
  info "Checking the current database ..."
  local counts schema audit
  counts="$(dbtools check)"     || die "the current database fails its integrity check — not upgrading"
  schema="$(dbtools schema)"
  audit="$(dbtools audit-count)"
  info "  $counts"
  info "  history entries=$audit  ($schema)"

  local dir; dir="$(make_backup_dir)"
  info "Backing up to $dir ..."

  # 3a. Exact copy of the database file (SQLite online backup, integrity-checked
  #     inside the container), streamed out of the container ...
  in_app sh -c 'node lib/dbtools.js backup /tmp/cryovault.db 2>/tmp/err || { cat /tmp/err >&2; exit 1; }
                cat /tmp/cryovault.db' \
    > "$dir/cryovault.db" || die "could not copy the database"
  # ... and checked again from the copy that actually landed on disk.
  local copy_counts
  copy_counts="$(in_app sh -c 'cat > /tmp/check.db && node lib/dbtools.js check /tmp/check.db' < "$dir/cryovault.db")"
  [ "$copy_counts" = "$counts" ] || die "database copy does not match the live database ($copy_counts)"
  success "  cryovault.db            ok"

  # 3b. Importable JSON snapshot.
  dbtools export > "$dir/cryovault-export.json" || die "could not write the JSON export"
  local json_counts
  json_counts="$(dbtools verify-export - < "$dir/cryovault-export.json")" || die "the JSON export could not be read back"
  [ "$json_counts" = "$counts" ] || die "JSON export does not match the database ($json_counts)"
  success "  cryovault-export.json   ok"

  # 3c. Change history.
  dbtools history > "$dir/cryovault-history.json" || die "could not write the history export"
  local hist
  hist="$(dbtools verify-history - < "$dir/cryovault-history.json")" || die "the history export could not be read back"
  [ "$hist" = "$audit" ] || die "history export has $hist entries, expected $audit"
  success "  cryovault-history.json  ok"

  # 3d. Which vials the old bug affected (read-only; informational, so a
  #     failure here doesn't stop the upgrade).
  if dbtools report > "$dir/bug-report.txt"; then
    success "  bug-report.txt          written"
  else
    echo "The report could not be generated." > "$dir/bug-report.txt"
    warn "  bug-report.txt          could not be generated (the upgrade continues)"
  fi

  {
    echo "CryoVault upgrade backup"
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "upgraded-to: $commit"
    echo "previous-release: $PREVIOUS_RELEASE"
    [ -n "$OLD_IMAGE" ] && echo "old-image: $OLD_IMAGE"
    echo "counts: $counts"
    echo "history-entries: $audit"
    echo "schema-before: $schema"
  } > "$dir/upgrade-info.txt"
  (cd "$dir" && sha256 cryovault.db cryovault-export.json cryovault-history.json > SHA256SUMS)

  # ── 4. Hand the database to the new version ───────────────────────────────
  trap - EXIT INT TERM
  info "Starting the new version (it converts the database on first start) ..."
  local failed=0
  if docker compose up -d app; then
    restart_proxy
    wait_until_healthy || failed=1
  else
    failed=1
  fi

  echo
  docker compose logs --no-log-prefix app 2>/dev/null | grep '^\[db\]' | tail -n 12 | sed 's/^/          /' || true
  echo

  # ── 5. Verify ─────────────────────────────────────────────────────────────
  local after_counts="" after_schema=""
  if [ "$failed" = 0 ]; then
    after_counts="$(docker compose exec -T app node lib/dbtools.js counts)" || failed=1
    after_schema="$(docker compose exec -T app node lib/dbtools.js schema)" || failed=1
  fi
  if [ "$failed" = 0 ] && [ "$after_counts" != "$counts" ]; then
    warn "Counts differ after the upgrade:"
    warn "  before: $counts"
    warn "  after:  $after_counts"
    warn "(This is expected only if someone used CryoVault in the last minute.)"
    failed=1
  fi
  if [ "$failed" = 0 ] && [ "$after_schema" != "vials_position=active-only boxes_slot=active-only" ]; then
    warn "The database was not converted: $after_schema"
    failed=1
  fi

  if [ "$failed" = 1 ]; then
    echo
    warn "The upgrade did not complete cleanly. Your data is safe in $dir"
    warn "  Look at the app log:  docker compose logs app"
    warn "  To go back to the previous version and database:"
    warn "    bash deploy/scripts/upgrade.sh --rollback $dir"
    exit 1
  fi

  success "Upgrade complete. CryoVault is running $commit."
  info "  $after_counts"
  info "  Backups: $dir"
  echo
  sed -n '/^Hidden placements/p; /^Overwritten archive records/p' "$dir/bug-report.txt" | sed 's/^/          /'
  if grep -q 'STILL HIDDEN' "$dir/bug-report.txt"; then
    warn "Some vials added while the bug was active are still hidden. Check them against the"
    warn "physical boxes — details in $dir/bug-report.txt"
  fi
  echo
  info "If something looks wrong:  bash deploy/scripts/upgrade.sh --rollback $dir"
}


if [ -n "$ROLLBACK_DIR" ]; then rollback; else upgrade; fi
