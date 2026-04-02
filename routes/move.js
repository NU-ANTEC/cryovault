// =============================================================================
// routes/move.js — Vial and Box Move Endpoints
// =============================================================================
//
// ENDPOINTS
//   POST /api/vials/move
//     Move a single vial from one position to another.
//     Source and target can be in different boxes, racks, or tanks.
//     Body: { source_box_id, source_row, source_col,
//             target_box_id, target_row, target_col, changedBy? }
//
//   POST /api/boxes/:id/move
//     Move a box to a different rack slot.
//     Source and target can be in different racks or tanks.
//     Body: { target_rack_id, target_slot, changedBy? }
//
// VALIDATION
//   Both endpoints reject moves to already-occupied positions (HTTP 409).
//   Box moves also validate that target_slot <= target rack's capacity.
//   Vial moves validate that target position is within the target box's grid.
//
// AUDIT
//   Both operations write an audit_log entry with action='move' and a context
//   object that records both the source and target locations.
// =============================================================================

const express        = require('express');
const { db, logAudit } = require('../db');

const router = express.Router();

const rowLabel = i => String.fromCharCode(65 + i);
const colLabel = i => String(i + 1).padStart(2, '0');


// =============================================================================
// POST /api/vials/move
// =============================================================================
router.post('/vials/move', (req, res) => {
  const {
    source_box_id, source_row, source_col,
    target_box_id, target_row, target_col,
    changedBy = 'anonymous'
  } = req.body;

  const sr = parseInt(source_row, 10), sc = parseInt(source_col, 10);
  const tr = parseInt(target_row, 10), tc = parseInt(target_col, 10);

  if (!source_box_id || !target_box_id ||
      isNaN(sr) || isNaN(sc) || isNaN(tr) || isNaN(tc)){
    return res.status(400).json({ error: 'source_box_id, source_row, source_col, target_box_id, target_row, target_col are all required' });
  }

  // ── Fetch source vial ─────────────────────────────────────────────────────
  const vial = db.prepare(`
    SELECT * FROM vials
    WHERE box_id = ? AND row_index = ? AND col_index = ? AND archived_at IS NULL
  `).get(source_box_id, sr, sc);
  if (!vial) return res.status(404).json({ error: 'No vial at source position' });

  // ── Fetch target box and validate bounds ──────────────────────────────────
  const targetBox = db.prepare(`SELECT * FROM boxes WHERE id = ? AND archived_at IS NULL`).get(target_box_id);
  if (!targetBox) return res.status(404).json({ error: 'Target box not found' });

  if (tr < 0 || tr >= targetBox.rows || tc < 0 || tc >= targetBox.cols){
    return res.status(400).json({
      error: `Position ${rowLabel(tr)}${colLabel(tc)} is out of bounds for ${targetBox.rows}×${targetBox.cols} box "${targetBox.name}"`
    });
  }

  // ── Check target position is empty ────────────────────────────────────────
  // Allow move to the same position only if same box (no-op; rejected cleanly)
  if (source_box_id === target_box_id && sr === tr && sc === tc){
    return res.status(400).json({ error: 'Source and target positions are the same' });
  }

  const occupant = db.prepare(`
    SELECT id, name FROM vials
    WHERE box_id = ? AND row_index = ? AND col_index = ? AND archived_at IS NULL
  `).get(target_box_id, tr, tc);
  if (occupant){
    return res.status(409).json({
      error: `Target position ${rowLabel(tr)}${colLabel(tc)} is already occupied by "${occupant.name}"`
    });
  }

  // ── Build location context for the audit log ──────────────────────────────
  const sourceBox  = db.prepare(`SELECT * FROM boxes WHERE id = ?`).get(source_box_id);
  const sourceRack = sourceBox ? db.prepare(`SELECT name FROM racks WHERE id = ?`).get(sourceBox.rack_id) : null;
  const targetRack = targetBox ? db.prepare(`SELECT name FROM racks WHERE id = ?`).get(targetBox.rack_id) : null;

  const oldContext = {
    box_id:   source_box_id, box_name: sourceBox?.name,
    rack_name: sourceRack?.name,
    row: sr, col: sc, position: `${rowLabel(sr)}${colLabel(sc)}`
  };
  const newContext = {
    box_id:   target_box_id, box_name: targetBox.name,
    rack_name: targetRack?.name,
    row: tr, col: tc, position: `${rowLabel(tr)}${colLabel(tc)}`
  };

  // ── Perform the move ──────────────────────────────────────────────────────
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE vials
    SET box_id = ?, row_index = ?, col_index = ?, updated_at = ?
    WHERE box_id = ? AND row_index = ? AND col_index = ?
  `).run(target_box_id, tr, tc, now, source_box_id, sr, sc);

  const moved = db.prepare(`SELECT * FROM vials WHERE id = ?`).get(vial.id);

  logAudit({
    entityType: 'vial', entityId: vial.id, entityName: vial.name,
    action: 'move', changedBy,
    oldData: { ...vial, ...oldContext },
    newData: { ...moved, ...newContext },
    context: { from: oldContext, to: newContext }
  });

  res.json({ moved: true, vial: moved, from: oldContext, to: newContext });
});


// =============================================================================
// POST /api/boxes/:id/move
// =============================================================================
router.post('/boxes/:id/move', (req, res) => {
  const { target_rack_id, target_slot, changedBy = 'anonymous' } = req.body;
  const slot = parseInt(target_slot, 10);

  if (!target_rack_id || isNaN(slot)){
    return res.status(400).json({ error: 'target_rack_id and target_slot are required' });
  }

  // ── Fetch box ─────────────────────────────────────────────────────────────
  const box = db.prepare(`SELECT * FROM boxes WHERE id = ? AND archived_at IS NULL`).get(req.params.id);
  if (!box) return res.status(404).json({ error: 'Box not found' });

  // ── Same location? ────────────────────────────────────────────────────────
  if (box.rack_id === target_rack_id && box.slot_position === slot){
    return res.status(400).json({ error: 'Source and target locations are the same' });
  }

  // ── Fetch target rack and validate slot ───────────────────────────────────
  const targetRack = db.prepare(`SELECT * FROM racks WHERE id = ? AND archived_at IS NULL`).get(target_rack_id);
  if (!targetRack) return res.status(404).json({ error: 'Target rack not found' });

  if (slot < 1 || slot > targetRack.capacity){
    return res.status(400).json({
      error: `Slot ${slot} is out of range for rack "${targetRack.name}" (capacity ${targetRack.capacity})`
    });
  }

  // ── Check target slot is empty ────────────────────────────────────────────
  const occupant = db.prepare(`
    SELECT id, name FROM boxes
    WHERE rack_id = ? AND slot_position = ? AND archived_at IS NULL AND id != ?
  `).get(target_rack_id, slot, req.params.id);
  if (occupant){
    return res.status(409).json({
      error: `Slot ${slot} in "${targetRack.name}" is already occupied by box "${occupant.name}"`
    });
  }

  // ── Build audit context ───────────────────────────────────────────────────
  const sourceRack = db.prepare(`SELECT name FROM racks WHERE id = ?`).get(box.rack_id);
  const fromCtx = { rack_id: box.rack_id, rack_name: sourceRack?.name, slot: box.slot_position };
  const toCtx   = { rack_id: target_rack_id, rack_name: targetRack.name, slot };

  // ── Perform the move ──────────────────────────────────────────────────────
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE boxes SET rack_id = ?, slot_position = ?, updated_at = ? WHERE id = ?
  `).run(target_rack_id, slot, now, req.params.id);

  const moved = db.prepare(`SELECT * FROM boxes WHERE id = ?`).get(req.params.id);

  logAudit({
    entityType: 'box', entityId: box.id, entityName: box.name,
    action: 'move', changedBy,
    oldData: { ...box, ...fromCtx },
    newData: { ...moved, ...toCtx },
    context: { from: fromCtx, to: toCtx }
  });

  res.json({ moved: true, box: moved, from: fromCtx, to: toCtx });
});


module.exports = router;
