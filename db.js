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
// TABLE DEFINITIONS FOR boxes AND vials
// =============================================================================
// These two tables are defined once here and used twice: by the CREATE TABLE
// for fresh databases, and by the one-time rebuild migration further down
// (migrateToActiveOnlyUniqueness) for databases created by older versions.
// Keeping one definition means a migrated database ends up with exactly the
// same schema as a brand-new one.
//
// They list every column, including ones older versions added later with
// ALTER TABLE (archived_at, passage). On an existing database the matching
// tryAlter() calls below are then harmless no-ops.
// =============================================================================
function BOXES_TABLE_SQL(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
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
    archived_at   TEXT DEFAULT NULL
  );`;
}

function VIALS_TABLE_SQL(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
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
    archived_at   TEXT DEFAULT NULL,
    passage       TEXT DEFAULT NULL
  );`;
}


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
  --   The third constraint is also enforced at the database level, for
  --   active boxes only, by the ux_boxes_active_slot partial unique index.
  --
  -- rows / cols   INTEGER NOT NULL
  --   Grid dimensions of the box (rows labeled A–Z, cols labeled 01–30).
  --   Vials are stored sparsely — only occupied grid cells have rows in
  --   the vials table.
  --
  -- Slot uniqueness is NOT a table constraint: it is the partial unique
  -- index ux_boxes_active_slot (created further down), which only counts
  -- active boxes. An archived box keeps its slot_position for the record
  -- but no longer blocks a new box from using that slot.
  ${BOXES_TABLE_SQL('boxes')}

  -- ── VIALS ─────────────────────────────────────────────────────────────────
  -- Position uniqueness is the partial unique index ux_vials_active_position
  -- (created further down): at most one ACTIVE vial per (box, row, col).
  -- Archived vials keep their position for the record and stay searchable,
  -- while a new vial can be placed in the same cell.
  ${VIALS_TABLE_SQL('vials')}

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
//
// Only ACTIVE boxes are considered. An archived box legitimately keeps the
// slot number it had, even if a newer box now sits in that slot, so it must
// never trigger (or take part in) a renumbering.
// =============================================================================
function repairDuplicateSlotPositions() {
  const dupRacks = db.prepare(`
    SELECT DISTINCT rack_id
    FROM   boxes
    WHERE  archived_at IS NULL
    GROUP  BY rack_id, slot_position
    HAVING COUNT(*) > 1
  `).all();

  if (dupRacks.length === 0) return;

  console.log(`[db] Repairing slot_position conflicts in ${dupRacks.length} rack(s)...`);

  db.transaction(() => {
    for (const { rack_id } of dupRacks) {
      const boxes = db.prepare(`
        SELECT id FROM boxes
        WHERE  rack_id = ? AND archived_at IS NULL
        ORDER  BY created_at ASC
      `).all(rack_id);

      boxes.forEach(({ id }, i) => {
        db.prepare(`UPDATE boxes SET slot_position = ? WHERE id = ?`).run(i + 1, id);
      });

      console.log(`[db]   Rack ${rack_id}: assigned positions 1–${boxes.length} (review in UI)`);
    }
  })();
}


// =============================================================================
// MIGRATION: one ACTIVE vial per position / one ACTIVE box per slot
// =============================================================================
// Older versions declared
//     vials:  UNIQUE(box_id, row_index, col_index)
//     boxes:  UNIQUE(rack_id, slot_position)
// as table constraints. Archived (soft-deleted) rows stay in the table, so an
// archived vial or box kept "owning" its cell or slot forever: the UI showed
// the place as empty, but nothing new could be put there.
//
// The rule we actually want is "at most one ACTIVE item per place", which is
// a partial unique index (... WHERE archived_at IS NULL). SQLite cannot drop
// a table constraint in place, so each affected table is rebuilt once using
// SQLite's documented procedure (https://www.sqlite.org/lang_altertable.html,
// "Making Other Kinds Of Table Schema Changes"):
//
//   1. Take a full snapshot of the database file (VACUUM INTO) next to it.
//   2. Turn foreign keys off, so dropping the old table does not cascade-
//      delete the vials that belong to its boxes.
//   3. In ONE transaction: create the new table, copy every row, drop the
//      old table, rename the new one into place, verify row counts and
//      foreign keys. Any error rolls the whole thing back, leaving the
//      database exactly as it was.
//   4. Turn foreign keys back on.
//
// On every later startup the old constraint is gone, so this is a no-op.
// =============================================================================
function hasLegacyUniqueConstraint(table, columns) {
  // PRAGMA index_list reports the automatic index SQLite creates for a table
  // constraint with origin = 'u'. Partial indexes we create have origin 'c'.
  return db.prepare(`PRAGMA index_list(${table})`).all().some(ix => {
    if (ix.origin !== 'u' || !ix.unique) return false;
    const cols = db.prepare(`PRAGMA index_info(${ix.name})`).all().map(c => c.name);
    return cols.length === columns.length && cols.every((c, i) => c === columns[i]);
  });
}

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

function rebuildTable(table, createSql) {
  const tmp = `${table}__rebuild`;
  db.exec(`DROP TABLE IF EXISTS ${tmp}`);
  db.exec(createSql(tmp));

  const oldCols = tableColumns(table);
  const newCols = new Set(tableColumns(tmp));
  const lost    = oldCols.filter(c => !newCols.has(c));
  if (lost.length) {
    // Never silently drop data: refuse if the old table has a column the
    // new definition doesn't know about.
    throw new Error(`${table} has column(s) not in the new schema: ${lost.join(', ')}`);
  }

  // Indexes and triggers on the old table (including any added by hand) are
  // dropped along with it; remember their definitions to recreate them.
  // Automatic indexes (the old UNIQUE constraint itself) have no SQL.
  const attached = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE  tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
  `).all(table).map(r => r.sql);

  const colList = oldCols.join(', ');
  const before  = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  db.exec(`INSERT INTO ${tmp} (${colList}) SELECT ${colList} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  for (const sql of attached) db.exec(sql);
  const after = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;

  if (after !== before) {
    throw new Error(`${table}: row count changed during rebuild (${before} → ${after})`);
  }
  return after;
}

function migrateToActiveOnlyUniqueness() {
  const needBoxes = hasLegacyUniqueConstraint('boxes', ['rack_id', 'slot_position']);
  const needVials = hasLegacyUniqueConstraint('vials', ['box_id', 'row_index', 'col_index']);
  if (!needBoxes && !needVials) return;

  console.log('[db] Migration: switching to "one active vial per position / one active box per slot"...');

  // ── 1. Snapshot ────────────────────────────────────────────────────────────
  // Skipped for in-memory databases (tests), which have no file to copy.
  if (DB_PATH !== ':memory:') {
    const stamp    = new Date().toISOString().replace(/[:.]/g, '-');
    const snapshot = `${DB_PATH}.pre-active-unique-${stamp}.bak`;
    db.prepare('VACUUM INTO ?').run(snapshot);
    console.log(`[db]   Snapshot of the unmigrated database saved to ${snapshot}`);

    // If the migration keeps failing, Docker keeps restarting the app and
    // each start would add another snapshot. A failed migration leaves the
    // database unchanged, so the newest few snapshots are all the same data:
    // keep the 3 most recent and remove older ones from earlier attempts.
    // Only snapshots from the last hour are pruned, so one kept from an
    // earlier, separate upgrade attempt is never removed.
    const dir    = path.dirname(DB_PATH);
    const prefix = `${path.basename(DB_PATH)}.pre-active-unique-`;
    const fs     = require('fs');
    const hourAgo = Date.now() - 60 * 60 * 1000;
    fs.readdirSync(dir)
      .filter(f => f.startsWith(prefix) && f.endsWith('.bak'))
      .filter(f => fs.statSync(path.join(dir, f)).mtimeMs > hourAgo)
      .sort()                       // ISO timestamps sort chronologically
      .slice(0, -3)
      .forEach(f => fs.unlinkSync(path.join(dir, f)));
  }

  // ── 2–4. Rebuild with foreign keys off ───────────────────────────────────
  // PRAGMA foreign_keys has no effect inside a transaction, so it is set
  // outside it, and always restored in the finally block.
  // Rows that already point at a missing parent (only possible if someone
  // edited the file with foreign keys off) are not this migration's doing.
  // It must not create new ones, but it should not refuse to run because of
  // old ones either — that would stop the app from starting at all.
  // Keyed by the row's id, not its rowid: the rebuild renumbers rowids.
  const fkKey = r => {
    const row = db.prepare(`SELECT id FROM ${r.table} WHERE rowid = ?`).get(r.rowid);
    return `${r.table}:${row ? row.id : r.rowid}:${r.parent}`;
  };
  const fkBefore = new Set(db.pragma('foreign_key_check').map(fkKey));
  if (fkBefore.size) {
    console.warn(`[db]   Note: ${fkBefore.size} row(s) already point at a missing parent (left as they are)`);
  }

  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      if (needBoxes) {
        const n = rebuildTable('boxes', BOXES_TABLE_SQL);
        console.log(`[db]   boxes rebuilt (${n} rows copied)`);
      }
      if (needVials) {
        const n = rebuildTable('vials', VIALS_TABLE_SQL);
        console.log(`[db]   vials rebuilt (${n} rows copied)`);
      }

      // Dropping a table drops its indexes; recreate the ordinary ones.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_vials_box       ON vials(box_id, row_index, col_index);
        CREATE INDEX IF NOT EXISTS idx_boxes_rack_slot ON boxes(rack_id, slot_position);
      `);

      const fkProblems = db.prepare('PRAGMA foreign_key_check').all().filter(r => !fkBefore.has(fkKey(r)));
      if (fkProblems.length) {
        throw new Error(`foreign key check failed after rebuild: ${JSON.stringify(fkProblems.slice(0, 5))}`);
      }
    })();
  } catch (err) {
    console.error('[db] Migration FAILED and was rolled back — the database is unchanged:', err.message);
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }

  console.log('[db] Migration complete.');
}

migrateToActiveOnlyUniqueness();
repairDuplicateSlotPositions();

// The uniqueness rules themselves. Created after the migration and the slot
// repair so they can never fail on data those steps are about to fix.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS ux_vials_active_position
    ON vials(box_id, row_index, col_index) WHERE archived_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS ux_boxes_active_slot
    ON boxes(rack_id, slot_position) WHERE archived_at IS NULL;
`);


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
