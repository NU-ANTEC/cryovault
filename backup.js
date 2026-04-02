// =============================================================================
// backup.js — Automatic Database Backup Scheduler
// =============================================================================
//
// OVERVIEW
//   This module is required once by server.js at startup. If BACKUP_ENABLED
//   is true, it schedules a recurring backup using node-cron. Each backup:
//     1. Uses the sqlite3 CLI's `.backup` command for a hot, consistent copy
//        (safe to run while the server is actively writing to the database)
//     2. Compresses the copy with gzip
//     3. Verifies the compressed file is valid
//     4. Deletes backup files older than BACKUP_KEEP_DAYS
//
// HOST-SIDE PERSISTENCE
//   The BACKUP_DIR inside the container (/backups by default) is bind-mounted
//   to ./backups on the host machine via docker-compose.yml. This means:
//     - Backup files are ordinary files on your host filesystem
//     - They survive container deletion, image rebuilds, and Docker volume loss
//     - You can copy them off-server with scp, rsync, or any file tool
//
// CONFIGURATION (all via environment variables / .env)
//   BACKUP_ENABLED   "true" to activate the scheduler (default: false)
//   BACKUP_DIR       where to write backup files (default: /backups)
//   BACKUP_SCHEDULE  cron expression (default: "0 2 * * *" = 2am daily)
//   BACKUP_KEEP_DAYS delete backups older than N days (default: 30)
//   DB_PATH          path to the SQLite database (shared with server.js)
//
// STATUS TRACKING
//   The module exports a `getStatus()` function that server.js exposes at
//   GET /api/backup/status so the UI can show the last backup time and result.
// =============================================================================

const fs          = require('fs');
const path        = require('path');
const { exec }    = require('child_process');
const { promisify } = require('util');
const execAsync   = promisify(exec);

// ── Read configuration ────────────────────────────────────────────────────────
const ENABLED      = process.env.BACKUP_ENABLED === 'true';
const DB_PATH      = process.env.DB_PATH      || path.join(__dirname, 'cryovault.db');
const BACKUP_DIR   = process.env.BACKUP_DIR   || path.join(__dirname, 'backups');
const SCHEDULE     = process.env.BACKUP_SCHEDULE  || '0 2 * * *';
const KEEP_DAYS    = parseInt(process.env.BACKUP_KEEP_DAYS || '30', 10);

// ── Status object — updated after every backup attempt ───────────────────────
const status = {
  enabled:     ENABLED,
  schedule:    SCHEDULE,
  backupDir:   BACKUP_DIR,
  keepDays:    KEEP_DAYS,
  lastRun:     null,   // ISO timestamp of last attempt
  lastResult:  null,   // 'success' | 'error'
  lastFile:    null,   // filename of last successful backup
  lastSize:    null,   // human-readable size of last backup
  lastError:   null,   // error message if last attempt failed
  nextRun:     null,   // ISO timestamp of next scheduled run (approximate)
  totalBackups: 0,     // count of backup files currently in BACKUP_DIR
};

// ── Core backup function ──────────────────────────────────────────────────────
async function runBackup() {
  const now       = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tmpFile   = path.join(BACKUP_DIR, `.backup_tmp_${timestamp}.db`);
  const outFile   = path.join(BACKUP_DIR, `cryovault-${timestamp}.db.gz`);

  console.log(`[backup] Starting backup → ${outFile}`);
  status.lastRun = now.toISOString();

  // ── Ensure the backup directory exists ─────────────────────────────────────
  // If the bind-mount wasn't created before docker compose up, mkdir -p
  // creates it inside the container (but then it won't be on the host).
  // The README instructs the operator to run `mkdir -p backups` first.
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  } catch(e) {
    // Directory already exists — fine
  }

  try {
    // ── Check database file exists ──────────────────────────────────────────
    if (!fs.existsSync(DB_PATH)) {
      throw new Error(`Database file not found at ${DB_PATH}`);
    }

    // ── Hot backup using sqlite3 CLI ────────────────────────────────────────
    // The .backup command uses SQLite's C-level incremental backup API.
    // It is safe to run while the server is writing — it creates a fully
    // consistent snapshot by reading pages in a loop until they stabilise.
    //
    // We use sqlite3 rather than a file copy because:
    //   - A raw `cp` of a WAL-mode database during active writes can produce
    //     a corrupt backup (the WAL file may not be checkpointed)
    //   - sqlite3 .backup handles WAL mode correctly by design
    await execAsync(`sqlite3 "${DB_PATH}" ".backup '${tmpFile}'"`);

    // ── Compress ─────────────────────────────────────────────────────────────
    // Pipe through gzip -9 (maximum compression). SQLite databases compress
    // very well — a 10 MB database typically becomes 1–2 MB after gzip.
    await execAsync(`gzip -9 -c "${tmpFile}" > "${outFile}"`);
    fs.unlinkSync(tmpFile);

    // ── Verify the gzip file is valid ────────────────────────────────────────
    await execAsync(`gzip -t "${outFile}"`);

    // ── Record success ────────────────────────────────────────────────────────
    const stat    = fs.statSync(outFile);
    const sizeMB  = (stat.size / 1024 / 1024).toFixed(2);
    const sizeStr = stat.size < 1024 * 1024
      ? `${(stat.size / 1024).toFixed(1)} KB`
      : `${sizeMB} MB`;

    status.lastResult = 'success';
    status.lastFile   = path.basename(outFile);
    status.lastSize   = sizeStr;
    status.lastError  = null;

    console.log(`[backup] ✓ Complete: ${path.basename(outFile)} (${sizeStr})`);

  } catch(err) {
    // Clean up temp files if left behind
    try { fs.unlinkSync(tmpFile); } catch(_) {}
    try { fs.unlinkSync(outFile); } catch(_) {}

    status.lastResult = 'error';
    status.lastError  = err.message;
    console.error(`[backup] ✗ Failed: ${err.message}`);
    return;
  }

  // ── Prune old backups ──────────────────────────────────────────────────────
  if(KEEP_DAYS > 0) {
    try {
      const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
      const files  = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('cryovault-') && f.endsWith('.db.gz'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
        .filter(f => f.mtime < cutoff);

      for(const f of files) {
        fs.unlinkSync(path.join(BACKUP_DIR, f.name));
        console.log(`[backup] Pruned old backup: ${f.name}`);
      }
      if(files.length) console.log(`[backup] Pruned ${files.length} backup(s) older than ${KEEP_DAYS} days`);
    } catch(err) {
      console.warn(`[backup] Prune warning: ${err.message}`);
    }
  }

  // ── Update total backup count ──────────────────────────────────────────────
  try {
    status.totalBackups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('cryovault-') && f.endsWith('.db.gz')).length;
  } catch(_) {}
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
function start() {
  if(!ENABLED) {
    console.log('[backup] Scheduler disabled (BACKUP_ENABLED=false). Set to true in .env to activate.');
    return;
  }

  // Validate cron expression before trying to schedule
  let cron;
  try {
    cron = require('node-cron');
    if(!cron.validate(SCHEDULE)) {
      console.error(`[backup] Invalid cron expression: "${SCHEDULE}". Backup scheduler not started.`);
      return;
    }
  } catch(e) {
    console.error('[backup] node-cron not installed — run npm install');
    return;
  }

  // Ensure backup directory exists (or warn if the bind-mount is missing)
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    console.log(`[backup] Backup directory: ${BACKUP_DIR}`);
  } catch(e) {
    console.warn(`[backup] Cannot create backup directory ${BACKUP_DIR}: ${e.message}`);
  }

  // Check sqlite3 CLI is available (required for hot backup)
  exec('sqlite3 --version', (err) => {
    if(err) {
      console.error('[backup] sqlite3 CLI not found — install it (apt install sqlite3). Backup scheduler not started.');
      return;
    }

    // Schedule the backup
    const task = cron.schedule(SCHEDULE, () => {
      runBackup().catch(e => console.error('[backup] Unhandled error:', e));
    }, { timezone: 'UTC' });

    // Calculate approximate next run for the status endpoint
    // node-cron doesn't expose the next fire time directly, so we just
    // store the schedule string and let the UI display it descriptively.
    status.nextRun = SCHEDULE;

    console.log(`[backup] Scheduler active. Schedule: "${SCHEDULE}" (UTC). Backups → ${BACKUP_DIR}`);

    // Run an immediate backup on startup if the backup directory is empty —
    // gives the operator confidence that backups actually work before
    // waiting for the first scheduled run.
    try {
      const existing = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('cryovault-') && f.endsWith('.db.gz'));
      if(existing.length === 0) {
        console.log('[backup] No existing backups found — running initial backup now...');
        runBackup().catch(e => console.error('[backup] Initial backup failed:', e));
      } else {
        status.totalBackups = existing.length;
        console.log(`[backup] ${existing.length} existing backup(s) found in ${BACKUP_DIR}`);
      }
    } catch(_) {}
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  start,
  runBackup,
  getStatus: () => ({ ...status }),
};
