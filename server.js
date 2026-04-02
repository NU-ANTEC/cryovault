// =============================================================================
// server.js — Application Entry Point
// =============================================================================
//
// This is the first file Node.js executes when you run  `npm start`.
// It is responsible for:
//   1. Loading environment configuration
//   2. Creating the Express application and attaching middleware
//   3. Registering all API route handlers
//   4. Serving the static frontend files
//   5. Starting the HTTP server on the configured port
//
// WHAT IS EXPRESS?
//   Express is a minimal HTTP framework for Node.js. When a browser sends
//   a request to your server, Express reads the method (GET/POST/…) and
//   the URL path, finds the matching handler you registered, runs it, and
//   sends the response back. Without Express you'd have to parse raw HTTP
//   bytes yourself.
//
// REQUEST LIFECYCLE
//   browser → nginx (optional) → Node.js TCP socket → Express
//     → global middleware (CORS, JSON parser, logger)
//     → route middleware (the handler in routes/*.js)
//     → response sent back through the same chain
// =============================================================================

// dotenv reads the .env file and copies each KEY=VALUE line into process.env.
// MUST be called before any code that reads process.env.*, so it goes first.
// In production (Docker, pm2) the variables are injected by the runtime
// and dotenv simply does nothing — safe to call unconditionally.
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');

// Importing db.js here triggers the database setup (schema creation, seeding).
// We don't use the export directly in this file, but the side-effects of
// loading the module are what we want — the database must be initialised
// before any routes try to query it.
const { db } = require('./db');

// ── Create the Express application ───────────────────────────────────────────
const app = express();

// Read the port from the environment, falling back to 3000 for local dev.
const PORT = process.env.PORT || 3000;

// ── Read and validate CORS origin setting ────────────────────────────────────
// The raw value from .env might be "*" (allow all) or a comma-separated
// list of domains. We convert the list form into an array so the cors
// middleware can compare against each entry individually.
const rawCorsOrigin = process.env.CORS_ORIGIN || '*';
const corsOrigin = rawCorsOrigin === '*'
  ? '*'
  : rawCorsOrigin.split(',').map(s => s.trim());


// =============================================================================
// GLOBAL MIDDLEWARE
// =============================================================================
// Middleware functions run on EVERY request before it reaches a route handler.
// They are executed in the order they are registered with app.use().
// Each middleware either ends the request (by calling res.send/json/end) or
// calls next() to pass control to the next middleware in the chain.
// =============================================================================

// CORS middleware
// ---------------
// Adds the  Access-Control-Allow-Origin  header to every response so browsers
// allow cross-origin fetch() calls from the configured origins.
// The preflight handler automatically responds to OPTIONS requests
// (browsers send these before cross-origin POST/PUT/DELETE).
app.use(cors({
  origin:      corsOrigin,
  methods:     ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// JSON body parser
// ----------------
// Reads the request body, checks the Content-Type header, and if it is
// "application/json" it parses the text into a JavaScript object available
// as req.body. Without this, req.body would always be undefined.
// The limit protects against gigantic payloads (e.g., huge import files).
app.use(express.json({ limit: process.env.UPLOAD_MAX_SIZE || '50mb' }));

// Static file server
// ------------------
// Serves every file under the public/ directory directly over HTTP.
// A GET request to / returns public/index.html.
// A GET request to /some-image.png returns public/some-image.png.
// This is how the frontend HTML/CSS/JS is delivered to the browser.
app.use(express.static(path.join(__dirname, 'public')));

// Client-side library routes
// --------------------------
// Served from node_modules — works on air-gapped networks, no CDN needed.
//
// ZXing  — the only client-side scan engine (QR, Data Matrix, Code128, EAN…)
// qrcode — QR code image generator for displaying stored QR values
app.get('/zxing.min.js', (_req, res) => {
  const candidates = [
    path.join(__dirname, 'node_modules', '@zxing', 'library', 'umd', 'index.min.js'),
    path.join(__dirname, 'node_modules', '@zxing', 'library', 'umd', 'index.js'),
    path.join(__dirname, 'node_modules', '@zxing', 'library', 'cjs', 'index.js'),
  ];
  const fs   = require('fs');
  const found = candidates.find(f => fs.existsSync(f));
  if(found){
    res.set('Content-Type', 'application/javascript');
    res.sendFile(found);
  } else {
    res.status(404).send('// @zxing/library not found — run npm install');
  }
});

app.get('/qrcode.min.js', (_req, res) => {
  // qrcode npm package is Node.js only — QR images are generated server-side
  // at /api/qr?text=VALUE instead. Return an empty stub so the script tag
  // doesn't 404, but the browser library is no longer needed.
  res.set('Content-Type', 'application/javascript');
  res.send('// QR generation handled server-side at /api/qr');
});

// GET /api/qr?text=VALUE
// Generates a QR code PNG image from the given text, served inline.
// Used by showQRModal in the frontend — the <img> src points here.
// The qrcode npm package runs in Node.js (not the browser), so this
// is much more reliable than any browser-side QR library.
app.get('/api/qr', async (req, res) => {
  const text = (req.query.text || '').trim();
  if(!text) return res.status(400).json({ error: '"text" query param required' });
  try {
    const QRCode = require('qrcode');
    const png = await QRCode.toBuffer(text, {
      type:   'png',
      width:  200,
      margin: 2,
      color:  { dark: '#0d1a26', light: '#ffffff' }
    });
    res.set('Content-Type',  'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(png);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Simple request logger
// ----------------------
// Prints each incoming request to the console so you can watch traffic
// during development. In production you would replace this with a proper
// logging library (e.g., winston, pino) that writes structured JSON logs.
if (process.env.NODE_ENV !== 'test') {
  app.use((req, _res, next) => {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${req.method} ${req.url}`);
    next(); // MUST call next() or the request will hang forever
  });
}


// =============================================================================
// TANK ROUTES  (defined inline — they are simple enough not to need a file)
// =============================================================================

// GET /api/tanks — list all tanks ordered by name
app.get('/api/tanks', (_req, res) => {
  const tanks = db.prepare('SELECT * FROM tanks ORDER BY name').all();
  res.json(tanks);
});

// POST /api/tanks — create a new tank
app.post('/api/tanks', (req, res) => {
  const { name, notes = '', temperature = '-196 °C' } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: '"name" is required' });
  const { v4: uuidv4 } = require('uuid');
  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tanks(id,name,notes,temperature,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(id, name.trim(), notes, temperature, now, now);
  res.status(201).json(db.prepare('SELECT * FROM tanks WHERE id=?').get(id));
});

// PUT /api/tanks/:id — update tank properties
app.put('/api/tanks/:id', (req, res) => {
  const { name, notes, temperature } = req.body;
  const existing = db.prepare('SELECT * FROM tanks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Tank not found' });
  const now = new Date().toISOString();
  db.prepare(`UPDATE tanks SET name=?, notes=?, temperature=?, updated_at=? WHERE id=?`)
    .run(name ?? existing.name, notes ?? existing.notes, temperature ?? existing.temperature, now, req.params.id);
  res.json(db.prepare('SELECT * FROM tanks WHERE id=?').get(req.params.id));
});

// DELETE /api/tanks/:id — delete a tank (only if empty)
// We refuse deletion when racks exist to prevent accidental data loss.
// The user must remove all racks first (or the frontend can offer a force-delete).
app.delete('/api/tanks/:id', (req, res) => {
  const tank = db.prepare('SELECT * FROM tanks WHERE id=?').get(req.params.id);
  if (!tank) return res.status(404).json({ error: 'Tank not found' });
  const rackCount = db.prepare('SELECT COUNT(*) as c FROM racks WHERE tank_id=?').get(req.params.id).c;
  if (rackCount > 0) {
    return res.status(409).json({ error: `Cannot delete: tank still contains ${rackCount} rack(s). Remove all racks first.` });
  }
  db.prepare('DELETE FROM tanks WHERE id=?').run(req.params.id);
  res.json({ deleted: true, id: req.params.id });
});


// =============================================================================
// API ROUTE MODULES
// =============================================================================
// Each route file exports an Express Router — a mini-app that handles a
// subset of URLs. We "mount" each router under /api so all API endpoints
// live under that prefix.
//
// When a request comes in for e.g. GET /api/racks/xyz, Express:
//   1. Strips the /api prefix (because we mounted at '/api')
//   2. Passes /racks/xyz to the racks router
//   3. The racks router matches GET /racks/:id and calls the handler
// =============================================================================

app.use('/api', require('./routes/racks'));     // /api/tanks/:id/racks, /api/racks/:id
app.use('/api', require('./routes/boxes'));     // /api/racks/:id/boxes, /api/boxes/:id
app.use('/api', require('./routes/vials'));     // /api/boxes/:id/vials/:row/:col
app.use('/api', require('./routes/history'));   // /api/history
app.use('/api', require('./routes/transfer')); // /api/export, /api/import, /api/export/csv, /api/import/csv
app.use('/api', require('./routes/search'));   // /api/search
app.use('/api', require('./routes/archive'));  // /api/archive, /api/archive/restore, /api/archive/purge
app.use('/api', require('./routes/move'));     // /api/vials/move, /api/boxes/:id/move

// =============================================================================
// BACKUP ROUTES — must be before the SPA catch-all below
// =============================================================================
const backup = require('./backup');
const fs_backup = require('fs');

app.get('/api/backup/status', (_req, res) => {
  const st  = backup.getStatus();
  try {
    const files = fs_backup.readdirSync(st.backupDir)
      .filter(f => f.startsWith('cryovault-') && f.endsWith('.db.gz'))
      .map(f => {
        const stat = fs_backup.statSync(path.join(st.backupDir, f));
        return {
          name:    f,
          size:    stat.size < 1024*1024
            ? `${(stat.size/1024).toFixed(1)} KB`
            : `${(stat.size/1024/1024).toFixed(2)} MB`,
          created: stat.mtime.toISOString(),
        };
      })
      .sort((a,b) => b.created.localeCompare(a.created));
    res.json({ ...st, files });
  } catch(_) {
    res.json({ ...st, files: [] });
  }
});

app.post('/api/backup/run', async (_req, res) => {
  try {
    await backup.runBackup();
    res.json({ triggered: true, status: backup.getStatus() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// =============================================================================
// HEALTH CHECK ENDPOINT
// =============================================================================
// GET /api/health
// Returns a JSON object with server uptime and row counts from the database.
// This is used by:
//   - Docker health checks (see Dockerfile HEALTHCHECK instruction)
//   - Load balancers to know if this instance is ready to serve traffic
//   - Monitoring tools (Uptime Robot, Datadog, etc.)
//   - Your own quick sanity check:  curl http://localhost:3000/api/health
// =============================================================================
app.get('/api/health', (_req, res) => {
  const counts = {
    racks: db.prepare('SELECT COUNT(*) as c FROM racks').get().c,
    boxes: db.prepare('SELECT COUNT(*) as c FROM boxes').get().c,
    vials: db.prepare('SELECT COUNT(*) as c FROM vials').get().c,
    audit: db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c,
  };
  res.json({
    status:  'ok',
    uptime:  Math.floor(process.uptime()),  // seconds since server started
    node:    process.version,
    env:     process.env.NODE_ENV || 'development',
    db_path: process.env.DB_PATH || './cryovault.db',
    ...counts
  });
});


// =============================================================================
// SPA FALLBACK ROUTE
// =============================================================================
// This catch-all must be the LAST route registered.
//
// Why it's needed:
//   The frontend is a Single-Page Application (SPA). Navigation in the UI
//   changes the browser URL (e.g., /racks/abc123) using the History API,
//   but does NOT trigger a real page load. However, if the user bookmarks
//   that URL and opens it fresh, the browser asks the SERVER for /racks/abc123.
//   Without this fallback, Express would return a 404. With it, Express
//   returns index.html for any URL that doesn't match an API route, and
//   the frontend JS reads the URL and renders the correct view.
//
// The order matters: this runs AFTER all /api/* routes, so API 404s are
// still proper JSON 404s, not HTML pages.
// =============================================================================
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// =============================================================================
// GLOBAL ERROR HANDLER
// =============================================================================
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[error]', err.stack || err.message);
  const isDev = process.env.NODE_ENV !== 'production';
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(isDev ? { stack: err.stack } : {})
  });
});


// =============================================================================
// START THE SERVER
// =============================================================================
app.listen(PORT, () => {
  console.log('\n  🧊 CryoVault is running');
  console.log(`     Environment : ${process.env.NODE_ENV || 'development'}`);
  console.log(`     Local URL   : http://localhost:${PORT}`);
  console.log(`     API health  : http://localhost:${PORT}/api/health`);
  console.log(`     Database    : ${process.env.DB_PATH || './cryovault.db'}\n`);
  backup.start();
});
