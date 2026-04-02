# =============================================================================
# Dockerfile — CryoVault Container Image
# =============================================================================
#
# WHY TWO STAGES?
#   Stage 1 (deps): installs build tools and compiles better-sqlite3's native
#   C extension. Build tools (gcc, make, python3) are only needed at compile
#   time, not at runtime.
#
#   Stage 2 (final): copies the compiled node_modules from stage 1 into a
#   fresh image that has no build tools, reducing the attack surface.
#
# WHY node:20 (Debian) FOR BOTH STAGES — NOT ALPINE?
#   better-sqlite3 compiles a native C extension (.node binary) that links
#   against the C standard library. Alpine Linux uses musl libc; the standard
#   node:20 image uses glibc (Debian). These two are ABI-incompatible:
#   a binary compiled against glibc cannot run on musl and will crash with
#   "symbol not found: fcntl64" at startup.
#
#   Using Debian for both stages ensures the binary compiled in stage 1 is
#   the same ABI as the runtime in stage 2. The image is larger than an
#   Alpine-based one (~200 MB vs ~50 MB) but works correctly.
#
# BUILD:   docker build -t cryovault:latest .
# RUN:     docker run -p 3000:3000 -v /your/data:/data cryovault:latest
# =============================================================================


# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20 AS deps

WORKDIR /build

# Copy package files first so Docker can cache this layer.
# npm install only re-runs when package.json changes.
COPY package*.json ./

# Install build tools, compile better-sqlite3, remove build tools.
# build-essential provides gcc/g++/make; python3 is required by node-gyp.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends python3 build-essential && \
    npm install --omit=dev --no-fund --no-audit && \
    apt-get remove -y python3 build-essential && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*


# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
# Use the same Debian-based image as the build stage so the compiled
# better-sqlite3 binary runs against the same glibc.
FROM node:20

WORKDIR /app

# Install sqlite3 CLI — required by the backup module for hot SQLite backups.
# This is a system package (not an npm package), so it goes in the runtime
# image via apt, not in the build stage.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends sqlite3 && \
    rm -rf /var/lib/apt/lists/*

# Copy compiled node_modules from the build stage
COPY --from=deps /build/node_modules ./node_modules

# Copy application source (.dockerignore excludes .env, *.db, node_modules)
COPY . .

# Runtime environment defaults (overridden by docker-compose.yml)
ENV PORT=3000
ENV DB_PATH=/data/cryovault.db
ENV NODE_ENV=production

# /data is the volume mount point for the SQLite database file.
# Map a host directory here so data persists across container restarts:
#   docker run -v /your/host/data:/data cryovault:latest
VOLUME ["/data"]

EXPOSE 3000

# Health check — used by Docker and docker-compose to monitor the container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

# Array form ensures SIGTERM is delivered directly to the Node process
# (a shell string would wrap it in /bin/sh, which often swallows signals).
CMD ["node", "server.js"]
