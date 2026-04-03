// =============================================================================
// routes/boxes.js — Box CRUD Endpoints
// =============================================================================
//
// CHANGE LOG (slot_position feature)
// ------------------------------------
// • POST /api/racks/:rackId/boxes — now requires "slot_position".
//   Validation:
//     1. slot_position must be an integer in [1, rack.capacity]
//     2. No other box in the same rack may already occupy that slot
//        (checked in application code first; UNIQUE constraint is the DB guard)
//
// • PUT /api/boxes/:id — slot_position may be updated (moves the box to a
//   different physical slot). The same two validations apply, with an extra
//   rule: a box is not considered to be "blocking" its own current slot when
//   checking for conflicts (you can PUT back to the same position without error).
//
// • GET /api/racks/:rackId/boxes — unchanged in shape; slot_position is
//   included automatically via SELECT *.
//
// SLOT CONFLICT RESPONSE
//   When a slot is already occupied the server returns HTTP 409 Conflict
//   (not 400 Bad Request) because the value itself is valid — it is the
//   current state of the database that makes it unacceptable. The response
//   body identifies the box that is currently at that slot so the client
//   can show a specific error message.
// =============================================================================

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, logAudit } = require('../db');

const router = express.Router();

const MAX_ROWS = 26;
const MAX_COLS = 30;

function validateGridDims(rows, cols) {
  const r = parseInt(rows, 10);
  const c = parseInt(cols, 10);
  if (!Number.isInteger(r) || r < 1 || r > MAX_ROWS)
    return `rows must be an integer between 1 and ${MAX_ROWS}`;
  if (!Number.isInteger(c) || c < 1 || c > MAX_COLS)
    return `cols must be an integer between 1 and ${MAX_COLS}`;
  return null;
}

// =============================================================================
// Shared slot validation helper
// =============================================================================
// Checks that slot_position is:
//   (a) a valid integer within [1, rack.capacity]
//   (b) not already occupied by a different box in the same rack
//
// Parameters:
//   rackId        — rack to check against
//   slotPosition  — the proposed integer position
//   excludeBoxId  — (optional) UUID of the box being updated; its current
//                   slot is excluded from the conflict check so a PUT that
//                   doesn't change the position succeeds without a false conflict
//
// Returns: { ok: true } or { ok: false, status: HTTP_CODE, error: MESSAGE }
// =============================================================================
function validateSlot(rackId, slotPosition, excludeBoxId = null) {
  // ── Check the rack exists and read its capacity ───────────────────────────
  const rack = db.prepare('SELECT id, capacity FROM racks WHERE id = ?').get(rackId);
  if (!rack) return { ok: false, status: 404, error: 'Rack not found' };

  // ── Range check ───────────────────────────────────────────────────────────
  const pos = parseInt(slotPosition, 10);
  if (!Number.isInteger(pos) || pos < 1 || pos > rack.capacity) {
    return {
      ok: false, status: 400,
      error: `slot_position must be an integer between 1 and ${rack.capacity} (rack capacity)`
    };
  }

  // ── Occupancy check ───────────────────────────────────────────────────────
  // Look for any box in this rack already at this position, optionally
  // excluding the box being updated (so a no-op position update is allowed).
  let occupant;
  if (excludeBoxId) {
    occupant = db.prepare(`
      SELECT id, name FROM boxes
      WHERE  rack_id = ? AND slot_position = ? AND id != ?
    `).get(rackId, pos, excludeBoxId);
  } else {
    occupant = db.prepare(`
      SELECT id, name FROM boxes
      WHERE  rack_id = ? AND slot_position = ?
    `).get(rackId, pos);
  }

  if (occupant) {
    return {
      ok: false, status: 409,
      error: `Slot ${pos} is already occupied by box "${occupant.name}" (id: ${occupant.id})`
    };
  }

  return { ok: true, pos, rack };
}


// =============================================================================
// GET /api/racks/:rackId/boxes
// Returns all boxes in a rack, ordered by slot_position (physical order top→bottom).
// =============================================================================
router.get('/racks/:rackId/boxes', (req, res) => {
  const boxes = db.prepare(`
    SELECT * FROM boxes
    WHERE  rack_id = ? AND archived_at IS NULL
    ORDER  BY slot_position
  `).all(req.params.rackId);
  res.json(boxes);
});


// =============================================================================
// GET /api/boxes/:id
// =============================================================================
router.get('/boxes/:id', (req, res) => {
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ error: 'Box not found' });
  res.json(box);
});


// =============================================================================
// POST /api/racks/:rackId/boxes
// Creates a new box at a specific physical slot in the rack.
//
// Required body fields:
//   name           TEXT   — box label (e.g. "BOX-001")
//   slot_position  INT    — physical slot from the top (1 = topmost)
//   rows           INT    — grid rows (1–26)
//   cols           INT    — grid cols (1–30)
//
// Optional body fields:
//   qr_code, notes, changedBy
//
// Returns HTTP 201 with the created box, or:
//   400 — missing/invalid fields
//   404 — rack not found
//   409 — slot already occupied
// =============================================================================
router.post('/racks/:rackId/boxes', (req, res) => {
  const {
    name,
    slot_position,
    rows,
    cols,
    qr_code   = null,
    notes     = '',
    changedBy = 'anonymous'
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: '"name" is required' });
  }
  if (slot_position === undefined || slot_position === null) {
    return res.status(400).json({ error: '"slot_position" is required' });
  }

  const dimError = validateGridDims(rows, cols);
  if (dimError) return res.status(400).json({ error: dimError });

  const id  = uuidv4();
  const now = new Date().toISOString();

  // Wrap validate-then-insert in a transaction so concurrent requests to the
  // same slot cannot both pass the occupancy check and both insert.
  try {
    const insert = db.transaction(() => {
      const slotCheck = validateSlot(req.params.rackId, slot_position);
      if (!slotCheck.ok) return { error: slotCheck.error, status: slotCheck.status };

      db.prepare(`
        INSERT INTO boxes
          (id, rack_id, name, slot_position, rows, cols, qr_code, notes, created_at, updated_at)
        VALUES
          (?,  ?,       ?,    ?,             ?,    ?,    ?,       ?,     ?,          ?)
      `).run(
        id, req.params.rackId, name.trim(), slotCheck.pos,
        parseInt(rows, 10), parseInt(cols, 10),
        qr_code || null, notes, now, now
      );

      return { ok: true, pos: slotCheck.pos };
    });

    const result = insert();
    if (result.error) return res.status(result.status).json({ error: result.error });

    const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(id);
    logAudit({
      entityType: 'box', entityId: id, entityName: box.name,
      action: 'create', changedBy, newData: box,
      context: { rack_id: req.params.rackId, slot_position: result.pos }
    });

    res.status(201).json(box);

  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'That slot was just taken by another request — please refresh and try again' });
    }
    throw err;
  }
});


// =============================================================================
// PUT /api/boxes/:id
// Updates box metadata. Supports partial updates.
//
// MOVING A BOX (changing slot_position)
//   Provide a new slot_position value. The same validation as POST applies,
//   except that the box's current slot is excluded from the conflict check
//   (so sending the same slot_position as before is a no-op, not an error).
//
// GRID RESIZE
//   If rows or cols shrink, vials outside the new bounds are deleted.
//   The response includes a `warning` field if any vials were removed.
// =============================================================================
router.put('/boxes/:id', (req, res) => {
  const { name, slot_position, rows, cols, qr_code, notes, changedBy = 'anonymous' } = req.body;

  const existing = db.prepare('SELECT * FROM boxes WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Box not found' });

  // ── Slot position update ───────────────────────────────────────────────────
  let newSlotPos = existing.slot_position;
  if (slot_position !== undefined && slot_position !== null) {
    // Pass existing.id as excludeBoxId so the box's own current slot
    // is not treated as an occupancy conflict.
    const slotCheck = validateSlot(existing.rack_id, slot_position, existing.id);
    if (!slotCheck.ok) return res.status(slotCheck.status).json({ error: slotCheck.error });
    newSlotPos = slotCheck.pos;
  }

  // ── Grid dimension update ─────────────────────────────────────────────────
  const newRows = rows !== undefined ? parseInt(rows, 10) : existing.rows;
  const newCols = cols !== undefined ? parseInt(cols, 10) : existing.cols;
  const dimError = validateGridDims(newRows, newCols);
  if (dimError) return res.status(400).json({ error: dimError });

  // Delete vials that fall outside the new grid bounds
  let deletedVials = 0;
  if (newRows < existing.rows || newCols < existing.cols) {
    const count = db.prepare(`
      SELECT COUNT(*) as c FROM vials
      WHERE  box_id = ? AND (row_index >= ? OR col_index >= ?)
    `).get(req.params.id, newRows, newCols).c;

    if (count > 0) {
      db.prepare(`
        DELETE FROM vials
        WHERE  box_id = ? AND (row_index >= ? OR col_index >= ?)
      `).run(req.params.id, newRows, newCols);
      deletedVials = count;
    }
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE boxes
    SET    name = ?, slot_position = ?, rows = ?, cols = ?,
           qr_code = ?, notes = ?, updated_at = ?
    WHERE  id = ?
  `).run(
    name     ?? existing.name,
    newSlotPos,
    newRows, newCols,
    qr_code !== undefined ? (qr_code || null) : existing.qr_code,
    notes    ?? existing.notes,
    now,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM boxes WHERE id = ?').get(req.params.id);

  logAudit({
    entityType: 'box', entityId: updated.id, entityName: updated.name,
    action: 'update', changedBy, oldData: existing, newData: updated,
    context: {
      slot_moved:   newSlotPos !== existing.slot_position,
      deleted_vials: deletedVials
    }
  });

  res.json({
    ...updated,
    ...(deletedVials > 0 ? { warning: `${deletedVials} vial(s) removed — grid was shrunk` } : {})
  });
});


// =============================================================================
// DELETE /api/boxes/:id
// Deletes the box. SQLite CASCADE removes all its vials automatically.
// =============================================================================
router.delete('/boxes/:id', (req, res) => {
  const changedBy = req.query.changedBy || 'anonymous';
  const archive   = req.query.archive === 'true';

  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(req.params.id);
  if (!box) return res.status(404).json({ error: 'Box not found' });

  const vialCount = db.prepare('SELECT COUNT(*) as c FROM vials WHERE box_id = ? AND archived_at IS NULL').get(req.params.id).c;

  if (archive) {
    const now = new Date().toISOString();
    db.prepare(`UPDATE boxes SET archived_at = ? WHERE id = ?`).run(now, req.params.id);
    // Also archive all vials inside the box
    db.prepare(`UPDATE vials SET archived_at = ? WHERE box_id = ? AND archived_at IS NULL`).run(now, req.params.id);
    logAudit({ entityType:'box', entityId:box.id, entityName:box.name, action:'archive', changedBy, oldData:box, context:{ slot_position:box.slot_position, vials_archived:vialCount } });
    return res.json({ archived: true, id: req.params.id, vials_archived: vialCount });
  }

  logAudit({ entityType:'box', entityId:box.id, entityName:box.name, action:'delete', changedBy, oldData:box, context:{ slot_position:box.slot_position, vials_deleted:vialCount } });
  db.prepare('DELETE FROM boxes WHERE id = ?').run(req.params.id);
  res.json({ deleted: true, id: req.params.id, vials_deleted: vialCount });
});


module.exports = router;
