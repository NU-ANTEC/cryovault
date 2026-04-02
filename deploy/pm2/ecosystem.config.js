// =============================================================================
// deploy/pm2/ecosystem.config.js — pm2 Process Manager Configuration
// =============================================================================
//
// WHAT IS pm2?
//   pm2 (Process Manager 2) keeps your Node.js process running permanently.
//   Without it, if your server reboots or the Node.js process crashes,
//   the application simply stops and stays stopped until someone manually
//   restarts it. pm2 handles:
//
//   • Auto-restart on crash        → if the process dies, pm2 restarts it
//   • Auto-restart on server boot  → survives reboots without manual intervention
//   • Log management               → captures stdout/stderr to rotating log files
//   • Zero-downtime restarts       → reload new code without dropping connections
//   • Cluster mode (optional)      → run N processes to use multiple CPU cores
//
// WHEN TO USE pm2 vs DOCKER?
//   pm2 (bare metal / VM):
//   ✓ Simpler to set up if you have direct server access
//   ✓ No Docker knowledge required
//   ✓ Easier to debug (just SSH in and read logs)
//   ✗ "Works on my machine" risk — environment differs from developer's laptop
//   ✗ Harder to replicate the setup on a new server
//
//   Docker + docker-compose:
//   ✓ Identical environment everywhere (dev, staging, prod)
//   ✓ Easy to roll back (just pull an older image tag)
//   ✓ Portable — move to any server in minutes
//   ✗ Additional layer of complexity to learn
//
//   For a single-server lab deployment, either works well. Many teams start
//   with pm2 and migrate to Docker later when they need staging environments
//   or multiple servers.
//
// INSTALLATION (one-time, on the server)
//   npm install -g pm2
//
// USAGE
//   pm2 start deploy/pm2/ecosystem.config.js       ← start the app
//   pm2 stop cryovault                             ← stop it
//   pm2 restart cryovault                          ← restart (brief downtime)
//   pm2 reload cryovault                           ← reload (zero downtime)
//   pm2 status                                     ← check if it's running
//   pm2 logs cryovault                             ← stream live logs
//   pm2 logs cryovault --lines 100                 ← last 100 log lines
//
// SURVIVE SERVER REBOOTS (run once after first start)
//   pm2 startup     ← prints a command, run that command as root
//   pm2 save        ← saves the process list so pm2 restores it after reboot
//
// DEPLOY NEW CODE (update + restart)
//   git pull
//   npm ci --omit=dev
//   pm2 reload ecosystem.config.js --update-env
// =============================================================================

module.exports = {
  apps: [
    {
      // ── Identity ────────────────────────────────────────────────────────────
      // The name used in all pm2 commands: pm2 logs cryovault, pm2 stop cryovault
      name: "cryovault",

      // The entry point script (relative to where you run pm2 start from,
      // or use an absolute path to be safe)
      script: "server.js",

      // Working directory — where the app is installed on the server.
      // Change this to wherever you cloned/copied the application files.
      cwd: "/opt/cryovault",


      // ── Runtime mode ────────────────────────────────────────────────────────
      // "fork" mode: a single Node.js process (simplest, recommended for SQLite).
      // Why? SQLite is single-writer. Multiple processes would compete for the
      // database lock and get "database is locked" errors.
      //
      // "cluster" mode: pm2 spawns N worker processes using Node's cluster API.
      // This uses all CPU cores and is great for CPU-bound or high-traffic apps
      // — but requires the app to be stateless and the database to support
      // concurrent writes (PostgreSQL, MySQL, not SQLite).
      //
      // → Use "fork" with SQLite. Upgrade to "cluster" + PostgreSQL later.
      exec_mode: "fork",
      instances: 1,           // Number of processes (always 1 for SQLite)


      // ── Environment variables ────────────────────────────────────────────────
      // pm2 injects these into the process's environment.
      // These are the PRODUCTION values — they override any .env file.
      // For sensitive values (passwords), prefer injecting them via the
      // system's environment or a secrets manager rather than hardcoding here.
      env_production: {
        NODE_ENV: "production",
        PORT: 3000,
        // Database stored outside the app directory so it survives git pulls
        DB_PATH: "/opt/cryovault-data/cryovault.db",
        CORS_ORIGIN: "*",
        LOG_LEVEL: "info",
        LOG_FORMAT: "json",           // JSON logs integrate with log aggregators
        DB_WAL_MODE: "true",
        DB_AUDIT_MAX_ROWS: "200",
        UPLOAD_MAX_SIZE: "50mb",
        BACKUP_ENABLED: "false",      // Use the backup.sh cron job instead
        BACKUP_DIR: "/opt/cryovault-data/backups",
      },

      // Development overrides: `pm2 start ecosystem.config.js --env development`
      env_development: {
        NODE_ENV: "development",
        PORT: 3000,
        DB_PATH: "./cryovault-dev.db",
        LOG_LEVEL: "debug",
        LOG_FORMAT: "pretty",
        CORS_ORIGIN: "*",
      },


      // ── Restart behaviour ────────────────────────────────────────────────────
      // pm2 tries to restart a crashed process automatically. These settings
      // prevent an infinite restart loop if the app crashes immediately
      // (e.g., because of a configuration error).

      // Maximum number of restart attempts before pm2 gives up and marks
      // the process as "errored". You'd then need to fix the config and
      // manually restart with `pm2 start cryovault`.
      max_restarts: 10,

      // Minimum uptime (in milliseconds) the process must run before a crash
      // is counted against max_restarts. If the process crashes within 1 second
      // of starting, it clearly has an immediate startup error.
      min_uptime: "1s",

      // How long pm2 waits before attempting a restart after a crash.
      // Exponential backoff would be better, but pm2 doesn't support it natively.
      // 3 seconds is a reasonable delay that avoids hammering a broken dependency.
      restart_delay: 3000,    // milliseconds


      // ── Graceful shutdown ────────────────────────────────────────────────────
      // When pm2 stops or reloads the app, it sends SIGINT to the process.
      // kill_timeout is how long pm2 waits for the process to clean up and
      // exit before sending the harder SIGKILL (which can't be caught).
      // 5 seconds is enough for Express to finish in-flight requests.
      kill_timeout: 5000,    // milliseconds

      // Signals:
      //   SIGINT  → graceful shutdown request (process can handle this)
      //   SIGKILL → forced termination (process cannot catch or ignore this)
      // The app can handle SIGINT to close database connections, flush logs, etc.
      // (We haven't implemented a SIGINT handler yet — a future improvement.)


      // ── Log management ────────────────────────────────────────────────────────
      // pm2 captures everything the app writes to stdout/stderr and saves it to files.

      // Where to write stdout (console.log) output
      out_file: "/var/log/cryovault/app-out.log",

      // Where to write stderr (console.error, uncaught exceptions) output
      error_file: "/var/log/cryovault/app-error.log",

      // Merge stdout and stderr into a single file (easier to read in sequence)
      // Set to false if you want separate files (easier to filter errors)
      merge_logs: false,

      // Add a timestamp prefix to each log line: [2024-06-01 14:30:00]
      // Useful when not using a structured logging library.
      time: true,

      // Log rotation settings (requires pm2-logrotate module)
      // Install: pm2 install pm2-logrotate
      // Then configure: pm2 set pm2-logrotate:max_size 50M
      //                 pm2 set pm2-logrotate:retain 7
      // This prevents log files from growing unboundedly and filling the disk.


      // ── File watching (DEVELOPMENT ONLY) ─────────────────────────────────────
      // In development, watch source files and auto-restart when they change.
      // NEVER enable this in production — it causes unnecessary restarts.
      watch: false,
      // watch: ["server.js", "routes/", "db.js"],  // ← enable in dev if wanted
      ignore_watch: ["node_modules", "*.db", "*.log", "backups"],


      // ── Health monitoring ─────────────────────────────────────────────────────
      // pm2 can monitor memory and CPU usage and restart the process if it
      // exceeds thresholds — useful for catching memory leaks.

      // Restart if memory usage exceeds 512MB.
      // Tune this based on your server's available RAM and actual usage.
      // Run `pm2 monit` to watch live memory/CPU usage.
      max_memory_restart: "512M",


      // ── Source map support ────────────────────────────────────────────────────
      // If you ever transpile TypeScript or use Babel, source maps let pm2
      // show original file/line numbers in crash reports instead of compiled code.
      // Not needed for plain JavaScript.
      source_map_support: false,
    }
  ],


  // ===========================================================================
  // DEPLOY CONFIGURATION (optional — for pm2's built-in deploy system)
  // ===========================================================================
  // pm2 has a built-in deployment system as an alternative to GitHub Actions.
  // Run: pm2 deploy production setup    ← clone repo on server (one-time)
  //      pm2 deploy production          ← pull latest code and restart
  //
  // This is simpler than GitHub Actions but less featured (no test step,
  // no image caching, no approval gates). Good for getting started quickly.
  // ===========================================================================
  deploy: {
    production: {
      // SSH connection to the production server
      user: "deploy",                    // SSH username on the server
      host: "your-server-ip-or-hostname",
      ref: "origin/main",               // Git branch to deploy

      // Where the repository is cloned on the server
      repo: "git@github.com:yourorg/cryovault.git",
      path: "/opt/cryovault",

      // Commands run ONCE after first clone (server setup)
      "post-setup": [
        "mkdir -p /opt/cryovault-data/backups",
        "mkdir -p /var/log/cryovault",
        "npm ci --omit=dev",
      ].join(" && "),

      // Commands run after EVERY deployment (update)
      "post-deploy": [
        "npm ci --omit=dev",
        "pm2 reload ecosystem.config.js --env production --update-env",
        "pm2 save",
      ].join(" && "),
    },

    // Staging environment (deploy to a separate server for pre-production testing)
    // Usage: pm2 deploy staging
    staging: {
      user: "deploy",
      host: "your-staging-server",
      ref: "origin/develop",            // Deploy from the develop branch
      repo: "git@github.com:yourorg/cryovault.git",
      path: "/opt/cryovault-staging",
      "post-deploy": [
        "npm ci --omit=dev",
        "pm2 reload ecosystem.config.js --env development --update-env",
      ].join(" && "),
    }
  }
};
