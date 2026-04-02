#!/bin/bash
# =============================================================================
# deploy/scripts/setup.sh — First-Time Server Setup
# =============================================================================
#
# PURPOSE
#   Run this ONCE on a fresh Linux server (Ubuntu 22.04 / 24.04) to install
#   all dependencies and prepare the environment for CryoVault.
#
# WHAT IT INSTALLS
#   - Docker Engine (container runtime)
#   - Docker Compose plugin (orchestration)
#   - Node.js 20 LTS (for pm2-based deployments, optional)
#   - pm2 (process manager, optional)
#   - Required system directories and permissions
#
# USAGE
#   1. SSH into your fresh server:
#        ssh user@your-server-ip
#
#   2. Copy this script to the server (or clone the repo first):
#        scp deploy/scripts/setup.sh user@server:/tmp/
#
#   3. Make it executable and run it:
#        chmod +x /tmp/setup.sh
#        sudo /tmp/setup.sh
#
#   4. Log out and back in (Docker group membership requires a new session)
#
#   5. Then deploy the app (see DEPLOYMENT section below)
#
# WHAT "SUDO" MEANS
#   sudo = "Superuser Do" — runs a command as the root (administrator) user.
#   Installing software system-wide and creating system directories require
#   root privileges. You should NOT run your application as root.
# =============================================================================

# Exit immediately if any command fails.
# Without this, the script would continue even after an error, potentially
# leaving the system in a broken partial state.
set -e

# Print each command before executing it (useful for debugging)
# Comment out with # if the output is too noisy
set -x

# ── Colour helpers ────────────────────────────────────────────────────────────
# ANSI escape codes for coloured terminal output.
# Makes success/warning/error messages easy to spot in a long log.
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'    # NC = No Colour (reset to default)

info()    { echo -e "${BLUE}[INFO]${NC}    $*"; }
success() { echo -e "${GREEN}[OK]${NC}      $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}    $*"; }
error()   { echo -e "${RED}[ERROR]${NC}   $*"; exit 1; }

# ── Verify we are running as root ────────────────────────────────────────────
# $EUID is the "Effective User ID". Root is always 0.
# Running as non-root would cause silent failures for system-level commands.
if [ "$EUID" -ne 0 ]; then
  error "This script must be run as root. Try: sudo $0"
fi

# ── Detect the Linux distribution ────────────────────────────────────────────
# Different distros use different package managers:
#   Debian / Ubuntu → apt-get
#   RHEL / CentOS / Amazon Linux → yum / dnf
# This script is written for Debian/Ubuntu. It detects others and warns.
if [ -f /etc/os-release ]; then
  . /etc/os-release    # Source the OS info file — sets $ID, $VERSION_ID, etc.
  OS=$ID
  OS_VERSION=$VERSION_ID
  info "Detected OS: $PRETTY_NAME"
else
  error "Cannot detect OS. /etc/os-release not found."
fi

if [ "$OS" != "ubuntu" ] && [ "$OS" != "debian" ]; then
  warn "This script is tested on Ubuntu/Debian. Your OS ($OS) may need adjustments."
  warn "Continuing anyway — press Ctrl+C within 5 seconds to abort."
  sleep 5
fi

# ── Read configuration ────────────────────────────────────────────────────────
# These can be overridden by setting environment variables before running:
#   APP_USER=cryovault sudo ./setup.sh
APP_USER="${APP_USER:-cryovault}"      # Unix user that will own and run the app
APP_DIR="${APP_DIR:-/opt/cryovault}"   # Where the application lives
DATA_DIR="${DATA_DIR:-/opt/cryovault-data}"   # Persistent data (database, backups)
LOG_DIR="${LOG_DIR:-/var/log/cryovault}"
NODE_VERSION="${NODE_VERSION:-20}"

info "App directory : $APP_DIR"
info "Data directory: $DATA_DIR"
info "App user      : $APP_USER"


# =============================================================================
# STEP 1: Update the system package list
# =============================================================================
# apt-get update downloads the package list from Ubuntu's servers.
# Without this, apt-get install would use stale package information and
# might try to install old versions or fail to find packages.
# =============================================================================
info "Updating system package list..."
apt-get update -qq    # -qq = quiet (only show errors)
success "Package list updated"


# =============================================================================
# STEP 2: Install system prerequisites
# =============================================================================
# These tools are needed to add external package repositories (for Docker
# and Node.js, which aren't in Ubuntu's default repos at the versions we want).
#
#   curl            → download files from URLs
#   ca-certificates → trust HTTPS connections when downloading repos
#   gnupg           → verify GPG signatures on downloaded packages (security)
#   lsb-release     → detect Ubuntu version for package repo URLs
#   sqlite3         → SQLite command-line tool (for backups and manual queries)
#   ufw             → Uncomplicated Firewall (manage open ports)
# =============================================================================
info "Installing prerequisites..."
apt-get install -y -qq \
  curl \
  ca-certificates \
  gnupg \
  lsb-release \
  sqlite3 \
  ufw \
  fail2ban

success "Prerequisites installed"


# =============================================================================
# STEP 3: Install Docker Engine
# =============================================================================
# Ubuntu's default apt repository has an old version of Docker ("docker.io").
# We add Docker's official repository to get the current version.
#
# The process:
#   1. Download Docker's GPG signing key (proves the packages aren't tampered with)
#   2. Add Docker's apt repository to the system's sources list
#   3. Install docker-ce (community edition) and docker-compose-plugin
# =============================================================================
info "Installing Docker Engine..."

# Check if Docker is already installed to avoid re-running the setup
if command -v docker &> /dev/null; then
  DOCKER_VERSION=$(docker --version)
  warn "Docker is already installed: $DOCKER_VERSION — skipping"
else
  # Create directory for storing repository signing keys
  install -m 0755 -d /etc/apt/keyrings

  # Download Docker's official GPG key and save it
  # curl -fsSL: follow redirects, fail silently on errors, no progress bar
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  # Add the Docker repository to apt's sources
  # $(lsb_release -cs) expands to the Ubuntu codename, e.g. "jammy" for 22.04
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu \
    $(lsb_release -cs) stable" \
    | tee /etc/apt/sources.list.d/docker.list > /dev/null

  # Update package list again so apt knows about Docker's packages
  apt-get update -qq

  # Install Docker Engine and the Compose plugin
  # docker-buildx-plugin is needed for the CI/CD build step
  apt-get install -y -qq \
    docker-ce \
    docker-ce-cli \
    containerd.io \
    docker-buildx-plugin \
    docker-compose-plugin

  success "Docker installed: $(docker --version)"
fi

# Start Docker and enable it to start automatically on boot.
# systemctl is the init system command on modern Ubuntu.
systemctl start docker
systemctl enable docker
success "Docker service enabled and running"


# =============================================================================
# STEP 4: Install Node.js (for pm2 / non-Docker deployments)
# =============================================================================
# Ubuntu's default nodejs package is often 2-3 major versions behind.
# We use NodeSource's repository for the current LTS version.
# If you're using Docker exclusively, you can comment this step out.
# =============================================================================
info "Installing Node.js $NODE_VERSION LTS..."

if command -v node &> /dev/null; then
  NODE_VER=$(node --version)
  warn "Node.js already installed: $NODE_VER — skipping"
else
  # Download and run NodeSource's setup script, which adds their apt repository
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y -qq nodejs
  success "Node.js installed: $(node --version), npm: $(npm --version)"
fi

# Install pm2 globally so it's available as a system command
if ! command -v pm2 &> /dev/null; then
  info "Installing pm2..."
  npm install -g pm2 --silent
  success "pm2 installed: $(pm2 --version)"
else
  warn "pm2 already installed: $(pm2 --version) — skipping"
fi


# =============================================================================
# STEP 5: Create a dedicated application user
# =============================================================================
# SECURITY: Never run your application as root. If the app is compromised,
# the attacker would have root access to the entire server.
#
# We create a dedicated system user "$APP_USER" that:
#   - Has no home directory (--no-create-home)
#   - Cannot log in interactively (--shell /bin/false)
#   - Owns only the files it needs to run the app
#
# The --system flag creates a "system" account (UID < 1000) to distinguish
# it from human user accounts (UID >= 1000).
# =============================================================================
info "Creating application user '$APP_USER'..."

if id "$APP_USER" &>/dev/null; then
  warn "User $APP_USER already exists — skipping"
else
  useradd --system --no-create-home --shell /bin/false "$APP_USER"

  # Add the app user to the "docker" group so it can run docker commands.
  # Without this, docker commands fail with "permission denied".
  # The docker group gives equivalent power to root for container operations
  # — only add trusted users.
  usermod -aG docker "$APP_USER"

  success "User $APP_USER created and added to docker group"
fi

# Also add the HUMAN operator to the docker group so they can use Docker
# without sudo (quality of life improvement).
# $SUDO_USER is the username of the user who invoked sudo.
if [ -n "$SUDO_USER" ]; then
  usermod -aG docker "$SUDO_USER"
  info "Added $SUDO_USER to docker group (log out and back in to take effect)"
fi


# =============================================================================
# STEP 6: Create directory structure
# =============================================================================
# Set up the directories the app needs with correct ownership and permissions.
#
# Permission notation: 750 = rwxr-x---
#   7 (owner) = read + write + execute
#   5 (group) = read + execute
#   0 (other) = no permissions
#
# This means only $APP_USER and members of its group can access these directories.
# =============================================================================
info "Creating directory structure..."

# Application code directory
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"
chmod 750 "$APP_DIR"

# Data directory — database and backups live here, outside the app dir
# so a `git pull` or app update never accidentally deletes the database.
mkdir -p "$DATA_DIR/backups"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

# Log directory
mkdir -p "$LOG_DIR"
chown "$APP_USER:$APP_USER" "$LOG_DIR"
chmod 750 "$LOG_DIR"

# Directory for SSL certificates (used by nginx)
mkdir -p /etc/nginx/certs
chmod 700 /etc/nginx/certs    # Only root should read private keys

success "Directory structure created"


# =============================================================================
# STEP 7: Configure the firewall
# =============================================================================
# UFW (Uncomplicated Firewall) blocks all incoming traffic except for the
# ports we explicitly allow. This is important because Linux servers
# have many services listening on various ports by default.
#
# Ports we allow:
#   22   → SSH (so we can still log in to the server!)
#   80   → HTTP (nginx, redirects to HTTPS)
#   443  → HTTPS (nginx, the actual app)
#
# IMPORTANT: Always allow SSH BEFORE enabling the firewall, or you'll
# lock yourself out of the server.
# =============================================================================
info "Configuring firewall..."

ufw allow OpenSSH      # Port 22 — SSH access
ufw allow 80/tcp       # HTTP
ufw allow 443/tcp      # HTTPS

# Enable the firewall (--force skips the "are you sure?" interactive prompt)
ufw --force enable

success "Firewall configured: SSH, HTTP, HTTPS allowed"
ufw status


# =============================================================================
# STEP 8: Configure fail2ban
# =============================================================================
# fail2ban monitors log files and bans IP addresses that show malicious signs.
# For SSH: if an IP fails to log in 5 times, block it for 10 minutes.
# This dramatically reduces brute-force login attempts.
# =============================================================================
info "Configuring fail2ban (SSH brute-force protection)..."

# The /etc/fail2ban/jail.local file overrides the defaults in jail.conf.
# Never edit jail.conf directly — updates will overwrite your changes.
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
# Ban for 10 minutes after 5 failures within 10 minutes
bantime  = 10m
findtime = 10m
maxretry = 5

[sshd]
enabled = true
port    = ssh
logpath = %(sshd_log)s
backend = %(syslog_backend)s
EOF

systemctl enable fail2ban
systemctl restart fail2ban
success "fail2ban configured and running"


# =============================================================================
# STEP 9: Generate a self-signed SSL certificate (development/internal use)
# =============================================================================
# For production with a real domain, use Let's Encrypt instead:
#   apt-get install certbot
#   certbot certonly --standalone -d your-domain.com
#
# This self-signed cert is for getting nginx up immediately.
# Browsers will show a "not secure" warning, but the connection IS encrypted.
# =============================================================================
info "Generating self-signed SSL certificate..."

if [ -f /etc/nginx/certs/cert.pem ]; then
  warn "SSL certificate already exists — skipping"
else
  openssl req -x509 \
    -nodes \                      # Don't encrypt the private key (no passphrase)
    -days 365 \                   # Valid for 1 year
    -newkey rsa:2048 \            # Generate a new 2048-bit RSA key pair
    -keyout /etc/nginx/certs/key.pem \
    -out    /etc/nginx/certs/cert.pem \
    -subj "/C=US/ST=State/L=City/O=Lab/CN=localhost" \
    2>/dev/null                   # Suppress verbose output

  chmod 600 /etc/nginx/certs/key.pem   # Private key: only root can read
  chmod 644 /etc/nginx/certs/cert.pem  # Public cert: anyone can read

  success "Self-signed certificate generated (valid for 365 days)"
  warn "For production, replace with a Let's Encrypt cert or your institution's cert"
fi


# =============================================================================
# STEP 10: Set up log rotation
# =============================================================================
# Log files grow forever if not pruned. logrotate is a system tool that
# periodically renames, compresses, and deletes old log files.
# =============================================================================
info "Configuring log rotation..."

cat > /etc/logrotate.d/cryovault << EOF
$LOG_DIR/*.log {
    daily               # Rotate logs every day
    rotate 14           # Keep 14 days of logs
    compress            # Compress old logs with gzip
    delaycompress       # Don't compress the most recent rotated log (pm2 might still write to it)
    missingok           # Don't error if the log file doesn't exist
    notifempty          # Don't rotate empty log files
    copytruncate        # Copy log, then truncate original (safe for running processes)
    su $APP_USER $APP_USER   # Run as the app user
}
EOF

success "Log rotation configured"


# =============================================================================
# SETUP COMPLETE
# =============================================================================
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          CryoVault Server Setup Complete!            ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  App directory  : ${BLUE}$APP_DIR${NC}"
echo -e "  Data directory : ${BLUE}$DATA_DIR${NC}"
echo -e "  Log directory  : ${BLUE}$LOG_DIR${NC}"
echo -e "  App user       : ${BLUE}$APP_USER${NC}"
echo ""
echo -e "${YELLOW}NEXT STEPS:${NC}"
echo ""
echo "  1. Log out and back in so Docker group membership takes effect"
echo ""
echo "  2. Copy your application files to the server:"
echo "       git clone https://github.com/yourorg/cryovault.git $APP_DIR"
echo "       # OR use scp / rsync to copy files"
echo ""
echo "  3. Create your .env file:"
echo "       cp $APP_DIR/.env.example $APP_DIR/.env"
echo "       nano $APP_DIR/.env     # Set your values"
echo ""
echo "  4. Start the application:"
echo "       # Docker (recommended):"
echo "       cd $APP_DIR && docker compose up -d"
echo ""
echo "       # OR pm2:"
echo "       cd $APP_DIR && pm2 start deploy/pm2/ecosystem.config.js --env production"
echo "       pm2 startup && pm2 save"
echo ""
echo "  5. Set up automated backups:"
echo "       crontab -e"
echo "       # Add: 0 2 * * * $APP_DIR/deploy/scripts/backup.sh >> $LOG_DIR/backup.log 2>&1"
echo ""
echo "  6. For production HTTPS, replace the self-signed cert:"
echo "       apt-get install certbot"
echo "       certbot certonly --standalone -d your-domain.com"
echo "       # Then update nginx.conf to point to the new cert paths"
echo ""
