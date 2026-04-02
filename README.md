# 🧊 CryoVault — Laboratory Cryogenic Storage Inventory

A full-stack inventory system for LN₂ cryogenic storage tanks.
**Node.js + Express · SQLite · Audit trail · QR codes · Docker**

---

## Docker Deployment

### Requirements

- **Docker Engine 20.10+** — [install guide](https://docs.docker.com/engine/install/)
- **Docker Compose plugin** — bundled with Docker Desktop and Docker Engine 23+

Verify both are working:
```bash
docker compose version
```

---

### One-command start

```bash
bash run.sh
```

On first run this will:
1. Copy `.env.example` → `.env` and `docker-compose.yml.example` → `docker-compose.yml` with Docker-appropriate defaults
2. Create a `./data/` directory on your host for the SQLite database
3. Build the Docker image
4. Start the container
5. Confirm the server is healthy at `http://localhost:3000`

---

### Day-to-day commands

```bash
bash run.sh start      # Start containers
bash run.sh stop       # Stop containers (data preserved)
bash run.sh restart    # Restart
bash run.sh status     # Container status + health check
bash run.sh logs       # Follow live logs (Ctrl+C to stop)
bash run.sh update     # Rebuild image from current source and restart
bash run.sh backup     # Run a database backup now
bash run.sh shell      # Open a shell inside the running container
bash run.sh db         # Open a SQLite shell on the live database
bash run.sh destroy    # Remove containers (data volume preserved)
```

---

### Configuration

Edit `.env` before starting (or after — then `bash run.sh restart`):

```bash
nano .env
```

Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the Node.js server listens on inside the container |
| `DOCKER_HOST_PORT` | `3000` | Host port mapped to the container |
| `DB_PATH` | `/data/cryovault.db` | Database path inside the container — keep under `/data/` |
| `DOCKER_DB_VOLUME` | `./data` | Host directory mounted as `/data` inside the container |
| `NODE_ENV` | `production` | Set to `development` for verbose logging |
| `CORS_ORIGIN` | `*` | Restrict to your domain in production, e.g. `https://cryo.mylab.org` |

Full documentation of all variables is in `.env.example`.

---

### Data persistence

The SQLite database is stored at `./data/cryovault.db` on your **host machine**
(mapped into the container at `/data/cryovault.db`). It survives:

- Container restarts (`bash run.sh restart`)
- Image rebuilds (`bash run.sh update`)
- Container removal (`bash run.sh destroy`)

The only way to lose data is to manually delete the `./data/` directory.

**Backup:**
```bash
bash run.sh backup
# Creates a timestamped gzip backup in ./data/backups/
```

**Restore:**
```bash
bash run.sh stop
gunzip -c ./data/backups/cryovault-2024-06-01_02-00-00.db.gz > ./data/cryovault.db
bash run.sh start
```

---

### Running on a non-default port

```bash
# In .env:
PORT=3000
DOCKER_HOST_PORT=8080   # access at http://yourserver:8080
```

---

### Running behind a reverse proxy (nginx / Apache)

If you want HTTPS, run the app on an internal port and proxy to it:

```bash
# In .env — bind to localhost only, nginx handles the public port
DOCKER_HOST_PORT=3000
CORS_ORIGIN=https://cryo.mylab.org
```

A ready-to-use nginx config is included at `deploy/nginx/nginx.conf`.

---

### Updating

```bash
# If deployed from a zip — copy new files over and rebuild
bash run.sh update

# If deployed from git
git pull
bash run.sh update
```

---

## Quick Start (Development — no Docker)

```bash
npm install
npm run dev
# → http://localhost:3000
```

---

## Project Structure

```
cryovault/
│
├── server.js                    # Express app — entry point
├── db.js                        # SQLite setup, schema, audit helper
├── package.json                 # Dependencies and npm scripts
│
├── routes/
│   ├── racks.js                 # Rack CRUD API
│   ├── boxes.js                 # Box CRUD API
│   ├── vials.js                 # Vial upsert/delete API
│   ├── history.js               # Audit log query API
│   └── transfer.js              # Import / export API
│
├── public/
│   └── index.html               # Frontend SPA (served statically)
│
├── deploy/
│   ├── nginx/
│   │   └── nginx.conf           # Reverse proxy config (HTTPS, compression)
│   ├── pm2/
│   │   └── ecosystem.config.js  # pm2 process manager config
│   └── scripts/
│       ├── setup.sh             # One-time server provisioning script
│       ├── deploy.sh            # Manual deployment with rollback
│       └── backup.sh            # Database backup (run via cron)
│
├── .github/
│   └── workflows/
│       └── deploy.yml           # GitHub Actions CI/CD pipeline
│
├── .env.example                 # All environment variables, documented
├── .env                         # Your local config (never commit this)
├── Dockerfile                   # Container image definition
├── docker-compose.yml           # Multi-container orchestration
├── .dockerignore                # Files excluded from Docker builds
└── .gitignore                   # Files excluded from git
```

---

## Deployment Guide

There are two production deployment paths. Choose the one that suits your situation.

---

### Path A — Docker (Recommended)

Docker packages the app and all its dependencies into a portable container.
No "works on my machine" problems. Easy to update, easy to roll back.

**Requires:** A Linux server (Ubuntu 22.04+), 1 GB RAM minimum, SSH access.

#### Step 1 — Provision the server (one-time)

```bash
# SSH into your server
ssh user@your-server-ip

# Download and run the setup script
curl -fsSL https://raw.githubusercontent.com/yourorg/cryovault/main/deploy/scripts/setup.sh \
  | sudo bash
```

The setup script installs Docker, creates a dedicated user, configures the
firewall, and sets up SSL certificates. Read `deploy/scripts/setup.sh` for
a full explanation of every step.

After it finishes, **log out and back in** (Docker group membership requires
a new shell session).

#### Step 2 — Copy application files

```bash
# On the server:
git clone https://github.com/yourorg/cryovault.git /opt/cryovault
cd /opt/cryovault
```

#### Step 3 — Configure environment

```bash
cp .env.example .env
nano .env          # Edit values — at minimum set APP_URL and CORS_ORIGIN
```

Key settings to change for production:

| Variable | What to set |
|----------|-------------|
| `NODE_ENV` | `production` |
| `APP_URL` | `https://your-domain.com` |
| `CORS_ORIGIN` | `https://your-domain.com` |
| `DOCKER_DB_VOLUME` | `/opt/cryovault-data` |

#### Step 4 — Start the application

```bash
docker compose up -d
```

Docker will:
1. Build the application image from the `Dockerfile`
2. Start the app container on the internal Docker network
3. Start the nginx container listening on ports 80 and 443
4. Mount a persistent volume for the database

Check that everything started:

```bash
docker compose ps              # Should show both containers as "running"
docker compose logs app        # App startup logs
curl http://localhost:3000/api/health    # Should return JSON with status: "ok"
```

#### Step 5 — Point your domain

In your DNS provider, create an **A record** pointing your domain to the
server's IP address. DNS propagation can take a few minutes to a few hours.

#### Step 6 — Get a real SSL certificate (production)

The setup script creates a self-signed certificate (browser shows a warning).
For a trusted certificate, use Let's Encrypt:

```bash
# Install certbot
apt-get install -y certbot

# Obtain a certificate (server must be reachable on port 80)
certbot certonly --standalone -d your-domain.com

# Update nginx.conf to use the new certificate paths:
# ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
# ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

# Reload nginx
docker compose exec nginx nginx -s reload
```

Certbot certificates renew automatically every 90 days.

#### Updating the app (Docker)

```bash
cd /opt/cryovault
./deploy/scripts/deploy.sh       # Pulls code, builds image, restarts, health checks
```

Or, if you have GitHub Actions set up, just push to `main` and it deploys automatically.

---

### Path B — pm2 (Simpler, no Docker)

pm2 is a Node.js process manager. Simpler to set up but less isolated than Docker.
Recommended if Docker feels like too much to learn at once.

#### Step 1 — Provision the server

Same as Path A — run `setup.sh`. It installs both Docker and Node.js/pm2.

#### Step 2 — Deploy files and install dependencies

```bash
git clone https://github.com/yourorg/cryovault.git /opt/cryovault
cd /opt/cryovault
npm ci --omit=dev
cp .env.example .env
nano .env
```

#### Step 3 — Start with pm2

```bash
pm2 start deploy/pm2/ecosystem.config.js --env production
```

#### Step 4 — Make pm2 start on boot

```bash
# pm2 startup prints a command — copy and run it as root
pm2 startup

# Save the current process list so pm2 restores it after reboot
pm2 save
```

#### Updating the app (pm2)

```bash
cd /opt/cryovault
./deploy/scripts/deploy.sh --mode=pm2
```

---

### Automated CI/CD with GitHub Actions

The pipeline in `.github/workflows/deploy.yml` automatically:
- Runs tests on every pull request
- Builds a Docker image on every merge to `main`
- Deploys to your server

**One-time setup in GitHub:**

Go to your repository → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

| Secret name | Value |
|-------------|-------|
| `DEPLOY_HOST` | Your server's IP address or hostname |
| `DEPLOY_USER` | SSH username (e.g., `ubuntu`) |
| `DEPLOY_SSH_KEY` | The **private** SSH key (run `cat ~/.ssh/id_ed25519`) |
| `DEPLOY_PATH` | Path on the server (e.g., `/opt/cryovault`) |

After this, every `git push origin main` triggers an automated deployment.

---

## Automated Database Backups

```bash
# Test the backup script manually
./deploy/scripts/backup.sh

# Schedule automatic daily backups at 2 AM via cron
crontab -e
# Add this line:
0 2 * * * /opt/cryovault/deploy/scripts/backup.sh >> /var/log/cryovault/backup.log 2>&1
```

Backups are stored in `$BACKUP_DIR` (default: `./backups/`) as gzip-compressed files.
Files older than `$BACKUP_KEEP_DAYS` (default: 30) are automatically deleted.

**Restore from backup:**
```bash
gunzip -c backups/cryovault-2024-06-01_02-00-00.db.gz > restored.db
# Then copy restored.db to the path in $DB_PATH and restart the server
```

---

## REST API Reference

All endpoints are prefixed with `/api`.

### Tanks
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tanks` | Get tank info |
| `PUT` | `/tanks/:id` | Update tank name/notes |

### Racks
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tanks/:tankId/racks` | List all racks |
| `GET` | `/racks/:id` | Get a single rack |
| `POST` | `/tanks/:tankId/racks` | Create a rack |
| `PUT` | `/racks/:id` | Update a rack |
| `DELETE` | `/racks/:id?changedBy=name` | Delete rack (cascades) |

### Boxes
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/racks/:rackId/boxes` | List boxes in a rack |
| `GET` | `/boxes/:id` | Get a single box |
| `POST` | `/racks/:rackId/boxes` | Create a box |
| `PUT` | `/boxes/:id` | Update box (safe grid resize) |
| `DELETE` | `/boxes/:id?changedBy=name` | Delete box (cascades) |

### Vials
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/boxes/:boxId/vials` | All occupied positions + box info |
| `PUT` | `/boxes/:boxId/vials/:row/:col` | Add or update vial at position |
| `DELETE` | `/boxes/:boxId/vials/:row/:col?changedBy=name` | Remove vial |

### History
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/history` | Paginated audit log (filterable) |
| `GET` | `/history/:entityType/:entityId` | History for one object |

### Import / Export
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/export` | Download full JSON snapshot |
| `GET` | `/export/history` | Download full audit log |
| `POST` | `/import` | Import JSON (`{ data, mode, changedBy }`) |

### Health
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Status, uptime, record counts |

---

## Environment Variables

See `.env.example` for the full list with explanations.

Minimum required for production:

```bash
NODE_ENV=production
PORT=3000
DB_PATH=/opt/cryovault-data/cryovault.db
CORS_ORIGIN=https://your-domain.com
```

---

## Monitoring

Check the app is running:
```bash
curl http://localhost:3000/api/health
```

Watch live logs:
```bash
docker compose logs -f app    # Docker
pm2 logs cryovault            # pm2
```

Watch CPU/memory (pm2):
```bash
pm2 monit
```

---

## Migrating from SQLite to PostgreSQL

When you outgrow SQLite (multiple servers, heavy write load), migrate to PostgreSQL:

1. Export your data: `GET /api/export` → save the JSON
2. Set up a PostgreSQL server
3. Replace `better-sqlite3` with `pg`
4. Convert `db.js` to use async `pool.query()` calls
5. Change `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL`
6. Change `TEXT PRIMARY KEY` → `UUID DEFAULT gen_random_uuid()`
7. Import your data via the `/api/import` endpoint

The schema is intentionally straightforward to make this migration manageable.

---

## License

MIT — free for laboratory and research use.
