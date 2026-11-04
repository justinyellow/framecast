const db = require('./db');

// Fire-and-forget; audit failures must never break the request.
function audit(req, action, target = {}, meta = {}) {
  db.query(
    `INSERT INTO audit_log (user_id, action, target_type, target_id, meta, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
    [req?.user?.id || null, action, target.type || null, target.id || null, meta, req?.ip || null],
  ).catch((e) => console.error('audit', e.message));
}

module.exports = { audit };
