#!/bin/bash
# =============================================================================
# deploy/scripts/setup-ssl.sh — SSL Certificate Setup
# =============================================================================
#
# This script sets up HTTPS for CryoVault. Run it on your Ubuntu server
# from inside the cryovault project directory.
#
# OPTION A — Self-signed certificate (LAN / no public domain)
#   For internal lab use where a domain name isn't available.
#   Browsers will show a "Your connection is not private" warning
#   which you click through once and can permanently accept.
#   Zero external dependencies, works offline.
#
# OPTION B — Let's Encrypt certificate (public domain)
#   Requires a real domain name pointing to this server's public IP.
#   Certificates are free, valid for 90 days, and auto-renew.
#   No browser warning.
#
# USAGE
#   chmod +x deploy/scripts/setup-ssl.sh
#   ./deploy/scripts/setup-ssl.sh
# =============================================================================

set -e
cd "$(dirname "$0")/../.."   # ensure we're in the project root

echo ""
echo "  🔐 CryoVault SSL Setup"
echo "  ======================"
echo ""
echo "  Choose a certificate option:"
echo ""
echo "  A) Self-signed certificate — for LAN / internal lab use"
echo "     No domain required. Browser shows a one-time warning."
echo ""
echo "  B) Let's Encrypt — for servers with a public domain name"
echo "     Requires your server to be reachable on port 80 from the internet."
echo ""
read -rp "  Enter A or B: " choice

# ── Create the certs directory ─────────────────────────────────────────────────
mkdir -p certs
echo ""

# ==============================================================================
# OPTION A: Self-signed certificate
# ==============================================================================
if [[ "$choice" =~ ^[Aa]$ ]]; then
  echo "  Generating self-signed certificate…"
  echo ""

  read -rp "  Server hostname or IP (e.g. 192.168.1.100 or cryo.lab): " SERVER_NAME
  SERVER_NAME="${SERVER_NAME:-localhost}"

  # Generate a 4096-bit RSA key and self-signed certificate valid for 5 years.
  # The -subj argument fills in the certificate fields non-interactively.
  # The subjectAltName extension makes modern browsers accept the cert
  # (certificates without SAN are rejected by Chrome/Firefox since 2017).
  openssl req -x509 -nodes \
    -newkey rsa:4096 \
    -days 1825 \
    -keyout certs/key.pem \
    -out    certs/cert.pem \
    -subj "/C=US/ST=Lab/L=Lab/O=CryoVault/CN=${SERVER_NAME}" \
    -addext "subjectAltName=DNS:${SERVER_NAME},IP:${SERVER_NAME}" \
    2>/dev/null || \
  openssl req -x509 -nodes \
    -newkey rsa:4096 \
    -days 1825 \
    -keyout certs/key.pem \
    -out    certs/cert.pem \
    -subj "/C=US/ST=Lab/L=Lab/O=CryoVault/CN=${SERVER_NAME}" \
    2>/dev/null

  echo "  ✓ Certificate generated:"
  echo "    certs/cert.pem  (certificate)"
  echo "    certs/key.pem   (private key)"
  echo ""
  echo "  ⚠  BROWSER WARNING: Browsers will show a security warning because the"
  echo "     certificate is not signed by a recognised authority. To accept it:"
  echo "     Chrome: click 'Advanced' → 'Proceed to ${SERVER_NAME}'"
  echo "     Firefox: click 'Advanced' → 'Accept the risk and continue'"
  echo "     You only need to do this once per browser."
  echo ""

# ==============================================================================
# OPTION B: Let's Encrypt
# ==============================================================================
elif [[ "$choice" =~ ^[Bb]$ ]]; then
  echo "  Setting up Let's Encrypt certificate…"
  echo ""

  read -rp "  Your domain name (e.g. cryo.mylab.org): " DOMAIN
  read -rp "  Email address for renewal notices: " EMAIL

  if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
    echo "  ✗ Domain and email are both required for Let's Encrypt."
    exit 1
  fi

  # Install certbot if not present
  if ! command -v certbot &>/dev/null; then
    echo "  Installing certbot…"
    sudo apt-get update -qq
    sudo apt-get install -y certbot
  fi

  # Stop nginx temporarily so port 80 is free for the ACME challenge
  echo "  Stopping nginx to free port 80…"
  docker compose stop nginx 2>/dev/null || true

  # Obtain the certificate
  echo "  Requesting certificate for ${DOMAIN}…"
  sudo certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "$EMAIL" \
    -d "$DOMAIN"

  # Copy (actually symlink-resolve) the certs into ./certs/
  # certbot stores them in /etc/letsencrypt/live/<domain>/
  sudo cp /etc/letsencrypt/live/${DOMAIN}/fullchain.pem certs/cert.pem
  sudo cp /etc/letsencrypt/live/${DOMAIN}/privkey.pem   certs/key.pem
  sudo chown $(whoami):$(whoami) certs/*.pem

  echo "  ✓ Certificate obtained for ${DOMAIN}"
  echo ""
  echo "  Auto-renewal: certbot installs a systemd timer that renews"
  echo "  certificates before they expire (90-day validity)."
  echo "  After renewal, copy updated files and restart nginx:"
  echo "    sudo cp /etc/letsencrypt/live/${DOMAIN}/fullchain.pem certs/cert.pem"
  echo "    sudo cp /etc/letsencrypt/live/${DOMAIN}/privkey.pem   certs/key.pem"
  echo "    docker compose restart nginx"
  echo ""

else
  echo "  Invalid choice. Run the script again and enter A or B."
  exit 1
fi

# ==============================================================================
# ACTIVATE SSL NGINX CONFIG
# ==============================================================================
echo "  Activating SSL nginx configuration…"

# Back up the current HTTP-only config
cp deploy/nginx/nginx.conf deploy/nginx/nginx-http-only.conf

# Install the SSL config as the active config
cp deploy/nginx/nginx-ssl.conf deploy/nginx/nginx.conf

# Update docker-compose.yml to expose port 443 and mount the certs directory
# We do this with sed rather than requiring manual editing
if grep -q '- "443:443"' docker-compose.yml; then
  echo "  Port 443 already configured in docker-compose.yml"
else
  # Add 443 port and certs volume mount to nginx service
  sed -i 's/      - "80:80"/      - "80:80"\n      - "443:443"/' docker-compose.yml
  echo "  ✓ Added port 443 to docker-compose.yml"
fi

if grep -q './certs:/etc/nginx/certs' docker-compose.yml; then
  echo "  Certs volume already configured in docker-compose.yml"
else
  sed -i 's|      - ./deploy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro|      - ./deploy/nginx/nginx.conf:/etc/nginx/nginx.conf:ro\n      - ./certs:/etc/nginx/certs:ro|' docker-compose.yml
  echo "  ✓ Added certs volume mount to docker-compose.yml"
fi

echo ""
echo "  Restarting nginx with SSL…"
docker compose up -d nginx

echo ""
echo "  ✓ SSL setup complete."
if [[ "$choice" =~ ^[Aa]$ ]]; then
  echo "  Access CryoVault at: https://${SERVER_NAME}"
else
  echo "  Access CryoVault at: https://${DOMAIN}"
fi
echo ""
