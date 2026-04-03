// =============================================================================
// routes/vials.js — Vial Endpoints
// =============================================================================
//
// Vials differ from racks and boxes: their "position" IS their identity.
// Instead of /vials/:id, we address vials by their box + grid coordinates:
//   /api/boxes/:boxId/vials/:row/:col
//
// This is called a "position-based" or "coordinate" API. It mirrors how
// a lab scientist thinks: "vial at position B03 in box BOX-001".
//
// UPSERT PATTERN
//   PUT creates a vial if the position is empty, or overwrites it if not.
//   This is called an "upsert" (update + insert). It simplifies the client:
//   it only needs to call one endpoint regardless of whether it's adding
//   or editing a sample.
//
// ENDPOINT SUMMARY
//   GET    /api/boxes/:boxId/vials           — all occupied positions in a box
//   PUT    /api/boxes/:boxId/vials/:row/:col — add or update a vial at position
//   DELETE /api/boxes/:boxId/vials/:row/:col — remove a vial
// =============================================================================

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, logAudit } = require('../db');

const router = express.Router();


// =============================================================================
// GET /api/boxes/:boxId/vials
// =============================================================================
// Returns the box metadata AND all its occupied vials in one request.
// The frontend needs both pieces to render the grid: it needs the box's
// rows/cols to know the grid dimensions, and the vials to know which cells
// are occupied and what data they hold.
//
// Returning them together saves a second round-trip HTTP request.
// =============================================================================
router.get('/boxes/:boxId/vials', (req, res) => {
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(req.params.boxId);
  if (!box) return res.status(404).json({ error: 'Box not found' });

  // Only occupied positions are returned. The frontend infers that any
  // position NOT in this list is empty.
  const vials = db.prepare(`
    SELECT * FROM vials
    WHERE box_id = ? AND archived_at IS NULL
    ORDER BY row_index, col_index
  `).all(req.params.boxId);

  // Return as an object with named keys so the client can destructure cleanly:
  //   const { box, vials } = await api('GET', '/boxes/abc/vials');
  res.json({ box, vials });
});


// =============================================================================
// PUT /api/boxes/:boxId/vials/:row/:col
// =============================================================================
// Add a new vial OR update an existing vial at position (row, col).
// :row and :col are 0-based integers in the URL.
//   Row 0 = "A", row 1 = "B", …
//   Col 0 = "01", col 1 = "02", …
//
// Request body: { name, sample_type?, date_stored?, volume?,
//                 concentration?, researcher?, qr_code?, notes?, changedBy? }
// =============================================================================
router.put('/boxes/:boxId/vials/:row/:col', (req, res) => {
  // parseInt with radix 10 to avoid octal parsing of strings like "08"
  const row = parseInt(req.params.row, 10);
  const col = parseInt(req.params.col, 10);

  const {
    name,
    sample_type   = '',
    date_stored   = '',
    volume        = '',
    concentration = '',
    researcher    = '',
    qr_code       = null,
    passage       = '',
    notes         = '',
    changedBy     = 'anonymous'
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: '"name" is required' });
  }

  // Validate that row/col numbers are valid integers (not NaN)
  if (Number.isNaN(row) || Number.isNaN(col)) {
    return res.status(400).json({ error: 'row and col must be integers' });
  }

  // Fetch the parent box
  const box = db.prepare('SELECT * FROM boxes WHERE id = ?').get(req.params.boxId);
  if (!box) return res.status(404).json({ error: 'Box not found' });

  if (row < 0 || row >= box.rows || col < 0 || col >= box.cols) {
    return res.status(400).json({
      error: `Position (${row}, ${col}) is out of bounds for a ${box.rows}×${box.cols} box`
    });
  }

  // Wrap the check-then-write in a transaction so no other request can
  // insert at the same position between the SELECT and the INSERT.
  // SQLite serialises writes, so the transaction is the race condition guard.
  const now = new Date().toISOString();
  let vial;

  try {
    const upsert = db.transaction(() => {
      const existing = db.prepare(`
        SELECT * FROM vials
        WHERE box_id = ? AND row_index = ? AND col_index = ?
      `).get(req.params.boxId, row, col);

      if (existing) {
        // UPDATE — vial already occupies this position
        db.prepare(`
          UPDATE vials
          SET name = ?, sample_type = ?, date_stored = ?, volume = ?,
              concentration = ?, researcher = ?, qr_code = ?, passage = ?, notes = ?,
              updated_at = ?
          WHERE box_id = ? AND row_index = ? AND col_index = ?
        `).run(
          name.trim(), sample_type, date_stored, volume,
          concentration, researcher, qr_code || null, passage || null, notes,
          now,
          req.params.boxId, row, col
        );

        const updated = db.prepare(`
          SELECT * FROM vials WHERE box_id = ? AND row_index = ? AND col_index = ?
        `).get(req.params.boxId, row, col);

        logAudit({
          entityType: 'vial', entityId: updated.id, entityName: updated.name,
          action: 'update', changedBy, oldData: existing, newData: updated,
          context: { box_id: req.params.boxId, row, col }
        });

        return updated;

      } else {
        // INSERT — position is empty
        const id = uuidv4();
        db.prepare(`
          INSERT INTO vials
            (id, box_id, row_index, col_index, name, sample_type,
             date_stored, volume, concentration, researcher, qr_code, passage, notes,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, req.params.boxId, row, col, name.trim(), sample_type,
          date_stored, volume, concentration, researcher,
          qr_code || null, passage || null, notes,
          now, now
        );

        const created = db.prepare('SELECT * FROM vials WHERE id = ?').get(id);

        logAudit({
          entityType: 'vial', entityId: id, entityName: created.name,
          action: 'create', changedBy, newData: created,
          context: { box_id: req.params.boxId, row, col }
        });

        return created;
      }
    });

    vial = upsert();

  } catch (err) {
    // UNIQUE constraint violation = two concurrent inserts to the same position
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({
        error: `Position (${row}, ${col}) was just occupied by another request — please refresh and try again`
      });
    }
    throw err;
  }

  res.json(vial);
});


// =============================================================================
// DELETE /api/boxes/:boxId/vials/:row/:col
// =============================================================================
// Removes the vial at the specified position. The position becomes empty.
// =============================================================================
router.delete('/boxes/:boxId/vials/:row/:col', (req, res) => {
  const row       = parseInt(req.params.row, 10);
  const col       = parseInt(req.params.col, 10);
  const changedBy = req.query.changedBy || 'anonymous';
  const archive   = req.query.archive === 'true';

  if (Number.isNaN(row) || Number.isNaN(col)) {
    return res.status(400).json({ error: 'row and col must be integers' });
  }

  const vial = db.prepare(`
    SELECT * FROM vials
    WHERE box_id = ? AND row_index = ? AND col_index = ? AND archived_at IS NULL
  `).get(req.params.boxId, row, col);

  if (!vial) {
    return res.status(404).json({ error: 'No vial found at that position' });
  }

  if (archive) {
    const now = new Date().toISOString();
    db.prepare(`UPDATE vials SET archived_at = ? WHERE id = ?`).run(now, vial.id);
    logAudit({ entityType:'vial', entityId:vial.id, entityName:vial.name, action:'archive', changedBy, oldData:vial, context:{ box_id:req.params.boxId, row, col } });
    return res.json({ archived: true, row, col });
  }

  logAudit({ entityType:'vial', entityId:vial.id, entityName:vial.name, action:'delete', changedBy, oldData:vial, context:{ box_id:req.params.boxId, row, col } });
  db.prepare(`DELETE FROM vials WHERE box_id = ? AND row_index = ? AND col_index = ?`).run(req.params.boxId, row, col);
  res.json({ deleted: true, row, col });
});


module.exports = router;


// =============================================================================
// GET /api/vials/by-qr
// =============================================================================
// Looks up a single vial by its QR code value.
//
// Query parameter:
//   ?code=VALUE   — the exact QR code string to search for
//
// Response on match (HTTP 200):
//   {
//     vial:   { ...all vial columns },
//     box:    { id, name, rows, cols, slot_position, rack_id },
//     rack:   { id, name, position, capacity },
//     path:   "RACK-01 › Slot 3 › BOX-007 › B04",
//     row_label:      "B",
//     col_label:      "04",
//     position_label: "B04"
//   }
//
// Response on no match (HTTP 404):
//   { error: 'No vial found with that QR code' }
//
// WHY A SEPARATE ENDPOINT vs. the search route?
//   The search route uses LIKE %term% for fuzzy substring matching — useful
//   for the search UI. QR code lookup must be an exact match because QR codes
//   are identifiers; a partial match could return the wrong vial. Using a
//   dedicated endpoint with = (equality) instead of LIKE also makes the
//   intent unmistakable in the code.
//
// WHY NOT /api/vials/:id?
//   Vials are addressed by box + position, not by UUID, throughout the API.
//   Adding a UUID route just for QR lookup would be inconsistent. QR codes
//   are the natural external identifier — they're what a scanner sees.
// =============================================================================
router.get('/vials/by-qr', (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) {
    return res.status(400).json({ error: '"code" query parameter is required' });
  }

  // Join through box → rack in a single query so the client gets the full
  // location context without additional requests.
  const row = db.prepare(`
    SELECT
      v.*,
      b.name          AS box_name,
      b.rows          AS box_rows,
      b.cols          AS box_cols,
      b.slot_position AS box_slot,
      b.rack_id       AS rack_id_fk,
      r.name          AS rack_name,
      r.position      AS rack_position,
      r.capacity      AS rack_capacity
    FROM   vials v
    JOIN   boxes b ON b.id = v.box_id
    JOIN   racks r ON r.id = b.rack_id
    WHERE  v.qr_code = ?
    LIMIT  1
  `).get(code);

  if (!row) {
    return res.status(404).json({ error: 'No vial found with that QR code' });
  }

  const rLabel   = String.fromCharCode(65 + row.row_index);
  const cLabel   = String(row.col_index + 1).padStart(2, '0');
  const posLabel = `${rLabel}${cLabel}`;

  res.json({
    vial: {
      id:            row.id,
      box_id:        row.box_id,
      row_index:     row.row_index,
      col_index:     row.col_index,
      name:          row.name,
      sample_type:   row.sample_type,
      date_stored:   row.date_stored,
      volume:        row.volume,
      concentration: row.concentration,
      researcher:    row.researcher,
      qr_code:       row.qr_code,
      notes:         row.notes,
      created_at:    row.created_at,
      updated_at:    row.updated_at,
    },
    box: {
      id:            row.box_id,
      name:          row.box_name,
      rows:          row.box_rows,
      cols:          row.box_cols,
      slot_position: row.box_slot,
      rack_id:       row.rack_id_fk,
    },
    rack: {
      id:       row.rack_id_fk,
      name:     row.rack_name,
      position: row.rack_position,
      capacity: row.rack_capacity,
    },
    path:           `${row.rack_name} › Slot ${row.box_slot} › ${row.box_name} › ${posLabel}`,
    row_label:      rLabel,
    col_label:      cLabel,
    position_label: posLabel,
  });
});

