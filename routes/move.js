// =============================================================================
// routes/move.js — Vial and Box Move Endpoints
// =============================================================================

const express          = require('express');
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

  if (source_box_id === target_box_id && sr === tr && sc === tc){
    return res.status(400).json({ error: 'Source and target positions are the same' });
  }

  // ── Validate target box bounds (outside transaction — read-only) ───────────
  const targetBox = db.prepare(`SELECT * FROM boxes WHERE id = ? AND archived_at IS NULL`).get(target_box_id);
  if (!targetBox) return res.status(404).json({ error: 'Target box not found' });
  if (tr < 0 || tr >= targetBox.rows || tc < 0 || tc >= targetBox.cols){
    return res.status(400).json({
      error: `Position ${rowLabel(tr)}${colLabel(tc)} is out of bounds for ${targetBox.rows}×${targetBox.cols} box "${targetBox.name}"`
    });
  }

  // ── Pre-fetch names for audit log (read-only) ─────────────────────────────
  const sourceBox  = db.prepare(`SELECT * FROM boxes WHERE id = ?`).get(source_box_id);
  const sourceRack = sourceBox  ? db.prepare(`SELECT name FROM racks WHERE id = ?`).get(sourceBox.rack_id)  : null;
  const targetRack = db.prepare(`SELECT name FROM racks WHERE id = ?`).get(targetBox.rack_id);

  // ── Atomic check-then-move ────────────────────────────────────────────────
  // The transaction ensures the occupancy check and the UPDATE happen as one
  // unit — no concurrent request can claim the target position in between.
  try {
    const result = db.transaction(() => {
      const vial = db.prepare(`
        SELECT * FROM vials
        WHERE box_id = ? AND row_index = ? AND col_index = ? AND archived_at IS NULL
      `).get(source_box_id, sr, sc);
      if (!vial) return { error: 'No vial at source position', status: 404 };

      const occupant = db.prepare(`
        SELECT id, name FROM vials
        WHERE box_id = ? AND row_index = ? AND col_index = ? AND archived_at IS NULL
      `).get(target_box_id, tr, tc);
      if (occupant) return {
        error: `Target position ${rowLabel(tr)}${colLabel(tc)} is already occupied by "${occupant.name}"`,
        status: 409
      };

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE vials
        SET box_id = ?, row_index = ?, col_index = ?, updated_at = ?
        WHERE box_id = ? AND row_index = ? AND col_index = ?
      `).run(target_box_id, tr, tc, now, source_box_id, sr, sc);

      const moved = db.prepare(`SELECT * FROM vials WHERE id = ?`).get(vial.id);

      const oldCtx = {
        box_id: source_box_id, box_name: sourceBox?.name,
        rack_name: sourceRack?.name,
        row: sr, col: sc, position: `${rowLabel(sr)}${colLabel(sc)}`
      };
      const newCtx = {
        box_id: target_box_id, box_name: targetBox.name,
        rack_name: targetRack?.name,
        row: tr, col: tc, position: `${rowLabel(tr)}${colLabel(tc)}`
      };

      logAudit({
        entityType: 'vial', entityId: vial.id, entityName: vial.name,
        action: 'move', changedBy,
        oldData: { ...vial, ...oldCtx },
        newData: { ...moved, ...newCtx },
        context: { from: oldCtx, to: newCtx }
      });

      return { ok: true, moved, from: oldCtx, to: newCtx };
    })();

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ moved: true, vial: result.moved, from: result.from, to: result.to });

  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Target position was just taken by another request — please refresh and try again' });
    }
    throw err;
  }
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

  const box = db.prepare(`SELECT * FROM boxes WHERE id = ? AND archived_at IS NULL`).get(req.params.id);
  if (!box) return res.status(404).json({ error: 'Box not found' });

  if (box.rack_id === target_rack_id && box.slot_position === slot){
    return res.status(400).json({ error: 'Source and target locations are the same' });
  }

  const targetRack = db.prepare(`SELECT * FROM racks WHERE id = ? AND archived_at IS NULL`).get(target_rack_id);
  if (!targetRack) return res.status(404).json({ error: 'Target rack not found' });

  if (slot < 1 || slot > targetRack.capacity){
    return res.status(400).json({
      error: `Slot ${slot} is out of range for rack "${targetRack.name}" (capacity ${targetRack.capacity})`
    });
  }

  const sourceRack = db.prepare(`SELECT name FROM racks WHERE id = ?`).get(box.rack_id);

  // ── Atomic check-then-move ────────────────────────────────────────────────
  try {
    const result = db.transaction(() => {
      const occupant = db.prepare(`
        SELECT id, name FROM boxes
        WHERE rack_id = ? AND slot_position = ? AND archived_at IS NULL AND id != ?
      `).get(target_rack_id, slot, req.params.id);
      if (occupant) return {
        error: `Slot ${slot} in "${targetRack.name}" is already occupied by box "${occupant.name}"`,
        status: 409
      };

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE boxes SET rack_id = ?, slot_position = ?, updated_at = ? WHERE id = ?
      `).run(target_rack_id, slot, now, req.params.id);

      const moved   = db.prepare(`SELECT * FROM boxes WHERE id = ?`).get(req.params.id);
      const fromCtx = { rack_id: box.rack_id, rack_name: sourceRack?.name, slot: box.slot_position };
      const toCtx   = { rack_id: target_rack_id, rack_name: targetRack.name, slot };

      logAudit({
        entityType: 'box', entityId: box.id, entityName: box.name,
        action: 'move', changedBy,
        oldData: { ...box, ...fromCtx },
        newData: { ...moved, ...toCtx },
        context: { from: fromCtx, to: toCtx }
      });

      return { ok: true, moved, from: fromCtx, to: toCtx };
    })();

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ moved: true, box: result.moved, from: result.from, to: result.to });

  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'That slot was just taken by another request — please refresh and try again' });
    }
    throw err;
  }
});


module.exports = router;


// =============================================================================
// POST /api/racks/:id/move
// =============================================================================
// Move a rack to a different tank.
// Body: { target_tank_id, changedBy? }
// The rack keeps all its boxes, slots, and vials — only tank_id changes.
// =============================================================================
router.post('/racks/:id/move', (req, res) => {
  const { target_tank_id, changedBy = 'anonymous' } = req.body;

  if (!target_tank_id) {
    return res.status(400).json({ error: 'target_tank_id is required' });
  }

  const rack = db.prepare(`SELECT * FROM racks WHERE id = ? AND archived_at IS NULL`).get(req.params.id);
  if (!rack) return res.status(404).json({ error: 'Rack not found' });

  if (rack.tank_id === target_tank_id) {
    return res.status(400).json({ error: 'Rack is already in that tank' });
  }

  const targetTank = db.prepare(`SELECT * FROM tanks WHERE id = ?`).get(target_tank_id);
  if (!targetTank) return res.status(404).json({ error: 'Target tank not found' });

  const sourceTank = db.prepare(`SELECT * FROM tanks WHERE id = ?`).get(rack.tank_id);

  const now = new Date().toISOString();

  db.prepare(`UPDATE racks SET tank_id = ?, updated_at = ? WHERE id = ?`)
    .run(target_tank_id, now, rack.id);

  const moved = db.prepare(`SELECT * FROM racks WHERE id = ?`).get(rack.id);

  logAudit({
    entityType: 'rack', entityId: rack.id, entityName: rack.name,
    action: 'move', changedBy,
    oldData: { ...rack, tank_name: sourceTank?.name },
    newData: { ...moved, tank_name: targetTank.name },
    context: {
      from: { tank_id: rack.tank_id, tank_name: sourceTank?.name },
      to:   { tank_id: target_tank_id, tank_name: targetTank.name }
    }
  });

  res.json({ moved: true, rack: moved, from: sourceTank?.name, to: targetTank.name });
});
