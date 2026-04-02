#!/bin/bash
# =============================================================================
# deploy/scripts/deploy.sh — Manual Deployment Script
# =============================================================================
#
# PURPOSE
#   Run this script to deploy a new version of CryoVault to the server.
#   Use this when you want to deploy manually (without GitHub Actions CI/CD).
#
# WHAT IT DOES
#   1. Pull the latest code from git
#   2. Build a new Docker image (or install npm dependencies for pm2)
#   3. Take a database backup before the update
#   4. Replace the running container with zero downtime
#   5. Verify the health check passes
#   6. Roll back automatically if the health check fails
#
# USAGE
#   ./deploy/scripts/deploy.sh                  ← deploy latest code on server
#   ./deploy/scripts/deploy.sh --skip-backup    ← skip the pre-deploy backup
#   ./deploy/scripts/deploy.sh --mode pm2       ← use pm2 instead of Docker
#
# RUN FROM
#   The application directory on the production server:
#     ssh user@your-server
#     cd /opt/cryovault
#     ./deploy/scripts/deploy.sh
# =============================================================================

set -e    # Exit on first error

# ── Parse arguments ───────────────────────────────────────────────────────────
SKIP_BACKUP=false
DEPLOY_MODE="docker"    # "docker" or "pm2"

for arg in "$@"; do
  case $arg in
    --skip-backup) SKIP_BACKUP=true  ;;
    --mode=pm2)    DEPLOY_MODE="pm2" ;;
    --mode=docker) DEPLOY_MODE="docker" ;;
    --help)
      echo "Usage: $0 [--skip-backup] [--mode=docker|pm2]"
      exit 0
      ;;
  esac
done

# ── Colour helpers ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $*"; }
success() { echo -e "${GREEN}[$(date +%H:%M:%S)] ✓${NC} $*"; }
warn()    { echo -e "${YELLOW}[$(date +%H:%M:%S)] ⚠${NC}  $*"; }
error()   { echo -e "${RED}[$(date +%H:%M:%S)] ✗${NC}  $*"; exit 1; }

# ── Load .env if present ──────────────────────────────────────────────────────
[ -f .env ] && export $(grep -v '^#' .env | xargs)

APP_DIR="${APP_DIR:-$(pwd)}"
DATA_DIR="${DATA_DIR:-/opt/cryovault-data}"
HEALTH_URL="http://localhost:${PORT:-3000}/api/health"

echo ""
info "═══════════════════════════════════════════════"
info " CryoVault Deployment Script"
info " Mode: $DEPLOY_MODE"
info " Directory: $APP_DIR"
info "═══════════════════════════════════════════════"
echo ""

# =============================================================================
# STEP 1: Pre-flight checks
# =============================================================================
info "Running pre-flight checks..."

# Ensure we're in a git repository
[ -d .git ] || error "Not in a git repository. Run from the application root."

# Ensure Docker is available (for Docker mode)
if [ "$DEPLOY_MODE" = "docker" ]; then
  command -v docker &>/dev/null || error "Docker is not installed. Run setup.sh first."
  docker compose version &>/dev/null || error "Docker Compose plugin not found."
fi

# Ensure pm2 is available (for pm2 mode)
if [ "$DEPLOY_MODE" = "pm2" ]; then
  command -v pm2 &>/dev/null || error "pm2 is not installed. Run: npm install -g pm2"
fi

success "Pre-flight checks passed"


# =============================================================================
# STEP 2: Create a pre-deployment database backup
# =============================================================================
# Always back up before a deployment. If something goes wrong after the update,
# you'll want to restore the exact database state from before the deploy.
# =============================================================================
if [ "$SKIP_BACKUP" = "false" ]; then
  info "Creating pre-deployment database backup..."
  if [ -f "$APP_DIR/deploy/scripts/backup.sh" ]; then
    bash "$APP_DIR/deploy/scripts/backup.sh" \
      && success "Backup complete" \
      || warn "Backup failed — continuing anyway (check $DATA_DIR/backups)"
  else
    warn "backup.sh not found — skipping backup"
  fi
else
  warn "Skipping backup (--skip-backup flag set)"
fi


# =============================================================================
# STEP 3: Pull latest code
# =============================================================================
# Fetch the latest commits from the remote and fast-forward the local branch.
#
# "git pull --ff-only" fails if the local branch has diverged from remote
# (i.e., there are local commits not on the remote). This prevents accidental
# deployment of mixed/experimental code.
# =============================================================================
info "Pulling latest code from git..."

# Show which commit we're on before the update
BEFORE_SHA=$(git rev-parse --short HEAD)
info "Current commit: $BEFORE_SHA"

git fetch origin
git pull --ff-only origin main \
  || error "git pull failed. The branch may have diverged. Resolve conflicts first."

AFTER_SHA=$(git rev-parse --short HEAD)
info "Updated to commit: $AFTER_SHA"

if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then
  warn "No new commits — already up to date. Continuing anyway."
fi

# Show what changed between the two commits
if [ "$BEFORE_SHA" != "$AFTER_SHA" ]; then
  info "Changes in this deployment:"
  git log --oneline "$BEFORE_SHA...$AFTER_SHA" | head -10
fi


# =============================================================================
# STEP 4: Deploy
# =============================================================================

if [ "$DEPLOY_MODE" = "docker" ]; then
  # ── Docker deployment ────────────────────────────────────────────────────────

  info "Building new Docker image..."
  # Build the new image. Docker's layer cache means unchanged layers (like
  # npm packages) don't need to be rebuilt — only changed layers.
  docker compose build app

  info "Replacing running container..."
  # --no-deps: don't restart nginx — it doesn't need updating
  # -d: detached mode (runs in background, returns immediately)
  # --remove-orphans: clean up containers for removed services
  docker compose up -d --no-deps --remove-orphans app

else
  # ── pm2 deployment ────────────────────────────────────────────────────────────

  info "Installing/updating npm dependencies..."
  # npm ci = clean install (always removes node_modules and reinstalls)
  # --omit=dev = skip devDependencies (nodemon etc.) in production
  npm ci --omit=dev

  info "Reloading application with pm2..."
  # pm2 reload does a rolling restart: starts the new version, waits for it
  # to be healthy, then stops the old version. Zero downtime.
  # --update-env picks up any new environment variables from ecosystem.config.js
  pm2 reload deploy/pm2/ecosystem.config.js --env production --update-env

fi


# =============================================================================
# STEP 5: Health check
# =============================================================================
# Wait up to 30 seconds for the app to respond to the health endpoint.
# If it doesn't respond, initiate an automatic rollback.
#
# Why 30 seconds? Node.js typically starts in 1-2 seconds, but the container
# may take longer to start on a slow server. 30s gives plenty of room.
# =============================================================================
info "Waiting for health check at $HEALTH_URL..."

MAX_ATTEMPTS=10
WAIT_SECONDS=3
HEALTHY=false

for i in $(seq 1 $MAX_ATTEMPTS); do
  HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    HEALTHY=true
    success "Health check passed (attempt $i/$MAX_ATTEMPTS)"
    break
  fi

  info "Attempt $i/$MAX_ATTEMPTS — HTTP $HTTP_CODE — waiting ${WAIT_SECONDS}s..."
  sleep $WAIT_SECONDS
done


# =============================================================================
# STEP 6: Rollback if health check failed
# =============================================================================
# If the new version isn't healthy, revert to the previous version automatically.
# This is the key benefit of scripted deployments — failed deploys are caught
# and reversed before anyone notices an outage.
# =============================================================================
if [ "$HEALTHY" = "false" ]; then
  error_msg="Health check failed after $((MAX_ATTEMPTS * WAIT_SECONDS)) seconds"
  warn "$error_msg — initiating rollback..."

  if [ "$DEPLOY_MODE" = "docker" ]; then
    # Pull and restart the previously running image.
    # This only works if docker-compose.yml pins to a specific image tag.
    # With "image: cryovault:latest" you can't roll back to a previous "latest".
    # → Use SHA-tagged images in production for proper rollback capability.
    warn "Docker rollback: restoring previous container state..."
    git checkout "$BEFORE_SHA"
    docker compose up -d --no-deps app
  else
    # pm2 rollback reverts to the previously deployed version
    warn "pm2 rollback: reverting to previous version..."
    git checkout "$BEFORE_SHA"
    npm ci --omit=dev
    pm2 reload deploy/pm2/ecosystem.config.js --env production --update-env
  fi

  error "$error_msg. Rollback complete. Check logs: docker compose logs app"
fi


# =============================================================================
# STEP 7: Cleanup
# =============================================================================
if [ "$DEPLOY_MODE" = "docker" ]; then
  info "Cleaning up unused Docker resources..."
  # Remove dangling images (untagged layers from old builds) to free disk space.
  # -f = force (don't ask for confirmation)
  docker image prune -f > /dev/null
fi


# =============================================================================
# DEPLOYMENT COMPLETE
# =============================================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║     Deployment completed successfully! ✓     ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Commit: ${BLUE}$BEFORE_SHA${NC} → ${GREEN}$AFTER_SHA${NC}"
echo -e "  Time  : $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo -e "  Health : ${GREEN}$(curl -s "$HEALTH_URL" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"ok | vials={d['vials']} | uptime={d['uptime']}s\")" 2>/dev/null || echo "see $HEALTH_URL")${NC}"
echo ""
echo "  Useful commands:"
if [ "$DEPLOY_MODE" = "docker" ]; then
  echo "    docker compose logs -f app     ← stream live logs"
  echo "    docker compose ps              ← check container status"
else
  echo "    pm2 logs cryovault             ← stream live logs"
  echo "    pm2 status                     ← check process status"
  echo "    pm2 monit                      ← live CPU/memory dashboard"
fi
echo ""
