// =============================================================================
// lib/dbtools.js — Snapshot, backup and verification tools for the database
// =============================================================================
//
// Used two ways:
//
//   1. As a library by the app:   routes/transfer.js → buildSnapshot()
//      for GET /api/export.
//
//   2. As a command-line tool by deploy/scripts/upgrade.sh, which runs it in
//      a throwaway container against the live database file:
//
//        node lib/dbtools.js counts        [db]   one-line inventory counts
//        node lib/dbtools.js audit-count   [db]   number of history entries
//        node lib/dbtools.js schema        [db]   which uniqueness rules are in force
//        node lib/dbtools.js check         [db]   integrity check + counts (exit 1 if damaged)
//        node lib/dbtools.js backup  <dest> [db]  consistent copy of the database file
//        node lib/dbtools.js export        [db]   JSON snapshot (importable) to stdout
//        node lib/dbtools.js history       [db]   full change history as JSON to stdout
//        node lib/dbtools.js verify-export  <file>  counts computed from a JSON snapshot
//        node lib/dbtools.js verify-history <file>  entry count of a history JSON
//        node lib/dbtools.js report        [db]   records affected by the archived-position bug
//
//      [db] defaults to $DB_PATH. Every command opens the database READ-ONLY
//      and never runs the app's migrations, so it is safe to point at a
//      database created by an older version, before upgrading it.
//
// This file depends only on better-sqlite3 — not on db.js — for that reason.
// =============================================================================

'use strict';

const fs = require('fs');

const EXPORT_FORMAT = 'cryovault-export';
const EXPORT_FORMAT_VERSION = '2.0';


// ── Helpers ──────────────────────────────────────────────────────────────────

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// COUNT(*) of a table, plus how many of its rows are archived (0 if the
// database predates archiving).
function countWithArchived(db, table) {
  const total    = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  const archived = hasColumn(db, table, 'archived_at')
    ? db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE archived_at IS NOT NULL`).get().c
    : 0;
  return { total, archived };
}


// =============================================================================
// counts(db) — inventory counts straight from the database
// =============================================================================
function counts(db) {
  const racks = countWithArchived(db, 'racks');
  const boxes = countWithArchived(db, 'boxes');
  const vials = countWithArchived(db, 'vials');
  return {
    tanks:          db.prepare('SELECT COUNT(*) AS c FROM tanks').get().c,
    racks:          racks.total,
    boxes:          boxes.total,
    vials:          vials.total,
    archived_racks: racks.archived,
    archived_boxes: boxes.archived,
    archived_vials: vials.archived,
  };
}

// The one-line form the upgrade script compares before and after.
// Same keys, same order, every time.
function formatCounts(c) {
  return ['tanks', 'racks', 'boxes', 'vials', 'archived_racks', 'archived_boxes', 'archived_vials']
    .map(k => `${k}=${c[k]}`).join(' ');
}


// =============================================================================
// buildSnapshot(db) — the full inventory as one JSON-ready object
// =============================================================================
// Format 2.0: every tank, with its racks → boxes → vials nested inside, and
// every column of every row — including archived items (archived_at set),
// box slot positions, rack capacities and vial passage numbers — so that an
// import in "replace" mode reproduces the database exactly.
//
// (Format 1.0, written by older versions, held only the first tank and is
// still accepted by POST /api/import.)
//
// All reads happen inside one transaction, so the snapshot is consistent
// even if the app is writing at the same time.
// =============================================================================
function buildSnapshot(db) {
  return db.transaction(() => {
    const tanks = db.prepare('SELECT * FROM tanks ORDER BY name, id').all();
    const racksOf = db.prepare('SELECT * FROM racks WHERE tank_id = ? ORDER BY name, id');
    const boxesOf = db.prepare(`SELECT * FROM boxes WHERE rack_id = ? ORDER BY ${
      hasColumn(db, 'boxes', 'slot_position') ? 'slot_position, ' : ''}name, id`);
    const vialsOf = db.prepare('SELECT * FROM vials WHERE box_id = ? ORDER BY row_index, col_index, created_at, id');

    const snapshot = {
      _meta: {
        format:      EXPORT_FORMAT,
        version:     EXPORT_FORMAT_VERSION,
        exported_at: new Date().toISOString(),
        // Kept for anyone reading the file by eye; import doesn't need it.
        source_tank: tanks[0] ? tanks[0].name : null,
        counts:      counts(db),
      },
      tanks: tanks.map(tank => ({
        ...tank,
        racks: racksOf.all(tank.id).map(rack => ({
          ...rack,
          boxes: boxesOf.all(rack.id).map(box => ({
            ...box,
            vials: vialsOf.all(box.id),
          })),
        })),
      })),
    };
    return snapshot;
  })();
}

// Counts computed from a snapshot object (any format version), for checking
// that a JSON file really contains what the database contained.
function countsFromSnapshot(data) {
  if (!data || !data._meta || data._meta.format !== EXPORT_FORMAT) {
    throw new Error('not a CryoVault export (missing _meta.format)');
  }
  const tanks = Array.isArray(data.tanks)
    ? data.tanks
    : [{ ...(data.tank || {}), racks: data.racks || [] }];   // format 1.0

  const c = { tanks: tanks.length, racks: 0, boxes: 0, vials: 0,
              archived_racks: 0, archived_boxes: 0, archived_vials: 0 };
  for (const t of tanks) for (const r of (t.racks || [])) {
    c.racks++; if (r.archived_at) c.archived_racks++;
    for (const b of (r.boxes || [])) {
      c.boxes++; if (b.archived_at) c.archived_boxes++;
      for (const v of (b.vials || [])) {
        c.vials++; if (v.archived_at) c.archived_vials++;
      }
    }
  }
  return c;
}


// =============================================================================
// buildHistory(db) — the audit log, same shape as GET /api/export/history
// =============================================================================
function buildHistory(db) {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY timestamp DESC, id DESC').all();
  const parse = s => { if (!s) return null; try { return JSON.parse(s); } catch { return s; } };
  const entries = rows.map(r => ({
    ...r, old_data: parse(r.old_data), new_data: parse(r.new_data), context: parse(r.context),
  }));
  return { exported_at: new Date().toISOString(), total: entries.length, entries };
}


// =============================================================================
// schemaState(db) — which uniqueness rule each table currently has
// =============================================================================
//   legacy       one row per place, archived rows included (old versions)
//   active-only  one ACTIVE row per place (this version)
//   none         neither (should not happen)
// =============================================================================
function schemaState(db) {
  const state = (table, columns, partialIndex) => {
    const legacy = db.prepare(`PRAGMA index_list(${table})`).all().some(ix => {
      if (ix.origin !== 'u' || !ix.unique) return false;
      const cols = db.prepare(`PRAGMA index_info(${ix.name})`).all().map(c => c.name);
      return cols.join(',') === columns.join(',');
    });
    if (legacy) return 'legacy';
    const partial = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(partialIndex);
    return partial ? 'active-only' : 'none';
  };
  return {
    vials_position: state('vials', ['box_id', 'row_index', 'col_index'], 'ux_vials_active_position'),
    boxes_slot:     state('boxes', ['rack_id', 'slot_position'],         'ux_boxes_active_slot'),
  };
}


// =============================================================================
// report(db) — records affected by the archived-position bug
// =============================================================================
// Before this version, putting a vial into a cell that held an ARCHIVED vial
// updated that archived record instead of adding a new one:
//
//   • Originally the record stayed archived, so the vial you added never
//     appeared ("hidden placement"). The tube may well be in the box while
//     the app shows the cell as empty.
//   • After the first fix (commit 4d6c45c) the record was un-archived, so
//     the vial appeared, but the archived vial's own record was overwritten
//     ("overwritten archive record").
//
// Either way the change history kept the full before/after data, so both
// cases can be listed from it. This is read-only; nothing is changed.
// =============================================================================
function report(db) {
  const rowL = i => String.fromCharCode(65 + Number(i));
  const colL = i => String(Number(i) + 1).padStart(2, '0');

  const events = db.prepare(`
    SELECT a.timestamp, a.entity_id, a.changed_by,
           json_extract(a.old_data, '$.name')        AS old_name,
           json_extract(a.old_data, '$.archived_at') AS old_archived_at,
           json_extract(a.new_data, '$.name')        AS new_name,
           json_extract(a.new_data, '$.archived_at') AS new_archived_at,
           json_extract(a.old_data, '$.box_id')      AS box_id,
           json_extract(a.old_data, '$.row_index')   AS row_index,
           json_extract(a.old_data, '$.col_index')   AS col_index,
           b.name AS box_name, r.name AS rack_name,
           v.archived_at AS now_archived_at, v.name AS now_name
    FROM   audit_log a
    LEFT   JOIN boxes b ON b.id = json_extract(a.old_data, '$.box_id')
    LEFT   JOIN racks r ON r.id = b.rack_id
    LEFT   JOIN vials v ON v.id = a.entity_id
    WHERE  a.entity_type = 'vial'
      AND  a.action      = 'update'
      AND  json_valid(a.old_data)
      AND  json_extract(a.old_data, '$.archived_at') IS NOT NULL
    ORDER  BY a.timestamp
  `).all();

  const where = e => `${e.rack_name ?? '?'} › ${e.box_name ?? '(deleted box)'} › ${
    e.row_index != null ? rowL(e.row_index) + colL(e.col_index) : '?'}`;

  const hidden      = events.filter(e => e.new_archived_at != null);
  const overwritten = events.filter(e => e.new_archived_at == null);

  const lines = [];
  lines.push('CryoVault — records affected by the archived-position bug');
  lines.push(`Generated ${new Date().toISOString()}. Read-only report; nothing was changed.`);
  lines.push('');
  lines.push(`Hidden placements (vial added, but it never appeared): ${hidden.length}`);
  for (const e of hidden) {
    const still = e.now_archived_at != null && e.now_name === e.new_name;
    lines.push(`  ${e.timestamp}  ${where(e)}  added "${e.new_name}" by ${e.changed_by}` +
      ` (archived vial there was "${e.old_name}")` +
      (still ? '  ← STILL HIDDEN: check whether this tube is physically in the box' : ''));
  }
  lines.push('');
  lines.push(`Overwritten archive records (vial added; the archived vial's record was replaced): ${overwritten.length}`);
  for (const e of overwritten) {
    lines.push(`  ${e.timestamp}  ${where(e)}  "${e.old_name}" (archived ${e.old_archived_at}) replaced by "${e.new_name}" by ${e.changed_by}`);
  }
  lines.push('');
  lines.push(events.length
    ? "The full details of every archived vial listed above are in the change history (History page, or the history JSON in this backup), in the entry's \"before\" data."
    : 'No affected records found.');

  return { hidden: hidden.length, overwritten: overwritten.length, text: lines.join('\n') + '\n' };
}


module.exports = {
  EXPORT_FORMAT, EXPORT_FORMAT_VERSION,
  counts, formatCounts, buildSnapshot, countsFromSnapshot, buildHistory, schemaState, report,
};


// =============================================================================
// COMMAND LINE
// =============================================================================
if (require.main === module) {
  const Database = require('better-sqlite3');
  const [cmd, ...args] = process.argv.slice(2);

  const open = file => {
    const p = file || process.env.DB_PATH;
    if (!p) throw new Error('no database given and DB_PATH is not set');
    return new Database(p, { readonly: true, fileMustExist: true });
  };
  const readJson = file => JSON.parse(fs.readFileSync(file === '-' ? 0 : file, 'utf8'));
  const out = s => process.stdout.write(s);

  const commands = {
    'counts':      ([db]) => out(formatCounts(counts(open(db))) + '\n'),
    'audit-count': ([db]) => out(open(db).prepare('SELECT COUNT(*) AS c FROM audit_log').get().c + '\n'),
    'schema':      ([db]) => { const s = schemaState(open(db));
                               out(`vials_position=${s.vials_position} boxes_slot=${s.boxes_slot}\n`); },
    'check': ([db]) => {
      const d = open(db);
      const result = d.pragma('integrity_check', { simple: true });
      if (result !== 'ok') { console.error(`integrity_check: ${result}`); process.exit(1); }
      // Rows whose parent is missing (e.g. a vial whose box was deleted while
      // foreign keys were off, as they are in the sqlite3 command-line tool).
      // The app always enforces foreign keys, so normally there are none.
      const orphans = d.pragma('foreign_key_check');
      if (orphans.length) {
        console.error(`foreign_key_check: ${orphans.length} row(s) point at a missing parent:`);
        for (const o of orphans.slice(0, 10)) {
          const row = d.prepare(`SELECT * FROM ${o.table} WHERE rowid = ?`).get(o.rowid) || {};
          console.error(`  ${o.table} id=${row.id ?? '?'} name=${JSON.stringify(row.name ?? '')} → missing ${o.parent}`);
        }
        if (orphans.length > 10) console.error(`  ... and ${orphans.length - 10} more`);
        process.exit(1);
      }
      out(formatCounts(counts(d)) + '\n');
    },
    'backup': async ([dest, db]) => {
      if (!dest) throw new Error('usage: backup <dest> [db]');
      if (fs.existsSync(dest)) throw new Error(`${dest} already exists`);
      // better-sqlite3's online backup API: a consistent copy even while the
      // app is writing, and the copy is a self-contained file (no -wal).
      await open(db).backup(dest);
      const copy = new Database(dest, { readonly: true });
      const result = copy.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new Error(`backup failed integrity_check: ${result}`);
      console.error(`backup written to ${dest} (integrity ok)`);
    },
    'export':         ([db]) => out(JSON.stringify(buildSnapshot(open(db)), null, 2) + '\n'),
    'history':        ([db]) => out(JSON.stringify(buildHistory(open(db)), null, 2) + '\n'),
    'verify-export':  ([file]) => out(formatCounts(countsFromSnapshot(readJson(file || '-'))) + '\n'),
    'verify-history': ([file]) => {
      const h = readJson(file || '-');
      if (!Array.isArray(h.entries) || h.entries.length !== h.total) throw new Error('history file is incomplete');
      out(h.total + '\n');
    },
    'report': ([db]) => out(report(open(db)).text),
  };

  const fn = commands[cmd];
  if (!fn) {
    console.error(`usage: node lib/dbtools.js <${Object.keys(commands).join('|')}> [args]`);
    process.exit(2);
  }
  Promise.resolve()
    .then(() => fn(args))
    .catch(err => { console.error(`dbtools ${cmd}: ${err.message}`); process.exit(1); });
}
