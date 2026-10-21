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

### HTTPS with self-signed lab certificates

For an internal deployment: HTTPS on the port you already use, with your own
certificates. Browsers need HTTPS for camera access, so QR scanning on
phones and tablets depends on it.

You create one small **lab certificate authority (CA)** once, and use it to
sign a certificate for each server. Each computer or phone then trusts the
CA once, which covers every server it signed and every future renewal. You
never click through browser warnings.

#### 1. Create the lab CA (once, on any computer with `openssl`)

```bash
mkdir -p ~/cryovault-ca && cd ~/cryovault-ca
openssl req -x509 -new -nodes -newkey rsa:4096 -sha256 -days 3650 \
  -keyout ca.key -out ca.crt \
  -subj "/O=NU-ANTEC/CN=NU-ANTEC CryoVault Lab CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
chmod 600 ca.key
```

`ca.crt` is the file you install on computers and phones. Keep `ca.key`
private and off the servers: anyone holding it can make certificates that
your computers will trust. Keep a copy somewhere safe, because you'll need it
to renew server certificates. It must never go in the repository.

#### 2. Make a certificate for each server (in the same folder)

List every name and address people use to reach that server. Run
`hostname -f` and `hostname -I` on the server to see them. A name that isn't
listed gets a certificate error.

```bash
NAME=cryo1                                   # a short label for this server
cat > $NAME.ext <<EOF
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:cryo1, DNS:cryo1.example.northwestern.edu, IP:10.0.0.21
EOF
openssl req -new -nodes -newkey rsa:2048 -keyout $NAME.key -out $NAME.csr -subj "/CN=$NAME"
openssl x509 -req -in $NAME.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out $NAME.crt -days 825 -sha256 -extfile $NAME.ext
openssl verify -CAfile ca.crt $NAME.crt      # should print: cryo1.crt: OK
```

Replace the `subjectAltName` line with that server's real names and IPs.
Use `DNS:` for names and `IP:` for addresses, separated by commas. 825 days
is the longest validity Apple devices accept. Repeat for the second server
with its own `NAME` and names.

Copy the two files into the server's cryovault folder:

```bash
# on the server, in the cryovault folder
mkdir -p certs
cp /path/to/cryo1.crt certs/cert.pem
cp /path/to/cryo1.key certs/key.pem
chmod 600 certs/key.pem
```

(`certs/` is in `.gitignore`.)

#### 3. Switch the server to HTTPS on the same port

```bash
git pull
cp docker-compose.yml docker-compose.yml.http-backup
```

Edit `docker-compose.yml` so that:

- **The `app` service has no `ports:` section.** Delete it if present, for
  example `- "${DOCKER_HOST_PORT:-3000}:${PORT:-3000}"`. Keep `expose: ["3000"]`
  and `networks: [internal]`, so the app is only reachable through nginx.
- **There is an `nginx` service like this:**

  ```yaml
  nginx:
    image: nginx:1.25-alpine
    container_name: cryovault-nginx
    restart: unless-stopped
    ports:
      - "${HTTPS_PORT:-44300}:443"
    volumes:
      - ./deploy/nginx/nginx-ssl.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - app
    networks:
      - internal
  ```

If you never customised the compose file, you can instead copy
`docker-compose.yml.example` over it. Check with
`diff docker-compose.yml docker-compose.yml.example` first.

In `.env`, set `HTTPS_PORT` to the port you use today (for example
`HTTPS_PORT=44300`). Then apply it:

```bash
docker compose up -d
docker compose ps                  # app and nginx both "Up"
```

Check it from another machine:

```bash
curl --cacert ca.crt https://cryo1:44300/api/health    # {"status":"ok",...}
curl -sI http://cryo1:44300/ | head -3                  # 301 → https://cryo1:44300/
```

Old `http://…:44300` bookmarks keep working: nginx redirects plain HTTP on
that port to HTTPS on the same port.

#### 4. Trust the lab CA on each computer and phone (once)

Copy `ca.crt` (never `ca.key`) to the device, then:

| Device | How |
|---|---|
| Windows (Chrome, Edge) | As administrator: `certutil -addstore -f Root ca.crt`, or double-click `ca.crt` → Install Certificate → Local Machine → Trusted Root Certification Authorities |
| macOS (Safari, Chrome) | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ca.crt` |
| Linux (system tools) | `sudo cp ca.crt /usr/local/share/ca-certificates/cryovault-lab-ca.crt && sudo update-ca-certificates` |
| Linux (Chrome/Chromium) | `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "CryoVault Lab CA" -i ca.crt` (from package `libnss3-tools`) |
| Firefox (any OS) | Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import → tick "Trust this CA to identify websites" |
| iPhone / iPad | Send `ca.crt` by AirDrop or email and open it → Settings → Profile Downloaded → Install. Then Settings → General → About → Certificate Trust Settings → turn the CA on |
| Android | Settings → Security → Encryption & credentials → Install a certificate → CA certificate (menu names vary by phone) |

Restart the browser afterwards.

#### Renewing and undoing

- **A server certificate expires (after 825 days):** repeat step 2 for that
  server, copy the new files into `certs/`, then run
  `docker compose restart nginx`. Devices need nothing new. The CA lasts 10 years.
- **Check a certificate's expiry date:** `openssl x509 -in certs/cert.pem -noout -enddate`
- **Back to plain HTTP:** run `cp docker-compose.yml.http-backup docker-compose.yml`,
  then `docker compose up -d --remove-orphans`.

---

### Updating

```bash
# If deployed from a zip — copy new files over and rebuild
bash run.sh update

# If deployed from git
git pull
bash run.sh update
```

#### Upgrading to "one active vial per position" (database change)

Older versions let an archived vial or box keep blocking its position, so a
cell could look empty but refuse a new vial. This version changes the rule to
one *active* vial per position and one *active* box per slot. It converts the
database by itself on first start. For this upgrade, use the upgrade script
instead of `run.sh update`, because it backs everything up first and checks
the result:

```bash
git pull
bash deploy/scripts/upgrade.sh
```

It builds the new image, stops the app for about a minute, and writes to
`backups/upgrade-<time>/`:

| File | What it is |
|------|------------|
| `cryovault.db` | Exact copy of the database file |
| `cryovault-export.json` | Complete JSON snapshot (all tanks, archived items included), importable from **Admin → Data Import → JSON → Replace** |
| `cryovault-history.json` | Full change history |
| `bug-report.txt` | Vials affected by the old bug (added but hidden, or archived records that were overwritten) |

Then it starts the new version and checks that the counts match and the
conversion happened. To undo the upgrade (database and code):

```bash
bash deploy/scripts/upgrade.sh --rollback backups/upgrade-<time>
```

Even without the script, the app saves an unconverted copy of the database
next to it (`cryovault.db.pre-active-unique-<time>.bak`) before converting.

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
├── db.js                        # SQLite setup, schema, migrations, audit helper
├── lib/
│   └── dbtools.js               # Snapshot/backup/verify tools (used by export + upgrade.sh)
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
│       ├── upgrade.sh           # Back up, upgrade and verify (database changes)
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
| `GET` | `/export` | Download full JSON snapshot (format 2.0: all tanks, every column, archived items included) |
| `GET` | `/export/history` | Download full audit log |
| `POST` | `/import` | Import JSON (`{ data, mode, changedBy }`). `replace` restores the file exactly; `merge` adds missing active items. Accepts format 1.0 and 2.0 files. |

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
