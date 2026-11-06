const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const storage = require('../storage');
const notify = require('../notify');
const settings = require('../settings');
const { audit } = require('../audit');

const router = express.Router();
const json = express.json({ limit: '100kb' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const admin = [auth.requireUser, auth.requireAdmin];
const ROLES = ['admin', 'member', 'viewer'];

// ---------- Workspace settings ----------
router.get('/api/admin/settings', admin, wrap(async (_req, res) => {
  const ws = await settings.get();
  res.json({ ...ws, logoUrl: ws.logoKey ? '/brand/logo' : null, smtpConfigured: !!config.smtp, ssoConfigured: !!config.oidc });
}));

router.patch('/api/admin/settings', admin, json, wrap(async (req, res) => {
  const b = { ...(req.body || {}) };
  delete b.logoKey;
  if (b.brandColor && !/^#[0-9a-f]{6}$/i.test(b.brandColor)) return res.status(400).json({ error: 'Brand color must be a hex value like #5b4cf0' });
  if (b.retentionDays !== undefined) b.retentionDays = b.retentionDays ? Math.max(1, Number(b.retentionDays)) : null;
  if (b.userQuotaGb !== undefined) b.userQuotaGb = b.userQuotaGb ? Math.max(0.1, Number(b.userQuotaGb)) : null;
  if (b.chatWebhookUrl && !/^https:\/\//.test(b.chatWebhookUrl)) return res.status(400).json({ error: 'Webhook URL must use https://' });
  if (b.defaultVisibility && !['public', 'workspace', 'password', 'private'].includes(b.defaultVisibility)) return res.status(400).json({ error: 'Bad visibility' });
  const next = await settings.update(b);
  audit(req, 'settings.update', { type: 'settings' }, { keys: Object.keys(b) });
  res.json(next);
}));

router.post('/api/admin/logo', admin, express.raw({ type: ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'], limit: '2mb' }), wrap(async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'Empty file' });
  const key = `brand/logo-${Date.now()}`;
  await storage.putBuffer(key, req.body, req.get('content-type'));
  const prev = (await settings.get()).logoKey;
  await settings.update({ logoKey: key });
  if (prev) storage.remove([prev]).catch(() => {});
  audit(req, 'settings.logo', { type: 'settings' });
  res.json({ ok: true });
}));

router.delete('/api/admin/logo', admin, wrap(async (req, res) => {
  const prev = (await settings.get()).logoKey;
  await settings.update({ logoKey: null });
  if (prev) storage.remove([prev]).catch(() => {});
  res.json({ ok: true });
}));

router.post('/api/admin/test-chat', admin, wrap(async (_req, res) => {
  try {
    await notify.postChat('Framecast test message: notifications are working.');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ---------- Members & invites ----------
router.get('/api/admin/members', admin, wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role, u.disabled, u.quota_bytes, u.created_at, (u.sso_subject IS NOT NULL) AS sso,
       count(v.id)::int AS videos, coalesce(sum(v.size_bytes + v.raw_bytes), 0)::bigint AS bytes
     FROM users u LEFT JOIN videos v ON v.owner_id = u.id GROUP BY u.id ORDER BY u.created_at`,
  );
  res.json(rows.map((r) => ({ ...r, bytes: Number(r.bytes), quota_bytes: r.quota_bytes ? Number(r.quota_bytes) : null })));
}));

router.patch('/api/admin/members/:id', admin, json, wrap(async (req, res) => {
  const b = req.body || {};
  const target = await db.one('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const demotingSelf = target.id === req.user.id && ((b.role && b.role !== 'admin') || b.disabled === true);
  if (demotingSelf) return res.status(400).json({ error: "You can't remove your own admin access" });
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) return res.status(400).json({ error: 'Bad role' });
    await db.query('UPDATE users SET role = $2 WHERE id = $1', [target.id, b.role]);
  }
  if (typeof b.disabled === 'boolean') {
    await db.query('UPDATE users SET disabled = $2 WHERE id = $1', [target.id, b.disabled]);
    if (b.disabled) await db.query('DELETE FROM api_tokens WHERE user_id = $1', [target.id]);
  }
  if (b.quotaGb !== undefined) {
    await db.query('UPDATE users SET quota_bytes = $2 WHERE id = $1', [target.id, b.quotaGb ? Math.round(Number(b.quotaGb) * 1024 ** 3) : null]);
  }
  audit(req, 'member.update', { type: 'user', id: target.id }, b);
  res.json({ ok: true });
}));

router.get('/api/admin/invites', admin, wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT token, email, role, expires_at, created_at FROM invites WHERE accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
  );
  res.json(rows.map((r) => ({ ...r, url: `${config.publicUrl}/login?invite=${r.token}` })));
}));

router.post('/api/admin/invites', admin, json, wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'member';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
  if (await db.one('SELECT 1 AS x FROM users WHERE lower(email) = $1', [email])) return res.status(409).json({ error: 'That person already has an account' });
  const token = crypto.randomBytes(18).toString('base64url');
  await db.query(`INSERT INTO invites (token, email, role, created_by, expires_at) VALUES ($1,$2,$3,$4, now() + interval '14 days')`, [token, email, role, req.user.id]);
  const url = `${config.publicUrl}/login?invite=${token}`;
  const ws = await settings.get();
  let emailed = false;
  if (notify.emailEnabled()) {
    await notify.sendEmail({
      to: email,
      subject: `${req.user.name} invited you to ${ws.workspaceName}`,
      text: `${req.user.name} invited you to join ${ws.workspaceName} on Framecast.\n\nAccept: ${url}\n\nThis link expires in 14 days.`,
      html: notify.emailHtml(`Join ${ws.workspaceName}`, `${req.user.name} invited you to share and watch screen recordings.`, url, 'Accept invite'),
    });
    emailed = true;
  }
  audit(req, 'invite.create', { type: 'invite', id: email }, { role });
  res.json({ token, email, role, url, emailed });
}));

router.delete('/api/admin/invites/:token', admin, wrap(async (req, res) => {
  await db.query('DELETE FROM invites WHERE token = $1', [req.params.token]);
  audit(req, 'invite.revoke', { type: 'invite', id: req.params.token });
  res.json({ ok: true });
}));

// ---------- Outgoing webhooks ----------
router.get('/api/admin/webhooks', admin, wrap(async (_req, res) => {
  const { rows } = await db.query('SELECT id, url, events, created_at FROM webhooks ORDER BY created_at');
  res.json({ webhooks: rows, events: notify.EVENTS });
}));

router.post('/api/admin/webhooks', admin, json, wrap(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const events = (req.body?.events || []).filter((e) => notify.EVENTS.includes(e));
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Valid URL required' });
  if (!events.length) return res.status(400).json({ error: 'Pick at least one event' });
  const secret = crypto.randomBytes(24).toString('hex');
  const row = await db.one('INSERT INTO webhooks (url, events, secret, created_by) VALUES ($1,$2,$3,$4) RETURNING id, url, events, created_at', [url, events, secret, req.user.id]);
  audit(req, 'webhook.create', { type: 'webhook', id: row.id }, { url, events });
  res.json({ ...row, secret });
}));

router.delete('/api/admin/webhooks/:id', admin, wrap(async (req, res) => {
  await db.query('DELETE FROM webhooks WHERE id = $1', [req.params.id]);
  audit(req, 'webhook.delete', { type: 'webhook', id: req.params.id });
  res.json({ ok: true });
}));

// ---------- Audit log & storage ----------
router.get('/api/admin/audit', admin, wrap(async (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit) || 200);
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.meta, a.ip, a.created_at, u.name AS user_name, u.email AS user_email
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT $1`,
    [req.query.format === 'csv' ? 100000 : limit],
  );
  if (req.query.format === 'csv') {
    const cell = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const csv = ['time,user,email,action,target_type,target_id,ip,details',
      ...rows.map((r) => [r.created_at.toISOString(), r.user_name, r.user_email, r.action, r.target_type, r.target_id, r.ip, JSON.stringify(r.meta)].map(cell).join(','))].join('\n');
    return res.type('text/csv').attachment('framecast-audit-log.csv').send(csv);
  }
  res.json(rows);
}));

router.get('/api/admin/storage', admin, wrap(async (_req, res) => {
  res.json(await db.one(
    `SELECT count(*)::int AS items, count(*) FILTER (WHERE kind = 'video')::int AS videos, count(*) FILTER (WHERE kind = 'image')::int AS images,
       coalesce(sum(size_bytes), 0)::bigint AS output_bytes, coalesce(sum(raw_bytes), 0)::bigint AS raw_bytes,
       count(*) FILTER (WHERE legal_hold)::int AS legal_holds FROM videos WHERE status <> 'uploading'`,
  ));
}));

// Logo is public so share pages can show it.
router.get('/brand/logo', wrap(async (_req, res) => {
  const { logoKey } = await settings.get();
  if (!logoKey) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=300').redirect(await storage.signedUrl(logoKey));
}));

module.exports = router;
