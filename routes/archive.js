// =============================================================================
// routes/archive.js — Archived Item Management
// =============================================================================
//
// When "Archive on delete" is enabled in Settings, deleted items are
// soft-deleted: their archived_at column is set to a timestamp instead of
// their row being removed. These routes manage those archived items.
//
// ENDPOINTS
//   GET    /api/archive          — list all archived items (searchable)
//   GET    /api/archive/counts   — count of archived items per type
//   POST   /api/archive/restore  — restore one item (clear archived_at)
//   DELETE /api/archive/purge    — permanently delete archived items
// =============================================================================

const express    = require('express');
const { db, logAudit } = require('../db');

const router = express.Router();

const rowLabel = i => String.fromCharCode(65 + i);
const colLabel = i => String(i + 1).padStart(2, '0');


// =============================================================================
// GET /api/archive
// =============================================================================
// Returns archived racks, boxes, and vials, most recently archived first,
// with their location context.
// Optional query params:
//   ?type=rack|box|vial   — filter to one entity type
//   ?q=search             — substring search (names; for vials also
//                           researcher and sample type)
//   ?limit=N              — at most N items per type (the page asks for 200,
//                           so a large archive doesn't load all at once)
//
// Response: { total, counts: { racks, boxes, vials }, limited, results }
//   counts / total are the full number of matches of every type (even with
//   ?type, and even when the lists in results were cut to `limit`); limited
//   is true if a returned list was cut.
// =============================================================================
router.get('/archive', (req, res) => {
  const type    = req.query.type || '';
  const q       = (req.query.q || '').trim();
  const pattern = q ? `%${q}%` : '%';
  const limitN  = parseInt(req.query.limit, 10);
  const limit   = Number.isInteger(limitN) && limitN > 0 ? limitN : -1;   // -1 = no limit in SQLite

  const results = { racks: [], boxes: [], vials: [] };
  const counts  = { racks: 0, boxes: 0, vials: 0 };

  // Counts are computed for every type (so the filter pills always show
  // them); lists only for the selected type.
  {
    const where = `FROM racks r JOIN tanks t ON t.id = r.tank_id
                   WHERE r.archived_at IS NOT NULL AND r.name LIKE ?`;
    counts.racks  = db.prepare(`SELECT COUNT(*) AS c ${where}`).get(pattern).c;
    if (!type || type === 'rack') results.racks = db.prepare(`
      SELECT r.*, t.name AS tank_name ${where}
      ORDER  BY r.archived_at DESC
      LIMIT  ?
    `).all(pattern, limit);
  }

  {
    const where = `FROM boxes b JOIN racks r ON r.id = b.rack_id
                   WHERE b.archived_at IS NOT NULL AND b.name LIKE ?`;
    counts.boxes  = db.prepare(`SELECT COUNT(*) AS c ${where}`).get(pattern).c;
    if (!type || type === 'box') results.boxes = db.prepare(`
      SELECT b.*, r.name AS rack_name, r.id AS rack_id_fk ${where}
      ORDER  BY b.archived_at DESC
      LIMIT  ?
    `).all(pattern, limit);
  }

  {
    const where = `FROM vials v
                   JOIN boxes b ON b.id = v.box_id
                   JOIN racks r ON r.id = b.rack_id
                   WHERE v.archived_at IS NOT NULL
                     AND (v.name LIKE ? OR v.researcher LIKE ? OR v.sample_type LIKE ?)`;
    counts.vials = db.prepare(`SELECT COUNT(*) AS c ${where}`).get(pattern, pattern, pattern).c;
    const vials = (type && type !== 'vial') ? [] : db.prepare(`
      SELECT v.*,
             b.name AS box_name, b.id AS box_id_fk, b.slot_position AS box_slot,
             r.name AS rack_name, r.id AS rack_id_fk
      ${where}
      ORDER  BY v.archived_at DESC
      LIMIT  ?
    `).all(pattern, pattern, pattern, limit);

    results.vials = vials.map(v => ({
      ...v,
      row_label:      rowLabel(v.row_index),
      col_label:      colLabel(v.col_index),
      position_label: `${rowLabel(v.row_index)}${colLabel(v.col_index)}`,
      path: `${v.rack_name} › Slot ${v.box_slot} › ${v.box_name} › ${rowLabel(v.row_index)}${colLabel(v.col_index)}`
    }));
  }

  const total   = counts.racks + counts.boxes + counts.vials;
  const shown   = t => !type || type === t;
  const limited = (shown('rack') && results.racks.length < counts.racks)
               || (shown('box')  && results.boxes.length < counts.boxes)
               || (shown('vial') && results.vials.length < counts.vials);
  res.json({ total, counts, limited, results });
});


// =============================================================================
// GET /api/archive/counts
// =============================================================================
// Returns just the counts of archived items per type — used by the Settings
// page to show how many items are in the archive without loading all of them.
// =============================================================================
router.get('/archive/counts', (_req, res) => {
  const racks = db.prepare(`SELECT COUNT(*) as c FROM racks WHERE archived_at IS NOT NULL`).get().c;
  const boxes = db.prepare(`SELECT COUNT(*) as c FROM boxes WHERE archived_at IS NOT NULL`).get().c;
  const vials = db.prepare(`SELECT COUNT(*) as c FROM vials WHERE archived_at IS NOT NULL`).get().c;
  res.json({ racks, boxes, vials, total: racks + boxes + vials });
});


// =============================================================================
// POST /api/archive/restore
// =============================================================================
// Restores a single archived item by clearing its archived_at timestamp.
// Body: { entityType: 'rack'|'box'|'vial', entityId: UUID, changedBy? }
//
// For vials, entityId is the vial's UUID (not the position) because the
// position may have been reoccupied since archiving.
// =============================================================================
router.post('/archive/restore', (req, res) => {
  const { entityType, entityId, changedBy = 'anonymous' } = req.body;

  if (!entityType || !entityId) {
    return res.status(400).json({ error: 'entityType and entityId are required' });
  }

  const tables = { rack: 'racks', box: 'boxes', vial: 'vials' };
  const table  = tables[entityType];
  if (!table) return res.status(400).json({ error: `Unknown entityType: ${entityType}` });

  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND archived_at IS NOT NULL`).get(entityId);
  if (!row) return res.status(404).json({ error: 'Archived item not found' });

  // For vials, check the position still exists (the box may have been made
  // smaller since) and isn't now occupied by another vial
  if (entityType === 'vial') {
    const box = db.prepare('SELECT name, rows, cols, archived_at FROM boxes WHERE id = ?').get(row.box_id);
    if (box && box.archived_at) {
      return res.status(409).json({ error: `Box "${box.name}" is archived — restore the box first` });
    }
    if (box && (row.row_index >= box.rows || row.col_index >= box.cols)) {
      return res.status(409).json({
        error: `Position ${rowLabel(row.row_index)}${colLabel(row.col_index)} is outside box "${box.name}" (now ${box.rows}×${box.cols})`
      });
    }

    const conflict = db.prepare(`
      SELECT id FROM vials
      WHERE box_id = ? AND row_index = ? AND col_index = ? AND archived_at IS NULL
    `).get(row.box_id, row.row_index, row.col_index);

    if (conflict) {
      return res.status(409).json({
        error: `Position ${rowLabel(row.row_index)}${colLabel(row.col_index)} is now occupied by another vial — restore would conflict`
      });
    }
  }

  // Same for boxes: the slot may have been given to another box since, or
  // the rack made smaller.
  if (entityType === 'box') {
    const rack = db.prepare('SELECT name, capacity FROM racks WHERE id = ?').get(row.rack_id);
    if (rack && row.slot_position > rack.capacity) {
      return res.status(409).json({
        error: `Slot ${row.slot_position} no longer exists in rack "${rack.name}" (capacity ${rack.capacity})`
      });
    }

    const conflict = db.prepare(`
      SELECT name FROM boxes
      WHERE rack_id = ? AND slot_position = ? AND archived_at IS NULL
    `).get(row.rack_id, row.slot_position);

    if (conflict) {
      return res.status(409).json({
        error: `Slot ${row.slot_position} is now occupied by box "${conflict.name}" — move or archive that box first`
      });
    }
  }

  try {
    db.prepare(`UPDATE ${table} SET archived_at = NULL WHERE id = ?`).run(entityId);
  } catch (err) {
    // The partial unique indexes catch a place taken between the check above
    // and this update.
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'That position was just taken — please refresh and try again' });
    }
    throw err;
  }

  const restored = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entityId);
  logAudit({ entityType, entityId, entityName: row.name, action: 'restore', changedBy, newData: restored });
  res.json({ restored: true, item: restored });
});


// =============================================================================
// DELETE /api/archive/purge
// =============================================================================
// Permanently deletes archived items — this cannot be undone.
// Query params:
//   ?type=rack|box|vial  — purge only this type (omit to purge all)
//   ?changedBy=name
// =============================================================================
router.delete('/archive/purge', (req, res) => {
  const type      = req.query.type || 'all';
  const changedBy = req.query.changedBy || 'anonymous';
  const counts    = { racks: 0, boxes: 0, vials: 0 };

  const doPurge = db.transaction(() => {
    if (type === 'all' || type === 'vial') {
      counts.vials = db.prepare(`SELECT COUNT(*) as c FROM vials WHERE archived_at IS NOT NULL`).get().c;
      db.prepare(`DELETE FROM vials WHERE archived_at IS NOT NULL`).run();
    }
    if (type === 'all' || type === 'box') {
      counts.boxes = db.prepare(`SELECT COUNT(*) as c FROM boxes WHERE archived_at IS NOT NULL`).get().c;
      db.prepare(`DELETE FROM boxes WHERE archived_at IS NOT NULL`).run();
    }
    if (type === 'all' || type === 'rack') {
      counts.racks = db.prepare(`SELECT COUNT(*) as c FROM racks WHERE archived_at IS NOT NULL`).get().c;
      db.prepare(`DELETE FROM racks WHERE archived_at IS NOT NULL`).run();
    }
  });

  doPurge();

  logAudit({
    entityType: 'system', entityId: 'purge', entityName: 'archive-purge',
    action: 'delete', changedBy,
    context: { type, purged: counts }
  });

  res.json({ purged: true, counts });
});


module.exports = router;
