// =============================================================================
// routes/search.js — Global Search Endpoint
// =============================================================================
//
// ENDPOINT
//   GET /api/search?q=QUERY[&type=rack|box|vial][&limit=N]
//
// WHAT IT SEARCHES
//   Racks  — name, position, notes
//   Boxes  — name, notes, qr_code
//   Vials  — name, sample_type, researcher, volume, concentration, notes, qr_code
//
// RESPONSE SHAPE
//   {
//     query:   "search term",
//     total:   42,
//     results: {
//       racks:  [ { ...rack,  _match_field, _path } ],
//       boxes:  [ { ...box,   _match_field, _path, _rack } ],
//       vials:  [ { ...vial,  _match_field, _path, _box, _rack,
//                             row_label, col_label, position_label } ]
//     }
//   }
//
// _path   — human-readable breadcrumb string, e.g. "RACK-01 › BOX-003 › B04"
// _match_field — which column contained the match (for highlighting in the UI)
// row_label / col_label — letter/number labels for the vial grid position
//
// DESIGN DECISIONS
// ─────────────────
// Single endpoint, three sub-queries
//   One HTTP request returns all three entity types. The client can filter
//   client-side or use the ?type= parameter to restrict on the server.
//   This is simpler than three separate requests and fast enough for SQLite
//   at lab-inventory scale.
//
// LIKE with % wildcards (substring match)
//   "hek" matches "HEK293-GFP-P12". Case-insensitive on SQLite because
//   LIKE is case-insensitive for ASCII by default. For non-ASCII characters
//   you would need COLLATE NOCASE or a custom collation — out of scope here.
//
// Parameterized queries
//   All user input flows through ? placeholders, never string interpolation.
//   This prevents SQL injection regardless of what the search term contains.
//
// JOIN to attach parent context
//   Vials are joined to their box and rack so the response includes the
//   full location hierarchy without additional round-trips from the client.
//
// _match_field heuristic
//   We cannot know from a LIKE result which column matched (SQLite doesn't
//   expose that). We determine it post-query by checking which fields
//   contain the search term, reporting the most "identifying" one first
//   (name > sample_type > qr_code > researcher > notes).
//
// LIMIT per type
//   Each sub-query is capped at `limit` rows (default 50, max 200).
//   Without a cap, a one-character search on a large database could return
//   thousands of vials and make the response huge.
// =============================================================================

const express = require('express');
const { db }  = require('../db');

const router = express.Router();

// Row and column label helpers — must match the frontend's rowLbl / colLbl
// functions so the position labels displayed in search results are consistent
// with what the box grid view shows.
const rowLabel = i => String.fromCharCode(65 + i);       // 0→'A', 1→'B', …
const colLabel = i => String(i + 1).padStart(2, '0');    // 0→'01', 1→'02', …

// Maximum results returned per entity type per search
const MAX_LIMIT = 200;


// =============================================================================
// GET /api/search
// =============================================================================
router.get('/search', (req, res) => {
  // ── Parse and validate query parameters ──────────────────────────────────
  const q     = (req.query.q || '').trim();
  const type  = req.query.type || '';   // '' = all types, or 'rack'/'box'/'vial'
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 50));

  // Require at least 2 characters to avoid returning the entire database
  // for single-keystroke searches.
  if (q.length < 2) {
    return res.status(400).json({
      error: 'Search query must be at least 2 characters'
    });
  }

  // SQLite LIKE pattern: %term% matches the term anywhere in the value.
  // We build it once and reuse it across all sub-queries.
  const pattern = `%${q}%`;

  const results = { racks: [], boxes: [], vials: [] };


  // ==========================================================================
  // SUB-QUERY 1: Racks
  // ==========================================================================
  // Searches: name, position, notes
  // Returns the rack row plus a synthesised _path string.
  // ==========================================================================
  if (!type || type === 'rack') {
    const racks = db.prepare(`
      SELECT r.*
      FROM   racks r
      WHERE  r.name     LIKE ?
          OR r.position LIKE ?
          OR r.notes    LIKE ?
      ORDER  BY r.name
      LIMIT  ?
    `).all(pattern, pattern, pattern, limit);

    results.racks = racks.map(rack => ({
      ...rack,
      _entity:      'rack',
      _match_field: matchField(rack, q, ['name', 'position', 'notes']),
      // Path for a rack is just its own name — it has no parent
      _path:        rack.name
    }));
  }


  // ==========================================================================
  // SUB-QUERY 2: Boxes
  // ==========================================================================
  // Searches: name, notes, qr_code
  // JOINs to its parent rack so we can build the full breadcrumb path.
  // ==========================================================================
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
      ORDER  BY r.name, b.slot_position
      LIMIT  ?
    `).all(pattern, pattern, pattern, limit);

    results.boxes = boxes.map(box => ({
      ...box,
      _entity:      'box',
      _match_field: matchField(box, q, ['name', 'qr_code', 'notes']),
      // Breadcrumb: "RACK-01 › Slot 3 › BOX-007"
      _path:        `${box.rack_name} › Slot ${box.slot_position} › ${box.name}`,
      // Parent rack summary for the result card
      _rack: {
        id:       box.rack_id,        // rack_id is the FK column on boxes
        name:     box.rack_name,
        position: box.rack_position
      }
    }));
  }


  // ==========================================================================
  // SUB-QUERY 3: Vials
  // ==========================================================================
  // Searches: name, sample_type, researcher, volume, concentration, notes, qr_code
  // JOINs all the way up to box → rack for a complete breadcrumb.
  // ==========================================================================
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
      ORDER  BY r.name, b.slot_position, v.row_index, v.col_index
      LIMIT  ?
    `).all(pattern, pattern, pattern, pattern, pattern, pattern, pattern, limit);

    results.vials = vials.map(vial => {
      const rLabel = rowLabel(vial.row_index);  // e.g. 'B'
      const cLabel = colLabel(vial.col_index);  // e.g. '04'
      const posLabel = `${rLabel}${cLabel}`;    // e.g. 'B04'

      return {
        ...vial,
        _entity:        'vial',
        _match_field:   matchField(vial, q, ['name', 'sample_type', 'qr_code', 'researcher', 'concentration', 'volume', 'notes']),
        // Full path: "RACK-01 › Slot 3 › BOX-007 › B04"
        _path:          `${vial.rack_name} › Slot ${vial.box_slot} › ${vial.box_name} › ${posLabel}`,
        row_label:      rLabel,
        col_label:      cLabel,
        position_label: posLabel,
        // Parent summaries for the result card
        _box: {
          id:           vial.box_id,    // FK column on vials
          name:         vial.box_name,
          slot_position: vial.box_slot
        },
        _rack: {
          id:       vial.rack_id_fk,
          name:     vial.rack_name,
          position: vial.rack_position
        }
      };
    });
  }

  // Total hits across all three entity types
  const total = results.racks.length + results.boxes.length + results.vials.length;

  res.json({ query: q, total, limit, results });
});


// =============================================================================
// HELPER: matchField
// =============================================================================
// Determines which field in `row` best explains why it matched the query.
// `fields` is an ordered array of field names — the first one whose value
// contains the query term (case-insensitive) is returned.
//
// This is used by the frontend to show a context snippet under each result,
// e.g. "matched: researcher — Alice M." so the user understands why the
// result appeared.
//
// Why post-query?
//   SQLite's LIKE operator doesn't expose which column matched. We re-check
//   in JavaScript. For the row counts we're dealing with (≤ MAX_LIMIT) this
//   is negligible — less than a millisecond.
// =============================================================================
function matchField(row, query, fields) {
  const q = query.toLowerCase();
  for (const field of fields) {
    const val = row[field];
    if (val && String(val).toLowerCase().includes(q)) {
      return field;
    }
  }
  return fields[0]; // Fallback — shouldn't normally be reached
}


module.exports = router;
