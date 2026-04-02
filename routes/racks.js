// =============================================================================
// routes/racks.js — Rack CRUD Endpoints
// =============================================================================
//
// CHANGE LOG (slot_position feature)
// ------------------------------------
// • POST /api/tanks/:tankId/racks — now requires "capacity" (integer ≥ 1).
//   capacity defines how many physical box slots this rack has.
//
// • PUT /api/racks/:id — capacity may be updated, with one guard:
//   The new capacity must be ≥ the highest slot_position currently occupied
//   by a box in this rack. Shrinking below an occupied slot is rejected
//   (HTTP 409 Conflict) to avoid creating boxes with invalid positions.
//
// • GET endpoints — capacity is included in all rack responses automatically
//   because we SELECT * from the racks table.
//
// CAPACITY VALIDATION LIMITS
//   MIN_CAPACITY = 1    — a rack with zero slots makes no physical sense
//   MAX_CAPACITY = 100  — practical upper bound; adjust if your equipment
//                         uses unusually large racks
// =============================================================================

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, logAudit } = require('../db');

const router = express.Router();

// Practical limits on rack capacity (number of box slots).
// These are application-level guards; the schema itself has no upper bound.
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 100;


// =============================================================================
// GET /api/tanks/:tankId/racks
// Returns all racks in the tank, ordered by name.
// Each rack object includes: id, tank_id, name, position, capacity, notes,
// created_at, updated_at.
// =============================================================================
router.get('/tanks/:tankId/racks', (req, res) => {
  const racks = db.prepare(`
    SELECT * FROM racks
    WHERE  tank_id = ? AND archived_at IS NULL
    ORDER  BY name
  `).all(req.params.tankId);
  res.json(racks);
});


// =============================================================================
// GET /api/racks/:id
// Returns a single rack by its UUID.
// =============================================================================
router.get('/racks/:id', (req, res) => {
  const rack = db.prepare('SELECT * FROM racks WHERE id = ?').get(req.params.id);
  if (!rack) return res.status(404).json({ error: 'Rack not found' });
  res.json(rack);
});


// =============================================================================
// POST /api/tanks/:tankId/racks
// Creates a new rack inside the specified tank.
//
// Required body fields:
//   name       TEXT   — human label for the rack (e.g. "RACK-01")
//   capacity   INT    — number of physical box slots (1–100)
//
// Optional body fields:
//   position   TEXT   — location descriptor in the tank (e.g. "Slot A")
//   notes      TEXT
//   changedBy  TEXT   — researcher name for the audit log
//
// Returns: the newly created rack row (HTTP 201)
// =============================================================================
router.post('/tanks/:tankId/racks', (req, res) => {
  const {
    name,
    capacity,
    position  = '',
    notes     = '',
    changedBy = 'anonymous'
  } = req.body;

  // ── Validate required fields ──────────────────────────────────────────────
  if (!name || !name.trim()) {
    return res.status(400).json({ error: '"name" is required' });
  }

  // capacity must be provided — there is no sensible universal default
  // because rack sizes vary widely between manufacturers.
  const numCapacity = parseInt(capacity, 10);
  if (isNaN(numCapacity) || numCapacity < MIN_CAPACITY || numCapacity > MAX_CAPACITY) {
    return res.status(400).json({
      error: `"capacity" must be an integer between ${MIN_CAPACITY} and ${MAX_CAPACITY}`
    });
  }

  const tank = db.prepare('SELECT id FROM tanks WHERE id = ?').get(req.params.tankId);
  if (!tank) return res.status(404).json({ error: 'Tank not found' });

  const id  = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO racks (id, tank_id, name, position, capacity, notes, created_at, updated_at)
    VALUES             (?,  ?,       ?,    ?,         ?,        ?,     ?,          ?)
  `).run(id, req.params.tankId, name.trim(), position, numCapacity, notes, now, now);

  const rack = db.prepare('SELECT * FROM racks WHERE id = ?').get(id);

  logAudit({
    entityType: 'rack', entityId: id, entityName: rack.name,
    action: 'create', changedBy, newData: rack
  });

  res.status(201).json(rack);
});


// =============================================================================
// PUT /api/racks/:id
// Updates rack metadata. Supports partial updates (only send the fields
// you want to change).
//
// CAPACITY REDUCTION GUARD
//   If the new capacity is smaller than the current one, we check whether
//   any box in this rack sits at a slot_position > new capacity. If so,
//   the update is rejected with HTTP 409 (Conflict) and the response body
//   lists the conflicting slot numbers so the operator knows what to move first.
//
//   Example: rack has capacity=10, boxes at slots 1, 3, 8.
//   Trying to set capacity=6 is fine (slot 8 > 6? yes → rejected).
//   Trying to set capacity=9 is fine (slot 8 ≤ 9 → accepted).
// =============================================================================
router.put('/racks/:id', (req, res) => {
  const { name, position, capacity, notes, changedBy = 'anonymous' } = req.body;

  const existing = db.prepare('SELECT * FROM racks WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Rack not found' });

  // Determine the new capacity value (keep existing if not provided)
  let newCapacity = existing.capacity;
  if (capacity !== undefined) {
    newCapacity = parseInt(capacity, 10);
    if (isNaN(newCapacity) || newCapacity < MIN_CAPACITY || newCapacity > MAX_CAPACITY) {
      return res.status(400).json({
        error: `"capacity" must be an integer between ${MIN_CAPACITY} and ${MAX_CAPACITY}`
      });
    }
  }

  // ── Capacity reduction guard ───────────────────────────────────────────────
  // Only perform this check when capacity is actually being reduced.
  if (newCapacity < existing.capacity) {
    // Find boxes whose slot_position would be out of range after the update.
    const blockers = db.prepare(`
      SELECT slot_position, name
      FROM   boxes
      WHERE  rack_id       = ?
        AND  slot_position > ?
      ORDER  BY slot_position
    `).all(req.params.id, newCapacity);

    if (blockers.length > 0) {
      // Return a 409 Conflict with enough detail for the client to act on.
      return res.status(409).json({
        error: 'Cannot reduce capacity: boxes occupy slots that would be removed',
        conflicting_slots: blockers.map(b => ({
          slot: b.slot_position,
          box_name: b.name
        }))
      });
    }
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE racks
    SET    name = ?, position = ?, capacity = ?, notes = ?, updated_at = ?
    WHERE  id = ?
  `).run(
    name     ?? existing.name,
    position ?? existing.position,
    newCapacity,
    notes    ?? existing.notes,
    now,
    req.params.id
  );

  const updated = db.prepare('SELECT * FROM racks WHERE id = ?').get(req.params.id);

  logAudit({
    entityType: 'rack', entityId: updated.id, entityName: updated.name,
    action: 'update', changedBy, oldData: existing, newData: updated
  });

  res.json(updated);
});


// =============================================================================
// DELETE /api/racks/:id
// Deletes a rack and — via ON DELETE CASCADE — all its boxes and vials.
// changedBy comes from a query parameter because DELETE has no body.
// =============================================================================
router.delete('/racks/:id', (req, res) => {
  const changedBy = req.query.changedBy || 'anonymous';
  const archive   = req.query.archive === 'true';

  const rack = db.prepare('SELECT * FROM racks WHERE id = ?').get(req.params.id);
  if (!rack) return res.status(404).json({ error: 'Rack not found' });

  if (archive) {
    // Soft-delete: stamp archived_at, leave the row in place
    const now = new Date().toISOString();
    db.prepare(`UPDATE racks SET archived_at = ? WHERE id = ?`).run(now, req.params.id);
    logAudit({ entityType:'rack', entityId:rack.id, entityName:rack.name, action:'archive', changedBy, oldData:rack });
    return res.json({ archived: true, id: req.params.id });
  }

  logAudit({ entityType:'rack', entityId:rack.id, entityName:rack.name, action:'delete', changedBy, oldData:rack });
  db.prepare('DELETE FROM racks WHERE id = ?').run(req.params.id);
  res.json({ deleted: true, id: req.params.id });
});


// =============================================================================
// GET /api/racks/:id/slots
// =============================================================================
// Returns a complete slot manifest for a rack: an array of `capacity` entries,
// one per physical slot, each indicating whether it is occupied or empty.
//
// Response shape:
//   {
//     rack: { id, name, capacity, … },
//     slots: [
//       { slot_position: 1, occupied: true,  box: { id, name, rows, cols, … } },
//       { slot_position: 2, occupied: false, box: null },
//       …
//     ]
//   }
//
// WHY A DEDICATED ENDPOINT?
//   The rack view must always show ALL slots (occupied and empty) so the
//   operator can see at a glance which positions are free. Returning a sparse
//   list of only occupied boxes would require the frontend to fill the gaps
//   itself — error-prone and awkward. This endpoint does that assembly once
//   on the server and returns a clean, dense array indexed by physical position.
// =============================================================================
router.get('/racks/:id/slots', (req, res) => {
  const rack = db.prepare('SELECT * FROM racks WHERE id = ?').get(req.params.id);
  if (!rack) return res.status(404).json({ error: 'Rack not found' });

  // Fetch all boxes in this rack keyed by their slot position.
  // We select box metadata plus a derived vial count so the slot card
  // can display occupancy without a separate round-trip.
  const boxRows = db.prepare(`
    SELECT
      b.*,
      COUNT(v.id) AS vial_count
    FROM      boxes b
    LEFT JOIN vials v ON v.box_id = b.id
    WHERE     b.rack_id = ?
    GROUP BY  b.id
    ORDER BY  b.slot_position
  `).all(rack.id);

  // Index boxes by their slot_position for O(1) lookup below.
  const boxBySlot = {};
  for (const box of boxRows) {
    boxBySlot[box.slot_position] = box;
  }

  // Build the full slot array. Every integer from 1 to capacity gets an entry
  // regardless of whether a box is there.
  const slots = [];
  for (let pos = 1; pos <= rack.capacity; pos++) {
    const box = boxBySlot[pos] || null;
    slots.push({
      slot_position: pos,
      occupied:      box !== null,
      box            // null for empty slots, full box object for occupied slots
    });
  }

  res.json({ rack, slots });
});


module.exports = router;
