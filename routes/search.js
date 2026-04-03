// =============================================================================
// routes/search.js — Global Search Endpoint
// =============================================================================
//
// GET /api/search?q=QUERY[&type=rack|box|vial][&limit=N]
//
// Returns active results first, archived results after (within each type).
// Each result includes archived_at so the frontend can render an ARCHIVED badge.
// =============================================================================

const express = require('express');
const { db }  = require('../db');

const router = express.Router();

const rowLabel = i => String.fromCharCode(65 + i);
const colLabel = i => String(i + 1).padStart(2, '0');

const MAX_LIMIT = 200;

router.get('/search', (req, res) => {
  const q     = (req.query.q || '').trim();
  const type  = req.query.type || '';
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 50));

  if (q.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  const pattern = `%${q}%`;
  const results = { racks: [], boxes: [], vials: [] };


  // ── Racks ─────────────────────────────────────────────────────────────────
  if (!type || type === 'rack') {
    const racks = db.prepare(`
      SELECT r.*
      FROM   racks r
      WHERE  r.name     LIKE ?
          OR r.position LIKE ?
          OR r.notes    LIKE ?
      ORDER  BY (r.archived_at IS NOT NULL), r.name
      LIMIT  ?
    `).all(pattern, pattern, pattern, limit);

    results.racks = racks.map(rack => ({
      ...rack,
      _entity:      'rack',
      _match_field: matchField(rack, q, ['name', 'position', 'notes']),
      _path:        rack.name,
      _archived:    !!rack.archived_at,
    }));
  }


  // ── Boxes ─────────────────────────────────────────────────────────────────
  if (!type || type === 'box') {
    const boxes = db.prepare(`
      SELECT
        b.*,
        r.name     AS rack_name,
        r.id       AS rack_id_fk,
        r.position AS rack_position
      FROM   boxes b
      JOIN   racks r ON r.id = b.rack_id
      WHERE  b.name    LIKE ?
          OR b.notes   LIKE ?
          OR b.qr_code LIKE ?
      ORDER  BY (b.archived_at IS NOT NULL), r.name, b.slot_position
      LIMIT  ?
    `).all(pattern, pattern, pattern, limit);

    results.boxes = boxes.map(box => ({
      ...box,
      _entity:      'box',
      _match_field: matchField(box, q, ['name', 'qr_code', 'notes']),
      _path:        `${box.rack_name} › Slot ${box.slot_position} › ${box.name}`,
      _archived:    !!box.archived_at,
      _rack: {
        id:       box.rack_id,
        name:     box.rack_name,
        position: box.rack_position,
      }
    }));
  }


  // ── Vials ─────────────────────────────────────────────────────────────────
  if (!type || type === 'vial') {
    const vials = db.prepare(`
      SELECT
        v.*,
        b.name          AS box_name,
        b.id            AS box_id_fk,
        b.slot_position AS box_slot,
        b.rows          AS box_rows,
        b.cols          AS box_cols,
        r.name          AS rack_name,
        r.id            AS rack_id_fk,
        r.position      AS rack_position
      FROM   vials v
      JOIN   boxes b ON b.id = v.box_id
      JOIN   racks r ON r.id = b.rack_id
      WHERE  v.name          LIKE ?
          OR v.sample_type   LIKE ?
          OR v.researcher    LIKE ?
          OR v.volume        LIKE ?
          OR v.concentration LIKE ?
          OR v.notes         LIKE ?
          OR v.qr_code       LIKE ?
      ORDER  BY (v.archived_at IS NOT NULL), r.name, b.slot_position, v.row_index, v.col_index
      LIMIT  ?
    `).all(pattern, pattern, pattern, pattern, pattern, pattern, pattern, limit);

    results.vials = vials.map(vial => {
      const rLabel   = rowLabel(vial.row_index);
      const cLabel   = colLabel(vial.col_index);
      const posLabel = `${rLabel}${cLabel}`;
      return {
        ...vial,
        _entity:        'vial',
        _match_field:   matchField(vial, q, ['name', 'sample_type', 'qr_code', 'researcher', 'concentration', 'volume', 'notes']),
        _path:          `${vial.rack_name} › Slot ${vial.box_slot} › ${vial.box_name} › ${posLabel}`,
        _archived:      !!vial.archived_at,
        row_label:      rLabel,
        col_label:      cLabel,
        position_label: posLabel,
        _box:  { id: vial.box_id,      name: vial.box_name,  slot_position: vial.box_slot },
        _rack: { id: vial.rack_id_fk,  name: vial.rack_name, position: vial.rack_position }
      };
    });
  }

  const total = results.racks.length + results.boxes.length + results.vials.length;
  res.json({ query: q, total, limit, results });
});


function matchField(row, query, fields) {
  const q = query.toLowerCase();
  for (const field of fields) {
    const val = row[field];
    if (val && String(val).toLowerCase().includes(q)) return field;
  }
  return fields[0];
}


module.exports = router;
