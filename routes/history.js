// =============================================================================
// routes/history.js — Audit Log Query Endpoints
// =============================================================================
//
// These endpoints expose the audit_log table for reading. The audit log is
// append-only — it is NEVER modified through these endpoints, only queried.
//
// ENDPOINT SUMMARY
//   GET /api/history
//     — Paginated, filterable full audit log (for the History view in the UI)
//   GET /api/history/:entityType/:entityId
//     — All history entries for one specific object (e.g., one rack or vial)
//
// PAGINATION
//   The audit log can grow to millions of rows over time. Returning all rows
//   in one response would be slow and wasteful. Pagination splits results
//   into pages: the client asks for "page 2, 50 rows per page" and gets
//   rows 51–100, along with metadata about the total count and page count.
//
// QUERY PARAMETERS (for GET /api/history)
//   ?page=1           — Which page to return (1-indexed, default: 1)
//   ?limit=50         — Rows per page (default: 50, max: DB_AUDIT_MAX_ROWS)
//   ?entity_type=vial — Filter to a specific entity type
//   ?action=delete    — Filter to a specific action
//   ?entity_id=abc    — Filter to a specific object's history
//   ?search=Alice     — Search entity_name or changed_by (case-insensitive)
// =============================================================================

const express = require('express');
const { db }  = require('../db');

const router = express.Router();

// The maximum rows per page is capped to prevent memory exhaustion.
// Read from the environment so it can be tuned without code changes.
const AUDIT_MAX_ROWS = parseInt(process.env.DB_AUDIT_MAX_ROWS, 10) || 200;


// =============================================================================
// GET /api/history
// =============================================================================
// Returns a paginated, optionally filtered slice of the audit log.
// Results are ordered newest-first (most recent changes at the top).
// =============================================================================
router.get('/history', (req, res) => {

  // ── Parse and clamp pagination parameters ───────────────────────────────
  // parseInt falls back to NaN for missing/non-numeric values; || applies
  // the default. Math.max/min clamp the value to a safe range.
  const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
  const limit = Math.min(AUDIT_MAX_ROWS, Math.max(1, parseInt(req.query.limit, 10) || 50));

  // OFFSET tells SQLite how many rows to skip before starting to return rows.
  // Page 1 → offset 0 (skip nothing)
  // Page 2 → offset 50 (skip first 50)
  // Page 3 → offset 100 (skip first 100)  etc.
  const offset = (page - 1) * limit;

  // ── Build dynamic WHERE clause ──────────────────────────────────────────
  // We build the SQL WHERE clause conditionally based on which filter
  // parameters were provided. Using parameterized queries (?) instead of
  // string interpolation prevents SQL injection attacks.
  //
  // SQL injection example of what NOT to do:
  //   `WHERE entity_type = '${req.query.entity_type}'`
  //   If entity_type is  '; DROP TABLE audit_log; --  that would be catastrophic.
  //
  // With parameterized queries, the value is always treated as data, never code.
  let whereClause = 'WHERE 1=1';   // "1=1" is always true — a no-op base condition
  const queryParams = [];          // Values passed to SQLite to fill in the ?s

  if (req.query.entity_type) {
    whereClause += ' AND entity_type = ?';
    queryParams.push(req.query.entity_type);
  }

  if (req.query.action) {
    whereClause += ' AND action = ?';
    queryParams.push(req.query.action);
  }

  if (req.query.entity_id) {
    whereClause += ' AND entity_id = ?';
    queryParams.push(req.query.entity_id);
  }

  // LIKE with % wildcards enables substring search.
  // The OR condition searches both the name and the researcher columns.
  if (req.query.search) {
    whereClause += ' AND (entity_name LIKE ? OR changed_by LIKE ?)';
    queryParams.push(`%${req.query.search}%`, `%${req.query.search}%`);
  }

  // ── Execute count query first ────────────────────────────────────────────
  // We need the total matching row count to calculate the number of pages.
  // Using the same WHERE clause ensures the count matches what we'll return.
  const total = db
    .prepare(`SELECT COUNT(*) as c FROM audit_log ${whereClause}`)
    .get(...queryParams).c;

  // ── Execute the page query ────────────────────────────────────────────────
  // LIMIT and OFFSET are appended after the WHERE clause.
  // We spread queryParams for the WHERE placeholders, then add limit/offset.
  const rows = db
    .prepare(`SELECT * FROM audit_log ${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
    .all(...queryParams, limit, offset);

  // ── Parse stored JSON strings back into objects ───────────────────────────
  // old_data, new_data, and context are stored as JSON text in SQLite.
  // We parse them here so the response contains real objects, not strings.
  const entries = rows.map(row => ({
    ...row,
    old_data: row.old_data ? JSON.parse(row.old_data) : null,
    new_data: row.new_data ? JSON.parse(row.new_data) : null,
    context:  row.context  ? JSON.parse(row.context)  : null
  }));

  // Return pagination metadata alongside the entries so the client knows
  // how many pages exist and whether there are more to fetch.
  res.json({
    total,          // Total rows matching the filter
    page,           // Current page
    limit,          // Rows per page
    pages: Math.ceil(total / limit),  // Total number of pages
    entries         // The actual rows for this page
  });
});


// =============================================================================
// GET /api/history/:entityType/:entityId
// =============================================================================
// Returns the complete change history for one specific object.
// Useful for a "show history" panel on an individual rack, box, or vial.
//
// Example: GET /api/history/vial/a1b2c3d4-...
//   → All audit entries where entity_type='vial' AND entity_id='a1b2c3d4-...'
// =============================================================================
router.get('/history/:entityType/:entityId', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM audit_log
    WHERE entity_type = ? AND entity_id = ?
    ORDER BY timestamp DESC
  `).all(req.params.entityType, req.params.entityId);

  const entries = rows.map(row => ({
    ...row,
    old_data: row.old_data ? JSON.parse(row.old_data) : null,
    new_data: row.new_data ? JSON.parse(row.new_data) : null,
    context:  row.context  ? JSON.parse(row.context)  : null
  }));

  res.json(entries);
});


module.exports = router;
