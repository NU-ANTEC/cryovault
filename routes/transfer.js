// =============================================================================
// routes/transfer.js — Import and Export Endpoints
// =============================================================================
//
// These endpoints provide data portability:
//   - Export: snapshot the entire database to a single JSON file
//   - Import: restore or merge from a previously exported JSON file
//
// WHY NOT JUST COPY THE .db FILE?
//   Copying the raw SQLite file works for a full restore, but a JSON export:
//   - Can be read and understood by humans and other tools
//   - Can be partially imported (only some racks/boxes)
//   - Is database-engine agnostic (works if you later migrate to PostgreSQL)
//   - Can be versioned, diffed, and stored in a repository
//
// ENDPOINT SUMMARY
//   GET  /api/export          — full JSON snapshot (attachment download)
//   GET  /api/export/history  — full audit log as JSON (attachment download)
//   POST /api/import          — import a JSON snapshot
//
// IMPORT MODES
//   merge   — Adds racks/boxes/vials that don't already exist (by name).
//             Existing records are untouched. Safe for incremental updates.
//   replace — Deletes everything in the current tank and reimports from scratch.
//             Use for full restores from a backup. DESTRUCTIVE.
// =============================================================================

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, logAudit } = require('../db');

const router = express.Router();

// Version tag embedded in every export.
// If the format ever changes (new fields, restructured nesting), bump this
// number so import code can detect and handle old vs new formats.
const EXPORT_FORMAT_VERSION = '1.0';


// =============================================================================
// GET /api/export
// =============================================================================
// Generates a complete JSON snapshot of the entire tank inventory.
// The response is sent with a Content-Disposition: attachment header, which
// tells the browser to download it as a file rather than displaying it.
//
// The export is a single self-contained object — all racks, all boxes,
// all vials — so no additional API calls are needed to reconstruct the state.
// =============================================================================
router.get('/export', (req, res) => {
  // We assume one tank per deployment (the default setup).
  const tank = db.prepare('SELECT * FROM tanks LIMIT 1').get();
  if (!tank) return res.status(404).json({ error: 'No tank configured' });

  const racks = db.prepare(`
    SELECT * FROM racks WHERE tank_id = ? ORDER BY name
  `).all(tank.id);

  // Build the nested snapshot: tank → racks → boxes → vials
  const snapshot = {
    // _meta provides context for whoever receives this file —
    // when it was made, which version of the format it uses, and which tank.
    _meta: {
      format:      'cryovault-export',
      version:     EXPORT_FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      source_tank: tank.name
    },
    tank,
    racks: racks.map(rack => {
      const boxes = db.prepare(`
        SELECT * FROM boxes WHERE rack_id = ? ORDER BY name
      `).all(rack.id);

      return {
        ...rack,
        boxes: boxes.map(box => {
          const vials = db.prepare(`
            SELECT * FROM vials WHERE box_id = ? ORDER BY row_index, col_index
          `).all(box.id);

          return { ...box, vials };
        })
      };
    })
  };

  // Construct a timestamped filename so sequential exports don't overwrite each other
  const filename = `cryovault-export-${Date.now()}.json`;

  // Content-Disposition: attachment tells the browser "save this as a file"
  // Content-Type: application/json tells it what kind of file it is
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');

  // res.json() serializes the object and sends it. The 3rd argument to
  // JSON.stringify (2) pretty-prints with 2-space indentation — readable by humans.
  res.status(200).json(snapshot);
});


// =============================================================================
// GET /api/export/history
// =============================================================================
// Exports the full audit log as a downloadable JSON file.
// Useful for archiving, compliance, or feeding into external analytics tools.
// =============================================================================
router.get('/export/history', (_req, res) => {
  const rows = db.prepare(`
    SELECT * FROM audit_log ORDER BY timestamp DESC
  `).all();

  // Parse stored JSON strings back into objects for readability
  const entries = rows.map(row => ({
    ...row,
    old_data: row.old_data ? JSON.parse(row.old_data) : null,
    new_data: row.new_data ? JSON.parse(row.new_data) : null,
    context:  row.context  ? JSON.parse(row.context)  : null
  }));

  const filename = `cryovault-history-${Date.now()}.json`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/json');
  res.json({
    exported_at: new Date().toISOString(),
    total:       entries.length,
    entries
  });
});


// =============================================================================
// POST /api/import
// =============================================================================
// Imports data from a previously exported JSON file.
//
// Request body (JSON):
//   {
//     data:      <full export JSON object>,
//     mode:      "merge" | "replace",
//     changedBy: "Researcher Name"  (optional, for audit trail)
//   }
//
// Response:
//   { success: true, mode, stats: { racks, boxes, vials, skipped } }
// =============================================================================
router.post('/import', (req, res) => {
  const { data, mode = 'merge', changedBy = 'import' } = req.body;

  // ── Validate the incoming data ────────────────────────────────────────────
  if (!data) {
    return res.status(400).json({ error: '"data" field is required in the request body' });
  }

  // Check for the format marker to ensure this is actually a CryoVault export
  // and not some other JSON file the user accidentally uploaded.
  if (!data._meta || data._meta.format !== 'cryovault-export') {
    return res.status(400).json({ error: 'Invalid export format — missing _meta.format field' });
  }

  if (!['merge', 'replace'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "merge" or "replace"' });
  }

  // Stats counter — we'll report how many records were created vs skipped
  const stats = { racks: 0, boxes: 0, vials: 0, skipped: 0 };
  const now   = new Date().toISOString();

  // Get the target tank (the one already in the database)
  const tank = db.prepare('SELECT * FROM tanks LIMIT 1').get();
  if (!tank) return res.status(500).json({ error: 'No tank found in the database' });

  // ── Wrap the entire import in a database transaction ──────────────────────
  // A transaction means: either ALL the inserts succeed, or NONE of them do.
  // If anything fails partway through, SQLite automatically rolls back every
  // change made so far, leaving the database in its original clean state.
  // Without a transaction, a failure partway through would leave partial data.
  //
  // better-sqlite3's  db.transaction()  creates a function that wraps its
  // body in BEGIN / COMMIT / ROLLBACK automatically.
  const doImport = db.transaction(() => {

    // ── REPLACE MODE: clear existing data ───────────────────────────────────
    // Delete all racks (ON DELETE CASCADE removes boxes and vials too).
    if (mode === 'replace') {
      db.prepare('DELETE FROM racks WHERE tank_id = ?').run(tank.id);
      logAudit({
        entityType: 'tank',
        entityId:   tank.id,
        entityName: tank.name,
        action:     'update',
        changedBy,
        context:    { operation: 'replace-import-clear' }
      });
    }

    // ── Process each rack in the import file ────────────────────────────────
    for (const rack of (data.racks || [])) {

      // In MERGE mode, check if a rack with this name already exists.
      // If it does, we add boxes to it rather than creating a duplicate.
      const existingRack = mode === 'merge'
        ? db.prepare('SELECT id FROM racks WHERE tank_id = ? AND name = ?').get(tank.id, rack.name)
        : null;

      // Use the existing rack's ID, or generate a new one for a new rack
      const targetRackId = existingRack ? existingRack.id : uuidv4();

      if (!existingRack) {
        // Insert the rack. Use the exported created_at date if available,
        // falling back to now (so timestamps make sense for old exports).
        db.prepare(`
          INSERT INTO racks (id, tank_id, name, position, notes, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          targetRackId, tank.id, rack.name,
          rack.position || '', rack.notes || '',
          rack.created_at || now, now
        );
        logAudit({ entityType: 'rack', entityId: targetRackId, entityName: rack.name, action: 'create', changedBy, context: { source: 'import', mode } });
        stats.racks++;
      }
      // If the rack already existed in merge mode, we silently proceed
      // to process its boxes (they might be new even if the rack isn't).

      // ── Process each box in this rack ─────────────────────────────────────
      for (const box of (rack.boxes || [])) {

        const existingBox = mode === 'merge'
          ? db.prepare('SELECT id FROM boxes WHERE rack_id = ? AND name = ?').get(targetRackId, box.name)
          : null;

        const targetBoxId = existingBox ? existingBox.id : uuidv4();

        if (!existingBox) {
          db.prepare(`
            INSERT INTO boxes (id, rack_id, name, rows, cols, qr_code, notes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            targetBoxId, targetRackId, box.name,
            box.rows, box.cols, box.qr_code || null,
            box.notes || '', box.created_at || now, now
          );
          logAudit({ entityType: 'box', entityId: targetBoxId, entityName: box.name, action: 'create', changedBy, context: { source: 'import', mode, rack_id: targetRackId } });
          stats.boxes++;
        }

        // ── Process each vial in this box ──────────────────────────────────
        for (const vial of (box.vials || [])) {

          // In merge mode, skip vials at positions that are already occupied.
          // This prevents accidental overwrites of existing samples.
          const existingVial = db.prepare(`
            SELECT id FROM vials
            WHERE box_id = ? AND row_index = ? AND col_index = ?
          `).get(targetBoxId, vial.row_index, vial.col_index);

          if (existingVial && mode === 'merge') {
            stats.skipped++;
            continue;  // Skip this vial — position is already occupied
          }

          // In replace mode the box was just created so no vials exist.
          // But if we're merging into an existing box, remove the old vial first.
          if (existingVial) {
            db.prepare('DELETE FROM vials WHERE id = ?').run(existingVial.id);
          }

          const vid = uuidv4();
          db.prepare(`
            INSERT INTO vials
              (id, box_id, row_index, col_index, name, sample_type,
               date_stored, volume, concentration, researcher, qr_code, notes,
               created_at, updated_at)
            VALUES
              (?,  ?,      ?,         ?,         ?,    ?,
               ?,           ?,      ?,             ?,          ?,       ?,
               ?,          ?)
          `).run(
            vid, targetBoxId, vial.row_index, vial.col_index,
            vial.name, vial.sample_type || '',
            vial.date_stored || '', vial.volume || '',
            vial.concentration || '', vial.researcher || '',
            vial.qr_code || null, vial.notes || '',
            vial.created_at || now, now
          );

          logAudit({ entityType: 'vial', entityId: vid, entityName: vial.name, action: 'create', changedBy, context: { source: 'import', mode, box_id: targetBoxId } });
          stats.vials++;
        }
      }
    }
  }); // end db.transaction()

  // ── Execute the transaction ───────────────────────────────────────────────
  try {
    doImport();
    res.json({ success: true, mode, stats });
  } catch (err) {
    // If anything inside the transaction threw, SQLite has already rolled back.
    // We just need to report the error to the client.
    console.error('[import] Transaction failed, rolled back:', err.message);
    res.status(500).json({ error: 'Import failed — database rolled back', detail: err.message });
  }
});


module.exports = router;


// =============================================================================
// CSV EXPORT
// =============================================================================
// GET /api/export/csv
// Exports all active vials as a flat CSV file, one row per vial, with full
// location context (rack, box, slot, position) so the file is self-contained
// and can be opened directly in Excel or Google Sheets.
//
// Columns:
//   rack_name, rack_position, box_name, box_slot, position,
//   name, sample_type, date_stored, volume, concentration,
//   researcher, qr_code, notes
// =============================================================================
router.get('/export/csv', (req, res) => {
  const tank = db.prepare('SELECT * FROM tanks LIMIT 1').get();
  if (!tank) return res.status(404).json({ error: 'No tank configured' });

  const rows = db.prepare(`
    SELECT
      r.name          AS rack_name,
      r.position      AS rack_position,
      b.name          AS box_name,
      b.slot_position AS box_slot,
      v.row_index,
      v.col_index,
      v.name, v.sample_type, v.date_stored,
      v.volume, v.concentration, v.researcher,
      v.qr_code, v.notes
    FROM   vials v
    JOIN   boxes b ON b.id = v.box_id
    JOIN   racks r ON r.id = b.rack_id
    WHERE  v.archived_at IS NULL
      AND  b.archived_at IS NULL
      AND  r.archived_at IS NULL
    ORDER  BY r.name, b.slot_position, v.row_index, v.col_index
  `).all();

  const rowLbl = i => String.fromCharCode(65 + i);
  const colLbl = i => String(i + 1).padStart(2, '0');

  // CSV helpers
  const escCsv = v => {
    if (v == null) return '';
    const s = String(v);
    // Wrap in quotes if the value contains commas, quotes, or newlines
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const header = [
    'rack_name','rack_position','box_name','box_slot','position',
    'name','sample_type','date_stored','volume','concentration',
    'researcher','qr_code','notes'
  ].join(',');

  const lines = rows.map(r => [
    r.rack_name, r.rack_position, r.box_name, r.box_slot,
    `${rowLbl(r.row_index)}${colLbl(r.col_index)}`,
    r.name, r.sample_type, r.date_stored, r.volume, r.concentration,
    r.researcher, r.qr_code, r.notes
  ].map(escCsv).join(','));

  const csv = [header, ...lines].join('\r\n');
  const filename = `cryovault-vials-${Date.now()}.csv`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  // BOM so Excel auto-detects UTF-8 (otherwise special chars like µ show as garbage)
  res.send('\uFEFF' + csv);
});



// =============================================================================
// CSV IMPORT — two-phase: preview then execute
// =============================================================================
//
// Phase 1: POST /api/import/csv/preview
//   Parses the CSV, detects conflicts, returns a row-by-row plan.
//   Does NOT write anything to the database.
//   Returns: { rows: [ { rowNum, status, incoming, conflict?, suggestion? } ] }
//
//   Row statuses:
//     'new'       — rack, box, and position are all empty; will be created cleanly
//     'new_rack'  — rack doesn't exist yet; will be auto-created
//     'new_box'   — box doesn't exist yet in this rack; will be auto-created
//     'conflict'  — position is already occupied by a different vial
//     'duplicate' — incoming vial name matches the occupant's name exactly
//     'error'     — CSV parse error (missing fields, bad position, out of bounds)
//
// Phase 2: POST /api/import/csv/execute
//   Receives the original CSV plus a decisions map:
//     decisions: { "<rowNum>": "skip" | "overwrite" | "skip" }
//   "overwrite" replaces the existing vial with the incoming data.
//   "skip"      leaves the existing vial untouched.
//   Rows with status 'new', 'new_rack', 'new_box' are always inserted.
//   Rows with status 'error' are always skipped.
//   Returns: { stats: { created, overwritten, skipped, errors } }
// =============================================================================

// ── Shared CSV helpers ────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ',') { fields.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
  }
  fields.push(cur.trim());
  return fields;
}

function parseCsvToRows(csv) {
  const rawLines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (rawLines.length < 2) throw new Error('CSV must have a header row and at least one data row');
  const headers = parseCsvLine(rawLines[0]).map(h => h.toLowerCase().replace(/\s+/g,'_'));
  const REQUIRED = ['rack_name','box_name','position','name'];
  const missing  = REQUIRED.filter(h => !headers.includes(h));
  if (missing.length) throw new Error(`CSV missing required columns: ${missing.join(', ')}`);
  const col = name => headers.indexOf(name);
  const rows = [];
  for (let i = 1; i < rawLines.length; i++) {
    if (!rawLines[i].trim()) continue;
    const fields = parseCsvLine(rawLines[i]);
    const get    = name => (fields[col(name)] || '').trim();
    rows.push({ lineNum: i + 1, get, raw: rawLines[i] });
  }
  return rows;
}

// ── Phase 1: Preview ──────────────────────────────────────────────────────────

router.post('/import/csv/preview', (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: '"csv" field is required' });

  let parsedRows;
  try { parsedRows = parseCsvToRows(csv); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const tanks = db.prepare('SELECT * FROM tanks ORDER BY name').all();
  if (!tanks.length) return res.status(500).json({ error: 'No tanks configured' });
  // Use the first tank as default (CSV doesn't carry tank info)
  const tank = tanks[0];

  // Cache racks and boxes looked up during preview (read-only, no inserts)
  const rackCache = {};
  const boxCache  = {};

  const result = [];

  for (const { lineNum, get } of parsedRows) {
    const rackName = get('rack_name');
    const boxName  = get('box_name');
    const pos      = get('position').toUpperCase();
    const name     = get('name');

    // ── Validate required fields ────────────────────────────────────────────
    if (!rackName || !boxName || !pos || !name) {
      result.push({ rowNum: lineNum, status: 'error', reason: 'Missing required field',
        incoming: { rack_name:rackName, box_name:boxName, position:pos, name } });
      continue;
    }

    // ── Parse position ──────────────────────────────────────────────────────
    const rowLetter = pos[0];
    const colNumber = parseInt(pos.slice(1), 10);
    if (!/^[A-Z]$/.test(rowLetter) || isNaN(colNumber) || colNumber < 1) {
      result.push({ rowNum: lineNum, status: 'error', reason: `Invalid position "${pos}" (expected e.g. "B04")`,
        incoming: { rack_name:rackName, box_name:boxName, position:pos, name } });
      continue;
    }
    const rowIndex = rowLetter.charCodeAt(0) - 65;
    const colIndex = colNumber - 1;

    // ── Resolve rack (read-only) ────────────────────────────────────────────
    const rackKey = `${tank.id}:${rackName.toLowerCase()}`;
    if (!rackCache[rackKey]) {
      rackCache[rackKey] = db.prepare(`SELECT * FROM racks WHERE tank_id = ? AND name = ? AND archived_at IS NULL`).get(tank.id, rackName) || null;
    }
    const rack = rackCache[rackKey];

    // ── Resolve box (read-only) ─────────────────────────────────────────────
    let box = null;
    if (rack) {
      const boxKey = `${rack.id}:${boxName.toLowerCase()}`;
      if (!boxCache[boxKey]) {
        boxCache[boxKey] = db.prepare(`SELECT * FROM boxes WHERE rack_id = ? AND name = ? AND archived_at IS NULL`).get(rack.id, boxName) || null;
      }
      box = boxCache[boxKey];
    }

    const incoming = {
      rack_name:    rackName,
      box_name:     boxName,
      position:     pos,
      name,
      sample_type:  get('sample_type'),
      date_stored:  get('date_stored'),
      volume:       get('volume'),
      concentration:get('concentration'),
      researcher:   get('researcher'),
      notes:        get('notes'),
    };

    // ── Determine status ────────────────────────────────────────────────────
    if (!rack) {
      result.push({ rowNum: lineNum, status: 'new_rack', incoming,
        note: `Rack "${rackName}" will be created automatically` });
      continue;
    }

    if (!box) {
      result.push({ rowNum: lineNum, status: 'new_box', incoming,
        note: `Box "${boxName}" will be created in rack "${rackName}"` });
      continue;
    }

    // Bounds check
    if (rowIndex >= box.rows || colIndex >= box.cols) {
      result.push({ rowNum: lineNum, status: 'error',
        reason: `Position "${pos}" is out of bounds for ${box.rows}×${box.cols} box "${boxName}"`,
        incoming });
      continue;
    }

    // Check occupancy
    const occupant = db.prepare(`
      SELECT * FROM vials
      WHERE box_id = ? AND row_index = ? AND col_index = ? AND archived_at IS NULL
    `).get(box.id, rowIndex, colIndex);

    if (!occupant) {
      result.push({ rowNum: lineNum, status: 'new', incoming });
    } else if (occupant.name === name) {
      result.push({
        rowNum: lineNum, status: 'duplicate', incoming,
        conflict: {
          name:         occupant.name,
          sample_type:  occupant.sample_type,
          date_stored:  occupant.date_stored,
          researcher:   occupant.researcher,
          notes:        occupant.notes,
        },
        note: 'Same name and position — likely the same vial'
      });
    } else {
      result.push({
        rowNum: lineNum, status: 'conflict', incoming,
        conflict: {
          name:         occupant.name,
          sample_type:  occupant.sample_type,
          date_stored:  occupant.date_stored,
          researcher:   occupant.researcher,
          notes:        occupant.notes,
        },
        note: `Position ${pos} occupied by "${occupant.name}"`
      });
    }
  }

  // Summary counts
  const summary = {
    total:      result.length,
    new:        result.filter(r => r.status === 'new').length,
    new_rack:   result.filter(r => r.status === 'new_rack').length,
    new_box:    result.filter(r => r.status === 'new_box').length,
    conflict:   result.filter(r => r.status === 'conflict').length,
    duplicate:  result.filter(r => r.status === 'duplicate').length,
    error:      result.filter(r => r.status === 'error').length,
    tank_name:  tank.name,
  };

  res.json({ summary, rows: result });
});


// ── Phase 2: Execute ──────────────────────────────────────────────────────────

router.post('/import/csv/execute', (req, res) => {
  const { csv, decisions = {}, changedBy = 'admin-import' } = req.body;
  // decisions: { "5": "skip", "12": "overwrite", ... }
  // Keys are row line numbers (strings). Values: "skip" | "overwrite"
  // Rows not in decisions default to "skip" for conflicts/duplicates.

  if (!csv) return res.status(400).json({ error: '"csv" field is required' });

  let parsedRows;
  try { parsedRows = parseCsvToRows(csv); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  const tanks = db.prepare('SELECT * FROM tanks ORDER BY name').all();
  if (!tanks.length) return res.status(500).json({ error: 'No tanks configured' });
  const tank = tanks[0];

  const { v4: uuid } = require('uuid');
  const now = new Date().toISOString();

  const rackCache = {};
  const boxCache  = {};

  const stats = { created: 0, overwritten: 0, skipped: 0, errors: [] };

  const doExecute = db.transaction(() => {
    for (const { lineNum, get } of parsedRows) {
      const rackName = get('rack_name');
      const boxName  = get('box_name');
      const pos      = get('position').toUpperCase();
      const name     = get('name');

      if (!rackName || !boxName || !pos || !name) {
        stats.errors.push(`Row ${lineNum}: missing required field`);
        stats.skipped++;
        continue;
      }

      const rowLetter = pos[0];
      const colNumber = parseInt(pos.slice(1), 10);
      if (!/^[A-Z]$/.test(rowLetter) || isNaN(colNumber) || colNumber < 1) {
        stats.errors.push(`Row ${lineNum}: invalid position "${pos}"`);
        stats.skipped++;
        continue;
      }
      const rowIndex = rowLetter.charCodeAt(0) - 65;
      const colIndex = colNumber - 1;

      // ── Find or create rack ─────────────────────────────────────────────
      const rackKey = `${tank.id}:${rackName.toLowerCase()}`;
      if (!rackCache[rackKey]) {
        let rack = db.prepare(`SELECT * FROM racks WHERE tank_id = ? AND name = ? AND archived_at IS NULL`).get(tank.id, rackName);
        if (!rack) {
          const rid = uuid();
          db.prepare(`INSERT INTO racks(id,tank_id,name,position,capacity,notes,created_at,updated_at) VALUES(?,?,?,?,10,'',?,?)`).run(rid,tank.id,rackName,get('rack_position')||'',now,now);
          rack = db.prepare(`SELECT * FROM racks WHERE id = ?`).get(rid);
          logAudit({ entityType:'rack', entityId:rid, entityName:rackName, action:'create', changedBy, context:{source:'csv-import'} });
        }
        rackCache[rackKey] = rack;
      }
      const rack = rackCache[rackKey];

      // ── Find or create box ──────────────────────────────────────────────
      const boxKey = `${rack.id}:${boxName.toLowerCase()}`;
      if (!boxCache[boxKey]) {
        let box = db.prepare(`SELECT * FROM boxes WHERE rack_id = ? AND name = ? AND archived_at IS NULL`).get(rack.id, boxName);
        if (!box) {
          const bid  = uuid();
          const slot = parseInt(get('box_slot'), 10) || 1;
          db.prepare(`INSERT INTO boxes(id,rack_id,name,slot_position,rows,cols,notes,created_at,updated_at) VALUES(?,?,?,?,9,9,'',?,?)`).run(bid,rack.id,boxName,slot,now,now);
          box = db.prepare(`SELECT * FROM boxes WHERE id = ?`).get(bid);
          logAudit({ entityType:'box', entityId:bid, entityName:boxName, action:'create', changedBy, context:{source:'csv-import',rack_id:rack.id} });
        }
        boxCache[boxKey] = box;
      }
      const box = boxCache[boxKey];

      // Bounds check
      if (rowIndex >= box.rows || colIndex >= box.cols) {
        stats.errors.push(`Row ${lineNum}: position "${pos}" out of bounds for "${boxName}"`);
        stats.skipped++;
        continue;
      }

      // ── Check occupancy ─────────────────────────────────────────────────
      const occupant = db.prepare(`
        SELECT * FROM vials
        WHERE box_id = ? AND row_index = ? AND col_index = ? AND archived_at IS NULL
      `).get(box.id, rowIndex, colIndex);

      const decision = decisions[String(lineNum)] || 'skip';

      if (occupant) {
        if (decision === 'overwrite') {
          // Replace existing vial in-place, preserving its ID and audit trail
          db.prepare(`
            UPDATE vials SET name=?,sample_type=?,date_stored=?,volume=?,
              concentration=?,researcher=?,qr_code=?,notes=?,updated_at=?
            WHERE id=?
          `).run(
            name, get('sample_type'), get('date_stored'), get('volume'),
            get('concentration'), get('researcher'), get('qr_code')||null,
            get('notes'), now, occupant.id
          );
          logAudit({ entityType:'vial', entityId:occupant.id, entityName:name,
            action:'update', changedBy, oldData:occupant,
            context:{source:'csv-import',overwrite:true} });
          stats.overwritten++;
        } else {
          // skip
          stats.skipped++;
        }
        continue;
      }

      // ── Insert new vial ─────────────────────────────────────────────────
      const vid = uuid();
      db.prepare(`
        INSERT INTO vials(id,box_id,row_index,col_index,name,sample_type,
          date_stored,volume,concentration,researcher,qr_code,notes,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        vid, box.id, rowIndex, colIndex, name,
        get('sample_type'), get('date_stored'), get('volume'),
        get('concentration'), get('researcher'), get('qr_code')||null, get('notes'),
        now, now
      );
      logAudit({ entityType:'vial', entityId:vid, entityName:name, action:'create',
        changedBy, context:{source:'csv-import',box_id:box.id} });
      stats.created++;
    }
  });

  try {
    doExecute();
    res.json({ success: true, stats });
  } catch (err) {
    console.error('[csv-import-execute]', err);
    res.status(500).json({ error: 'Import failed', detail: err.message });
  }
});

