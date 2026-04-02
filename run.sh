#!/bin/bash
# =============================================================================
# run.sh — CryoVault Docker Quick-Start
# =============================================================================
#
# PURPOSE
#   The single command you run to get CryoVault up and running in Docker.
#   Handles first-time setup (copying .env, creating the data directory) and
#   then starts the containers.
#
# USAGE
#   bash run.sh           — first-time setup + start (interactive, with prompts)
#   bash run.sh start     — start containers (docker compose up -d)
#   bash run.sh stop      — stop containers
#   bash run.sh restart   — restart containers
#   bash run.sh status    — show container status + health check
#   bash run.sh logs      — follow live container logs
#   bash run.sh update    — rebuild image and restart
#   bash run.sh backup    — run a database backup now
#   bash run.sh shell     — open a shell inside the running container
#   bash run.sh db        — open SQLite shell on the live database
#   bash run.sh destroy   — stop and remove containers (data is preserved)
#
# REQUIREMENTS
#   Docker Engine 20.10+   — install: https://docs.docker.com/engine/install
#   Docker Compose plugin  — bundled with Docker Desktop and Docker Engine 23+
#   Check:  docker compose version
# =============================================================================

set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[cryovault]${NC} $*"; }
success() { echo -e "${GREEN}[cryovault]${NC} $*"; }
warn()    { echo -e "${YELLOW}[cryovault]${NC} $*"; }
error()   { echo -e "${RED}[cryovault]${NC} ERROR: $*"; exit 1; }

# ── Ensure we're in the correct directory ──────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Pre-flight: check Docker is available ─────────────────────────────────────
check_docker() {
  command -v docker &>/dev/null \
    || error "Docker is not installed. See https://docs.docker.com/engine/install/"
  docker compose version &>/dev/null \
    || error "Docker Compose plugin not found. Upgrade Docker to version 23+."
  docker info &>/dev/null \
    || error "Docker daemon is not running. Start it with: sudo systemctl start docker"
}

# ── Health check helper ────────────────────────────────────────────────────────
health_check() {
  local port
  port=$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo 3000)
  local url="http://localhost:${port}/api/health"
  echo ""
  info "Health check → ${url}"
  sleep 2
  for i in $(seq 1 10); do
    if curl -sf "$url" > /tmp/cv_health.json 2>/dev/null; then
      success "Server is up ✓"
      echo ""
      # Pretty-print the health JSON if python3 is available
      python3 -m json.tool < /tmp/cv_health.json 2>/dev/null || cat /tmp/cv_health.json
      echo ""
      success "Open in browser: http://localhost:${port}"
      return 0
    fi
    info "Waiting for server… (attempt $i/10)"
    sleep 2
  done
  warn "Health check timed out. Check logs: bash run.sh logs"
  return 1
}

# =============================================================================
# COMMAND: (no args or 'start' on first run) — setup + start
# =============================================================================
cmd_setup_and_start() {
  check_docker

  # ── Step 1: Create .env from template if it doesn't exist ────────────────
  if [[ ! -f .env ]]; then
    info "First run — creating .env from .env.example…"
    cp .env.example .env

    # Set Docker-appropriate defaults in the new .env
    # DB_PATH must point inside the container's volume mount
    sed -i 's|^DB_PATH=.*|DB_PATH=/data/cryovault.db|'       .env
    sed -i 's|^NODE_ENV=.*|NODE_ENV=production|'              .env
    sed -i 's|^DOCKER_DB_VOLUME=.*|DOCKER_DB_VOLUME=./data|'  .env

    success ".env created — edit it to customise (port, CORS origin, etc.)"
    echo ""
    echo "  Key settings in .env:"
    echo "    PORT              — HTTP port the container exposes (default: 3000)"
    echo "    DOCKER_HOST_PORT  — host port mapped to the container (default: 3000)"
    echo "    CORS_ORIGIN       — allowed origins (use your domain in production)"
    echo "    DB_PATH           — database path inside the container (keep as /data/...)"
    echo ""
    read -r -p "  Press Enter to start with defaults, or Ctrl+C to edit .env first…"
  else
    info ".env already exists — using existing configuration"
  fi

  # ── Step 2: Create the host data directory for the volume mount ──────────
  DATA_VOL=$(grep '^DOCKER_DB_VOLUME=' .env 2>/dev/null | cut -d= -f2 || echo './data')
  if [[ ! -d "$DATA_VOL" ]]; then
    mkdir -p "$DATA_VOL"
    info "Created data directory: $DATA_VOL"
    info "Your database will be stored here and survive container rebuilds."
  fi

  # ── Step 3: Build and start ───────────────────────────────────────────────
  info "Building image and starting containers…"
  docker compose up -d --build

  health_check
}

# =============================================================================
# COMMAND DISPATCH
# =============================================================================
CMD="${1:-}"

case "$CMD" in

  # ── Bare invocation or explicit 'start' ─────────────────────────────────
  "" | "start")
    if [[ ! -f .env ]]; then
      cmd_setup_and_start
    else
      check_docker
      info "Starting containers…"
      docker compose up -d
      health_check
    fi
    ;;

  # ── Stop ──────────────────────────────────────────────────────────────────
  "stop")
    check_docker
    info "Stopping containers…"
    docker compose stop
    success "Containers stopped. Data is preserved."
    ;;

  # ── Restart ───────────────────────────────────────────────────────────────
  "restart")
    check_docker
    info "Restarting containers…"
    docker compose restart
    health_check
    ;;

  # ── Status ────────────────────────────────────────────────────────────────
  "status")
    check_docker
    echo ""
    docker compose ps
    health_check || true
    ;;

  # ── Logs ─────────────────────────────────────────────────────────────────
  "logs")
    check_docker
    info "Following logs (Ctrl+C to stop)…"
    docker compose logs -f app
    ;;

  # ── Update — rebuild image with latest code and restart ──────────────────
  "update")
    check_docker
    info "Rebuilding image from current source…"
    docker compose build app
    info "Replacing running container…"
    docker compose up -d --no-deps app
    health_check
    ;;

  # ── Open a shell inside the running app container ────────────────────────
  "shell")
    check_docker
    info "Opening shell in app container (type 'exit' to leave)…"
    docker compose exec app sh
    ;;

  # ── Open SQLite shell on the live database ────────────────────────────────
  "db")
    check_docker
    DB_PATH=$(grep '^DB_PATH=' .env 2>/dev/null | cut -d= -f2 || echo /data/cryovault.db)
    info "Opening SQLite shell on $DB_PATH"
    warn "Do not run DDL (ALTER/DROP/CREATE) while the server is running."
    echo ".tables" | docker compose exec -T app sh -c "sqlite3 $DB_PATH" \
      && docker compose exec -it app sh -c "sqlite3 $DB_PATH"
    ;;

  # ── Manual database backup ────────────────────────────────────────────────
  "backup")
    check_docker
    info "Running database backup inside the container…"
    docker compose exec app sh -c "sh /app/deploy/scripts/backup.sh"
    success "Backup complete."
    ;;

  # ── Stop + remove containers (data volume is preserved) ──────────────────
  "destroy")
    check_docker
    echo ""
    warn "This will stop and remove the containers."
    warn "Your database volume is preserved — data will not be lost."
    read -r -p "Continue? [y/N] " CONFIRM
    [[ "$CONFIRM" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }
    docker compose down
    success "Containers removed. Run 'bash run.sh start' to recreate them."
    ;;

  # ── Unknown command ────────────────────────────────────────────────────────
  *)
    grep '^#   bash run.sh' "$0" | sed 's/^#   /  /'
    exit 1
    ;;

esac
