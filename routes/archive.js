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
// Returns all archived racks, boxes, and vials, with their location context.
// Optional query params:
//   ?type=rack|box|vial   — filter to one entity type
//   ?q=search             — substring search on name
// =============================================================================
router.get('/archive', (req, res) => {
  const type    = req.query.type || '';
  const q       = (req.query.q || '').trim();
  const pattern = q ? `%${q}%` : '%';

  const results = { racks: [], boxes: [], vials: [] };

  if (!type || type === 'rack') {
    results.racks = db.prepare(`
      SELECT r.*, t.name AS tank_name
      FROM   racks r
      JOIN   tanks t ON t.id = r.tank_id
      WHERE  r.archived_at IS NOT NULL
        AND  r.name LIKE ?
      ORDER  BY r.archived_at DESC
    `).all(pattern);
  }

  if (!type || type === 'box') {
    results.boxes = db.prepare(`
      SELECT b.*, r.name AS rack_name, r.id AS rack_id_fk
      FROM   boxes b
      JOIN   racks r ON r.id = b.rack_id
      WHERE  b.archived_at IS NOT NULL
        AND  b.name LIKE ?
      ORDER  BY b.archived_at DESC
    `).all(pattern);
  }

  if (!type || type === 'vial') {
    const vials = db.prepare(`
      SELECT v.*,
             b.name AS box_name, b.id AS box_id_fk, b.slot_position AS box_slot,
             r.name AS rack_name, r.id AS rack_id_fk
      FROM   vials v
      JOIN   boxes b ON b.id = v.box_id
      JOIN   racks r ON r.id = b.rack_id
      WHERE  v.archived_at IS NOT NULL
        AND  (v.name LIKE ? OR v.researcher LIKE ? OR v.sample_type LIKE ?)
      ORDER  BY v.archived_at DESC
    `).all(pattern, pattern, pattern);

    results.vials = vials.map(v => ({
      ...v,
      row_label:      rowLabel(v.row_index),
      col_label:      colLabel(v.col_index),
      position_label: `${rowLabel(v.row_index)}${colLabel(v.col_index)}`,
      path: `${v.rack_name} › Slot ${v.box_slot} › ${v.box_name} › ${rowLabel(v.row_index)}${colLabel(v.col_index)}`
    }));
  }

  const total = results.racks.length + results.boxes.length + results.vials.length;
  res.json({ total, results });
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

  // For vials, check the position isn't now occupied by another vial
  if (entityType === 'vial') {
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

  db.prepare(`UPDATE ${table} SET archived_at = NULL WHERE id = ?`).run(entityId);

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
