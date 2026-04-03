// =============================================================================
// db.js — Database Initialization and Helpers
// =============================================================================
//
// CHANGE LOG (slot_position feature)
// ------------------------------------
// racks table  → added  capacity INTEGER NOT NULL DEFAULT 10
//   The total number of physical box slots in the rack.
//   Set at rack creation; can be updated later (reducing it is only allowed
//   when no boxes occupy the newly-out-of-range slots — enforced in the route).
//
// boxes table  → added  slot_position INTEGER NOT NULL DEFAULT 1
//   The physical position of this box in its rack, counted from the top.
//   slot_position = 1  →  topmost slot
//   slot_position = N  →  Nth slot from the top  (N must be ≤ rack.capacity)
//   UNIQUE(rack_id, slot_position) is enforced at the database level so no
//   two boxes can share a slot even if the application layer has a bug.
//
// MIGRATION STRATEGY FOR EXISTING DATABASES
//   SQLite does not support "ADD COLUMN IF NOT EXISTS" on versions < 3.37,
//   so we wrap each ALTER TABLE in a helper (tryAlter) that silently swallows
//   the "duplicate column name" error on subsequent startups, but re-throws
//   any other error so real problems are still surfaced.
//
//   When slot_position is freshly added with DEFAULT 1, any rack that already
//   had multiple boxes will now have all of them at position 1, violating the
//   uniqueness intent. The fixDuplicateSlotPositions() function detects and
//   repairs this by reassigning sequential positions ordered by created_at.
//   Operators should review and correct positions through the UI afterwards.
// =============================================================================

require('dotenv').config();

const Database = require('better-sqlite3');
const path     = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'cryovault.db');
const db      = new Database(DB_PATH);

console.log(`[db] Connected to ${DB_PATH}`);

if (process.env.DB_WAL_MODE !== 'false') {
  db.pragma('journal_mode = WAL');
}

// busy_timeout: if the database is locked by a write, wait up to 5 seconds
// before returning SQLITE_BUSY. Without this, concurrent requests fail
// immediately with "database is locked".
db.pragma('busy_timeout = 5000');

// Recommended WAL settings for reliability
db.pragma('synchronous = NORMAL');  // safe with WAL, faster than FULL
db.pragma('foreign_keys = ON');


// =============================================================================
// SCHEMA DEFINITION
// =============================================================================
db.exec(`

  -- ── TANKS ────────────────────────────────────────────────────────────────
  -- Represents the physical LN₂ storage tank.
  CREATE TABLE IF NOT EXISTS tanks (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    notes       TEXT DEFAULT '',
    temperature TEXT DEFAULT '-196 °C',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  -- ── RACKS ─────────────────────────────────────────────────────────────────
  -- A rack is a physical holder that sits inside the tank.
  --
  -- capacity   INTEGER NOT NULL
  --   The total number of box slots this rack can hold.
  --   Valid slot_position values for boxes in this rack: 1 … capacity.
  --   Minimum value: 1. There is no maximum enforced by the schema —
  --   the route layer caps it at a reasonable limit (e.g. 100).
  --
  -- position   TEXT
  --   Free-text descriptor of where this rack sits inside the tank,
  --   e.g. "Slot A", "Left column front". This is a human label, NOT
  --   the integer slot numbering — those are on boxes, not racks.
  CREATE TABLE IF NOT EXISTS racks (
    id         TEXT PRIMARY KEY,
    tank_id    TEXT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   TEXT DEFAULT '',
    capacity   INTEGER NOT NULL DEFAULT 10,
    notes      TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- ── BOXES ─────────────────────────────────────────────────────────────────
  -- A storage box occupying one physical slot in a rack.
  --
  -- slot_position   INTEGER NOT NULL
  --   1-based integer identifying the physical slot from the top of the rack.
  --   Constraints (all checked by the route before INSERT/UPDATE):
  --     • slot_position ≥ 1
  --     • slot_position ≤ parent rack's capacity
  --     • No other box in the same rack has this slot_position
  --   The third constraint is also enforced at the database level by the
  --   UNIQUE(rack_id, slot_position) constraint below.
  --
  -- rows / cols   INTEGER NOT NULL
  --   Grid dimensions of the box (rows labeled A–Z, cols labeled 01–30).
  --   Vials are stored sparsely — only occupied grid cells have rows in
  --   the vials table.
  CREATE TABLE IF NOT EXISTS boxes (
    id            TEXT PRIMARY KEY,
    rack_id       TEXT NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    slot_position INTEGER NOT NULL DEFAULT 1,
    rows          INTEGER NOT NULL,
    cols          INTEGER NOT NULL,
    qr_code       TEXT DEFAULT NULL,
    notes         TEXT DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    -- Database-level uniqueness guard for physical slot occupancy.
    -- The route layer checks first and returns a helpful error message;
    -- this constraint is the last line of defence against race conditions.
    UNIQUE(rack_id, slot_position)
  );

  -- ── VIALS ─────────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS vials (
    id            TEXT PRIMARY KEY,
    box_id        TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
    row_index     INTEGER NOT NULL,
    col_index     INTEGER NOT NULL,
    name          TEXT NOT NULL,
    sample_type   TEXT DEFAULT '',
    date_stored   TEXT DEFAULT '',
    volume        TEXT DEFAULT '',
    concentration TEXT DEFAULT '',
    researcher    TEXT DEFAULT '',
    qr_code       TEXT DEFAULT NULL,
    notes         TEXT DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE(box_id, row_index, col_index)
  );

  -- ── AUDIT LOG ──────────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    entity_name TEXT NOT NULL,
    action      TEXT NOT NULL,
    changed_by  TEXT DEFAULT 'system',
    old_data    TEXT DEFAULT NULL,
    new_data    TEXT DEFAULT NULL,
    context     TEXT DEFAULT NULL
  );

  -- ── INDEXES ────────────────────────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_audit_entity    ON audit_log(entity_type, entity_id);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_vials_box       ON vials(box_id, row_index, col_index);
  -- Covering index on (rack_id, slot_position): used when the rack view
  -- queries "which slots in rack X are occupied, and what boxes are there?"
  CREATE INDEX IF NOT EXISTS idx_boxes_rack_slot ON boxes(rack_id, slot_position);
  CREATE INDEX IF NOT EXISTS idx_racks_tank      ON racks(tank_id);

`);


// =============================================================================
// MIGRATIONS — add new columns to pre-existing databases
// =============================================================================
// tryAlter() attempts an ALTER TABLE statement and silently ignores the
// specific SQLite error for "column already exists". Any other error is
// re-thrown so it surfaces in the startup log.
// =============================================================================
function tryAlter(sql, description) {
  try {
    db.exec(sql);
    console.log(`[db] Migration applied: ${description}`);
  } catch (err) {
    if (err.message.includes('duplicate column name')) {
      // Column already exists — expected on every startup after the first migration.
    } else {
      console.error(`[db] Migration failed (${description}):`, err.message);
      throw err;
    }
  }
}

tryAlter(
  `ALTER TABLE racks ADD COLUMN capacity INTEGER NOT NULL DEFAULT 10`,
  'racks.capacity (default 10)'
);

tryAlter(
  `ALTER TABLE boxes ADD COLUMN slot_position INTEGER NOT NULL DEFAULT 1`,
  'boxes.slot_position (default 1)'
);

// archived_at: ISO timestamp set when an item is soft-deleted (archived).
// NULL means the item is active. Non-null means it is archived.
// All normal queries filter WHERE archived_at IS NULL.
// Archive routes filter WHERE archived_at IS NOT NULL.
tryAlter(
  `ALTER TABLE racks ADD COLUMN archived_at TEXT DEFAULT NULL`,
  'racks.archived_at'
);
tryAlter(
  `ALTER TABLE boxes ADD COLUMN archived_at TEXT DEFAULT NULL`,
  'boxes.archived_at'
);
tryAlter(
  `ALTER TABLE vials ADD COLUMN archived_at TEXT DEFAULT NULL`,
  'vials.archived_at'
);
tryAlter(
  `ALTER TABLE vials ADD COLUMN passage TEXT DEFAULT NULL`,
  'vials.passage'
);

// =============================================================================
// MIGRATION: repair duplicate slot_positions introduced by the DEFAULT 1 above
// =============================================================================
// When slot_position is added with DEFAULT 1, every existing box in every rack
// gets position 1. If a rack had more than one box, they're now all at 1.
// This function detects such racks and assigns consecutive positions (1, 2, 3…)
// ordered by created_at (oldest box keeps the lowest slot number).
//
// This repair runs every startup but is effectively a no-op once positions
// are unique, because the SELECT returns zero rows.
// =============================================================================
(function repairDuplicateSlotPositions() {
  const dupRacks = db.prepare(`
    SELECT DISTINCT rack_id
    FROM   boxes
    GROUP  BY rack_id, slot_position
    HAVING COUNT(*) > 1
  `).all();

  if (dupRacks.length === 0) return;

  console.log(`[db] Repairing slot_position conflicts in ${dupRacks.length} rack(s)...`);

  db.transaction(() => {
    for (const { rack_id } of dupRacks) {
      const boxes = db.prepare(`
        SELECT id FROM boxes WHERE rack_id = ? ORDER BY created_at ASC
      `).all(rack_id);

      boxes.forEach(({ id }, i) => {
        db.prepare(`UPDATE boxes SET slot_position = ? WHERE id = ?`).run(i + 1, id);
      });

      console.log(`[db]   Rack ${rack_id}: assigned positions 1–${boxes.length} (review in UI)`);
    }
  })();
})();


// =============================================================================
// SEED: Default Tank (only on first run)
// =============================================================================
const tankCount = db.prepare('SELECT COUNT(*) as c FROM tanks').get().c;
if (tankCount === 0) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tanks(id, name, notes, created_at, updated_at) VALUES(?, ?, ?, ?, ?)`
  ).run(uuidv4(), 'LN2-ALPHA', 'Primary liquid nitrogen storage tank', now, now);
  console.log('[db] First run — default tank "LN2-ALPHA" created.');
}


// =============================================================================
// AUDIT LOGGER HELPER
// =============================================================================
function logAudit({
  entityType, entityId, entityName, action,
  changedBy = 'system', oldData = null, newData = null, context = null
}) {
  db.prepare(`
    INSERT INTO audit_log
      (timestamp, entity_type, entity_id, entity_name, action, changed_by, old_data, new_data, context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    new Date().toISOString(),
    entityType, entityId, entityName || '', action, changedBy,
    oldData  ? JSON.stringify(oldData)  : null,
    newData  ? JSON.stringify(newData)  : null,
    context  ? JSON.stringify(context)  : null
  );
}

module.exports = { db, logAudit };
