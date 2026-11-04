const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const storage = require('../storage');
const jobs = require('../jobs');
const notify = require('../notify');
const settings = require('../settings');
const videos = require('../videos');
const ai = require('../processing/ai');
const { audit } = require('../audit');

const router = express.Router();
router.use(auth.requireUser);
const json = express.json({ limit: '1mb' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const slugId = () => {
  const abc = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (b) => abc[b % abc.length]).join('');
};
const VISIBILITIES = ['public', 'workspace', 'password', 'private'];
const POSITIONS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];
const SIZES = ['s', 'm', 'l'];

async function editable(req, res) {
  const v = await videos.byId(req.params.id);
  if (!v || !videos.canEdit(req.user, v)) {
    res.status(404).json({ error: 'Video not found' });
    return null;
  }
  return v;
}

async function checkQuota(user) {
  if (user.role === 'viewer') return 'Viewers cannot create recordings. Ask an admin for member access.';
  const ws = await settings.get();
  const limit = user.quota_bytes ? Number(user.quota_bytes) : ws.userQuotaGb ? ws.userQuotaGb * 1024 ** 3 : null;
  if (!limit) return null;
  const used = await db.one('SELECT coalesce(sum(size_bytes + raw_bytes), 0)::bigint AS b FROM videos WHERE owner_id = $1', [user.id]);
  return Number(used.b) >= limit ? `Storage quota reached (${(limit / 1024 ** 3).toFixed(1)} GB). Delete old videos or ask an admin.` : null;
}

router.get('/api/config', wrap(async (req, res) => {
  const ws = await settings.get();
  res.json({
    uploadMode: config.uploadMode,
    transcription: config.whisper.enabled,
    ai: config.ai.enabled && ai.hasCredentials(),
    email: notify.emailEnabled(),
    workspaceName: ws.workspaceName,
    brandColor: ws.brandColor,
    defaultVisibility: ws.defaultVisibility,
    allowPublicLinks: ws.allowPublicLinks,
    user: req.user,
  });
}));

// ---------- Library ----------
router.get('/api/videos', wrap(async (req, res) => {
  const { scope = 'mine', folder, q } = req.query;
  const where = ["v.status <> 'uploading'"];
  const vals = [];
  const add = (sql, val) => { vals.push(val); where.push(sql.replace('?', `$${vals.length}`)); };
  if (scope === 'mine') add('v.owner_id = ?', req.user.id);
  else if (req.user.role !== 'admin') {
    vals.push(req.user.id);
    where.push(`(v.owner_id = $${vals.length} OR v.visibility <> 'private')`);
  }
  if (folder === 'none') where.push('v.folder_id IS NULL');
  else if (folder) add('v.folder_id = ?', folder);
  if (q) {
    vals.push(String(q).slice(0, 200));
    const p = `$${vals.length}`;
    where.push(`(v.title ILIKE '%' || ${p} || '%' OR v.summary ILIKE '%' || ${p} || '%'
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(v.transcript, '[]'::jsonb)) w WHERE w->>'w' ILIKE ${p}))`);
  }
  const { rows } = await db.query(
    `SELECT v.*, u.name AS owner_name, (SELECT count(*)::int FROM comments c WHERE c.video_id = v.id) AS comment_count
       FROM videos v JOIN users u ON u.id = v.owner_id WHERE ${where.join(' AND ')} ORDER BY v.created_at DESC LIMIT 500`,
    vals,
  );
  res.json(rows.map((v) => {
    const s = videos.serialize(v, req.user);
    delete s.edits;
    return s;
  }));
}));

// ---------- Recording / upload ----------
router.post('/api/videos', json, wrap(async (req, res) => {
  const quota = await checkQuota(req.user);
  if (quota) return res.status(413).json({ error: quota });
  const b = req.body || {};
  const ws = await settings.get();
  const id = crypto.randomUUID();
  const ct = typeof b.mimeType === 'string' ? b.mimeType.split(';')[0] : 'video/webm';
  const screenKey = `videos/${id}/raw-screen`;
  const camKey = b.hasCamera ? `videos/${id}/raw-cam` : null;
  const screenUpload = await storage.createMultipart(screenKey, ct);
  const camUpload = camKey ? await storage.createMultipart(camKey, ct) : null;
  const title = String(b.title || `Recording ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`).slice(0, 200);
  const v = await db.one(
    `INSERT INTO videos (id, slug, owner_id, title, has_camera, screen_key, screen_upload_id, cam_key, cam_upload_id,
       camera_position, camera_size, folder_id, visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [id, slugId(), req.user.id, title, !!camKey, screenKey, screenUpload, camKey, camUpload,
      POSITIONS.includes(b.cameraPosition) ? b.cameraPosition : 'bottom-left',
      SIZES.includes(b.cameraSize) ? b.cameraSize : 'm',
      b.folderId || null, ws.allowPublicLinks ? ws.defaultVisibility : 'workspace'],
  );
  audit(req, 'video.create', { type: 'video', id }, { title });
  res.json({ ...videos.serialize(v, req.user), uploadMode: config.uploadMode });
}));

async function uploadTarget(req, res) {
  const v = await editable(req, res);
  if (!v) return null;
  const { track } = req.params;
  const n = Number(req.params.n);
  if (v.status !== 'uploading') return res.status(409).json({ error: 'Upload already finished' }) && null;
  if (!['screen', 'cam'].includes(track) || !Number.isInteger(n) || n < 1 || n > 10000) return res.status(400).json({ error: 'Bad part' }) && null;
  const key = track === 'screen' ? v.screen_key : v.cam_key;
  const uploadId = track === 'screen' ? v.screen_upload_id : v.cam_upload_id;
  if (!key || !uploadId) return res.status(400).json({ error: 'No such track' }) && null;
  return { v, track, n, key, uploadId };
}

const recordPart = (videoId, track, n, etag, size) => db.query(
  `INSERT INTO upload_parts (video_id, track, part_number, etag, size_bytes) VALUES ($1,$2,$3,$4,$5)
   ON CONFLICT (video_id, track, part_number) DO UPDATE SET etag = EXCLUDED.etag, size_bytes = EXCLUDED.size_bytes`,
  [videoId, track, n, etag, size],
);

// Direct mode: browser PUTs the part to S3 itself, then reports the ETag.
router.post('/api/videos/:id/parts/:track/:n/presign', wrap(async (req, res) => {
  const t = await uploadTarget(req, res);
  if (!t) return;
  res.json({ url: await storage.presignPart(t.key, t.uploadId, t.n) });
}));

router.post('/api/videos/:id/parts/:track/:n/done', json, wrap(async (req, res) => {
  const t = await uploadTarget(req, res);
  if (!t) return;
  const etag = String(req.body?.etag || '');
  if (!etag) return res.status(400).json({ error: 'etag required' });
  await recordPart(t.v.id, t.track, t.n, etag, Number(req.body?.size) || 0);
  res.json({ ok: true });
}));

// Proxy mode: part bytes go through the app.
router.put('/api/videos/:id/parts/:track/:n', express.raw({ type: () => true, limit: '64mb' }), wrap(async (req, res) => {
  const t = await uploadTarget(req, res);
  if (!t) return;
  if (!req.body?.length) return res.status(400).json({ error: 'Empty part' });
  const etag = await storage.uploadPart(t.key, t.uploadId, t.n, req.body);
  await recordPart(t.v.id, t.track, t.n, etag, req.body.length);
  res.json({ ok: true });
}));

router.post('/api/videos/:id/complete', wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  if (v.status !== 'uploading') return res.json(videos.serialize(v, req.user));
  const { rows: parts } = await db.query('SELECT * FROM upload_parts WHERE video_id = $1 ORDER BY track, part_number', [v.id]);
  const screenParts = parts.filter((p) => p.track === 'screen');
  const camParts = parts.filter((p) => p.track === 'cam');
  if (!screenParts.length) {
    await videos.deleteVideo(v);
    return res.status(400).json({ error: 'Nothing was recorded' });
  }
  await storage.completeMultipart(v.screen_key, v.screen_upload_id, screenParts);
  let hasCamera = false;
  if (v.cam_key) {
    if (camParts.length) {
      await storage.completeMultipart(v.cam_key, v.cam_upload_id, camParts);
      hasCamera = true;
    } else {
      await storage.abortMultipart(v.cam_key, v.cam_upload_id);
    }
  }
  const rawBytes = parts.reduce((a, p) => a + Number(p.size_bytes), 0);
  await db.query(
    `UPDATE videos SET status='processing', has_camera=$2, cam_key=CASE WHEN $2 THEN cam_key END,
       screen_upload_id=NULL, cam_upload_id=NULL, raw_bytes=$3, updated_at=now() WHERE id=$1`,
    [v.id, hasCamera, rawBytes],
  );
  await db.query('DELETE FROM upload_parts WHERE video_id = $1', [v.id]);
  await jobs.enqueue('process', { videoId: v.id, initial: true });
  res.json(videos.serialize(await videos.byId(v.id), req.user));
}));

// Screenshots: a single annotated PNG, no processing needed.
router.post('/api/images', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '25mb' }), wrap(async (req, res) => {
  const quota = await checkQuota(req.user);
  if (quota) return res.status(413).json({ error: quota });
  if (!req.body?.length) return res.status(400).json({ error: 'Empty image' });
  const ws = await settings.get();
  const id = crypto.randomUUID();
  const ext = req.get('content-type').split('/')[1];
  const key = `videos/${id}/image.${ext}`;
  await storage.putBuffer(key, req.body, req.get('content-type'));
  const width = Number(req.query.w) || null;
  const height = Number(req.query.h) || null;
  const title = String(req.query.title || `Screenshot ${new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`).slice(0, 200);
  const v = await db.one(
    `INSERT INTO videos (id, slug, owner_id, kind, title, status, image_key, thumb_key, width, height, size_bytes, folder_id, visibility)
     VALUES ($1,$2,$3,'image',$4,'ready',$5,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [id, slugId(), req.user.id, title, key, width, height, req.body.length, req.query.folderId || null,
      ws.allowPublicLinks ? ws.defaultVisibility : 'workspace'],
  );
  audit(req, 'video.create', { type: 'video', id }, { title, kind: 'image' });
  await notify.videoReady(v, { initial: true });
  res.json(videos.serialize(v, req.user));
}));

// ---------- Video management ----------
router.get('/api/videos/:id', wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  const stats = await db.one(
    `SELECT count(*)::int AS unique_viewers, avg(max_position) AS avg_position FROM views WHERE video_id = $1`, [v.id],
  );
  const completion = v.duration_s && stats.avg_position ? Math.min(1, stats.avg_position / v.duration_s) : null;
  res.json({ ...videos.serialize(v, req.user), uniqueViewers: stats.unique_viewers, avgCompletion: completion });
}));

router.get('/api/videos/:id/transcript', wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  res.json({ status: v.transcript_status, words: v.transcript || [], sourceDurationS: v.source_duration_s, edits: v.edits });
}));

router.get('/api/videos/:id/analytics', wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  const { rows } = await db.query(
    `SELECT w.viewer_id, w.max_position, w.buckets, w.created_at, w.updated_at, u.name, u.email
       FROM views w LEFT JOIN users u ON u.id = w.user_id WHERE w.video_id = $1 ORDER BY w.created_at DESC`,
    [v.id],
  );
  const dur = v.duration_s || 0;
  const viewers = rows.map((r) => ({
    name: r.name || 'Anonymous viewer',
    email: r.email || null,
    firstViewedAt: r.created_at,
    lastViewedAt: r.updated_at,
    watchedPct: dur ? Math.min(100, Math.round((r.buckets.length / 50) * 100)) : null,
  }));
  if (req.query.format === 'csv') {
    const cell = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
    const csv = ['name,email,first_viewed_at,last_viewed_at,watched_pct',
      ...viewers.map((r) => [r.name, r.email, r.firstViewedAt.toISOString(), r.lastViewedAt.toISOString(), r.watchedPct].map(cell).join(','))].join('\n');
    audit(req, 'video.viewers_export', { type: 'video', id: v.id });
    return res.type('text/csv').attachment(`${v.slug}-viewers.csv`).send(csv);
  }
  const retention = Array.from({ length: 50 }, (_, i) => (rows.length ? rows.filter((r) => r.buckets.includes(i)).length / rows.length : 0));
  const reactions = await db.query(`SELECT emoji, count(*)::int AS n FROM reactions WHERE video_id = $1 GROUP BY emoji ORDER BY n DESC`, [v.id]);
  res.json({ viewers, retention, reactions: reactions.rows, durationS: dur });
}));

router.patch('/api/videos/:id', json, wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  const b = req.body || {};
  const ws = await settings.get();
  const sets = [];
  const vals = [v.id];
  const set = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  let reprocess = false;
  if (typeof b.title === 'string' && b.title.trim()) set('title', b.title.trim().slice(0, 200));
  if (typeof b.allowDownload === 'boolean') set('allow_download', b.allowDownload);
  if (b.folderId !== undefined) set('folder_id', b.folderId || null);
  if (b.expiresAt !== undefined) set('expires_at', b.expiresAt ? new Date(b.expiresAt) : null);
  if (b.cta !== undefined) {
    const url = b.cta?.url ? String(b.cta.url).trim() : '';
    if (url && !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Button link must start with http:// or https://' });
    set('cta_url', url || null);
    set('cta_label', url ? String(b.cta.label || 'Learn more').slice(0, 40) : null);
  }
  if (b.visibility !== undefined) {
    if (!VISIBILITIES.includes(b.visibility)) return res.status(400).json({ error: 'Bad visibility' });
    if (b.visibility === 'public' && !ws.allowPublicLinks) return res.status(403).json({ error: 'Public links are disabled by your admin' });
    if (b.visibility === 'password' && !b.password && !v.password_hash) return res.status(400).json({ error: 'Password required' });
    set('visibility', b.visibility);
    if (b.visibility !== 'password') set('password_hash', null);
    else if (b.password) set('password_hash', await bcrypt.hash(String(b.password), 10));
    audit(req, 'video.visibility', { type: 'video', id: v.id }, { from: v.visibility, to: b.visibility });
  }
  if (typeof b.legalHold === 'boolean') {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    set('legal_hold', b.legalHold);
    audit(req, 'video.legal_hold', { type: 'video', id: v.id }, { on: b.legalHold });
  }
  if (v.kind === 'video' && v.has_camera) {
    if (POSITIONS.includes(b.cameraPosition) && b.cameraPosition !== v.camera_position) { set('camera_position', b.cameraPosition); reprocess = true; }
    if (SIZES.includes(b.cameraSize) && b.cameraSize !== v.camera_size) { set('camera_size', b.cameraSize); reprocess = true; }
  }
  if (reprocess) {
    if (v.status === 'processing') return res.status(409).json({ error: 'Video is still processing' });
    set('status', 'processing');
  }
  if (sets.length) await db.query(`UPDATE videos SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  if (reprocess) await jobs.enqueue('process', { videoId: v.id });
  res.json(videos.serialize(await videos.byId(v.id), req.user));
}));

// Non-destructive edits on the source timeline: trim, cuts (transcript edits / silence removal), blur regions.
router.post('/api/videos/:id/edits', json, wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  if (v.kind !== 'video') return res.status(400).json({ error: 'Not a video' });
  if (v.status === 'processing' || v.status === 'uploading') return res.status(409).json({ error: 'Video is busy' });
  const b = req.body || {};
  const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));
  const edits = {
    trimStart: num(b.trimStart),
    trimEnd: num(b.trimEnd),
    cuts: (Array.isArray(b.cuts) ? b.cuts : []).slice(0, 2000)
      .map(([a, z]) => [Number(a), Number(z)]).filter(([a, z]) => Number.isFinite(a) && Number.isFinite(z) && z > a),
    blurs: (Array.isArray(b.blurs) ? b.blurs : []).slice(0, 20).map((r) => ({
      x: Math.min(1, Math.max(0, Number(r.x) || 0)),
      y: Math.min(1, Math.max(0, Number(r.y) || 0)),
      w: Math.min(1, Math.max(0.01, Number(r.w) || 0.1)),
      h: Math.min(1, Math.max(0.01, Number(r.h) || 0.1)),
      start: num(r.start),
      end: num(r.end),
    })),
    // Annotations are managed by their own endpoints; keep them across trim/cut/blur edits.
    annotations: v.edits?.annotations || [],
    live: b.clearLive ? [] : v.edits?.live || [],
  };
  if ([edits.trimStart, edits.trimEnd].some((x) => x !== null && (!Number.isFinite(x) || x < 0))
    || (edits.trimStart !== null && edits.trimEnd !== null && edits.trimEnd <= edits.trimStart)) {
    return res.status(400).json({ error: 'Invalid trim range' });
  }
  await db.query(`UPDATE videos SET edits=$2, status='processing', updated_at=now() WHERE id=$1`, [v.id, edits]);
  await jobs.enqueue('process', { videoId: v.id });
  audit(req, 'video.edit', { type: 'video', id: v.id }, { cuts: edits.cuts.length, blurs: edits.blurs.length });
  res.json(videos.serialize(await videos.byId(v.id), req.user));
}));

// Drawn annotations: transparent PNGs (rendered in the browser at output resolution) shown for
// a time range on the source timeline, burned in by the worker with a fade in/out.
router.post('/api/videos/:id/annotations', express.raw({ type: 'image/png', limit: '10mb' }), wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  if (v.kind !== 'video') return res.status(400).json({ error: 'Not a video' });
  if (v.status === 'processing' || v.status === 'uploading') return res.status(409).json({ error: 'Video is busy' });
  if (!req.body?.length) return res.status(400).json({ error: 'Empty image' });
  const start = Number(req.query.start);
  const dur = Number(req.query.dur);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(dur) || dur < 0.3 || dur > 600) {
    return res.status(400).json({ error: 'Invalid timing' });
  }
  const existing = v.edits?.annotations || [];
  if (existing.length >= 50) return res.status(400).json({ error: 'Up to 50 annotations per video' });
  const ann = { id: crypto.randomUUID(), key: `videos/${v.id}/ann-${crypto.randomUUID()}.png`, start: +start.toFixed(3), dur: +dur.toFixed(3), kind: String(req.query.kind || 'drawing').slice(0, 20) };
  await storage.putBuffer(ann.key, req.body, 'image/png');
  await db.query(
    `UPDATE videos SET edits = jsonb_set(edits, '{annotations}', coalesce(edits->'annotations', '[]'::jsonb) || $2::jsonb), updated_at = now() WHERE id = $1`,
    [v.id, JSON.stringify([ann])],
  );
  res.json(ann);
}));

router.delete('/api/videos/:id/annotations/:annId', wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  if (v.status === 'processing') return res.status(409).json({ error: 'Video is busy' });
  const anns = v.edits?.annotations || [];
  const gone = anns.find((a) => a.id === req.params.annId);
  if (!gone) return res.status(404).json({ error: 'Not found' });
  await db.query(`UPDATE videos SET edits = jsonb_set(edits, '{annotations}', $2::jsonb), updated_at = now() WHERE id = $1`,
    [v.id, JSON.stringify(anns.filter((a) => a.id !== gone.id))]);
  storage.remove([gone.key]).catch(() => {});
  res.json({ ok: true });
}));

// Live drawings from the draw pad: one transparent PNG per time slice where the visible set of
// strokes changes. Uploaded right before /complete; the worker turns them into a single overlay track.
router.post('/api/videos/:id/live', express.raw({ type: 'image/png', limit: '10mb' }), wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  if (v.status !== 'uploading') return res.status(409).json({ error: 'Live drawings can only be added while recording' });
  const start = Number(req.query.start);
  const end = Number(req.query.end);
  const i = Number(req.query.i);
  if (![start, end, i].every(Number.isFinite) || start < 0 || end <= start || i < 0 || i >= 2000) return res.status(400).json({ error: 'Invalid slice' });
  if (!req.body?.length) return res.status(400).json({ error: 'Empty image' });
  const slice = { i, key: `videos/${v.id}/live/${String(i).padStart(4, '0')}.png`, start: +start.toFixed(3), end: +end.toFixed(3) };
  await storage.putBuffer(slice.key, req.body, 'image/png');
  await db.query(
    `UPDATE videos SET edits = jsonb_set(edits, '{live}', coalesce(edits->'live', '[]'::jsonb) || $2::jsonb) WHERE id = $1`,
    [v.id, JSON.stringify([slice])],
  );
  res.json({ ok: true });
}));

// Re-render the video with the current edits (used after adding/removing annotations).
router.post('/api/videos/:id/reprocess', wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  if (v.kind !== 'video') return res.status(400).json({ error: 'Not a video' });
  if (v.status === 'processing' || v.status === 'uploading') return res.status(409).json({ error: 'Video is busy' });
  await db.query(`UPDATE videos SET status='processing', updated_at=now() WHERE id=$1`, [v.id]);
  await jobs.enqueue('process', { videoId: v.id });
  audit(req, 'video.annotate', { type: 'video', id: v.id }, { annotations: (v.edits?.annotations || []).length });
  res.json(videos.serialize(await videos.byId(v.id), req.user));
}));

router.post('/api/videos/:id/ai', wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  if (!v.transcript?.length) return res.status(400).json({ error: 'No transcript yet' });
  if (!ai.hasCredentials()) return res.status(400).json({ error: 'AI is not configured (set ANTHROPIC_API_KEY)' });
  await db.query(`UPDATE videos SET ai_status='processing' WHERE id=$1`, [v.id]);
  await jobs.enqueue('summarize', { videoId: v.id });
  res.json({ ok: true });
}));

router.post('/api/videos/:id/transcribe', wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  if (v.kind !== 'video') return res.status(400).json({ error: 'Not a video' });
  await db.query(`UPDATE videos SET transcript_status='processing' WHERE id=$1`, [v.id]);
  await jobs.enqueue('transcribe', { videoId: v.id });
  res.json({ ok: true });
}));

router.delete('/api/videos/:id', wrap(async (req, res) => {
  const v = await editable(req, res);
  if (!v) return;
  if (v.legal_hold) return res.status(423).json({ error: 'This video is under legal hold' });
  await videos.deleteVideo(v);
  audit(req, 'video.delete', { type: 'video', id: v.id }, { title: v.title });
  await notify.videoDeleted(v);
  res.json({ ok: true });
}));

router.delete('/api/comments/:id', wrap(async (req, res) => {
  const c = await db.one(`SELECT c.*, v.owner_id FROM comments c JOIN videos v ON v.id = c.video_id WHERE c.id = $1`, [req.params.id]);
  if (!c || !(c.user_id === req.user.id || c.owner_id === req.user.id || req.user.role === 'admin')) return res.status(404).json({ error: 'Not found' });
  await db.query('DELETE FROM comments WHERE id = $1', [c.id]);
  res.json({ ok: true });
}));

// ---------- Folders (shared across the workspace) ----------
router.get('/api/folders', wrap(async (_req, res) => {
  const { rows } = await db.query(
    `SELECT f.id, f.name, f.created_by, (SELECT count(*)::int FROM videos v WHERE v.folder_id = f.id) AS count
       FROM folders f ORDER BY lower(f.name)`,
  );
  res.json(rows);
}));

router.post('/api/folders', json, wrap(async (req, res) => {
  if (req.user.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot create folders' });
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Name required' });
  res.json(await db.one('INSERT INTO folders (name, created_by) VALUES ($1, $2) RETURNING *', [name, req.user.id]));
}));

router.patch('/api/folders/:id', json, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  const f = await db.one('SELECT * FROM folders WHERE id = $1', [req.params.id]);
  if (!f || !(f.created_by === req.user.id || req.user.role === 'admin')) return res.status(404).json({ error: 'Not found' });
  if (!name) return res.status(400).json({ error: 'Name required' });
  res.json(await db.one('UPDATE folders SET name = $2 WHERE id = $1 RETURNING *', [f.id, name]));
}));

router.delete('/api/folders/:id', wrap(async (req, res) => {
  const f = await db.one('SELECT * FROM folders WHERE id = $1', [req.params.id]);
  if (!f || !(f.created_by === req.user.id || req.user.role === 'admin')) return res.status(404).json({ error: 'Not found' });
  await db.query('DELETE FROM folders WHERE id = $1', [f.id]);
  res.json({ ok: true });
}));

// ---------- Personal API tokens ----------
router.get('/api/tokens', wrap(async (req, res) => {
  const { rows } = await db.query('SELECT id, name, last_used_at, created_at FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
  res.json(rows);
}));

router.post('/api/tokens', json, wrap(async (req, res) => {
  if (req.viaToken) return res.status(403).json({ error: 'Create tokens from the web app' });
  const name = String(req.body?.name || 'API token').slice(0, 80);
  const { token, hash } = auth.newApiToken();
  const row = await db.one('INSERT INTO api_tokens (user_id, name, token_hash) VALUES ($1,$2,$3) RETURNING id, name, created_at', [req.user.id, name, hash]);
  audit(req, 'token.create', { type: 'token', id: row.id }, { name });
  res.json({ ...row, token });
}));

router.delete('/api/tokens/:id', wrap(async (req, res) => {
  await db.query('DELETE FROM api_tokens WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  audit(req, 'token.delete', { type: 'token', id: req.params.id });
  res.json({ ok: true });
}));

module.exports = router;
