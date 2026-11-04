const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const storage = require('../storage');
const notify = require('../notify');
const settings = require('../settings');
const videos = require('../videos');
const pages = require('../pages');
const { audit } = require('../audit');

const router = express.Router();
const json = express.json({ limit: '100kb' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMOJI = ['👍', '❤️', '😂', '🎉', '👀', '🔥', '🙌', '🤔'];

async function viewable(req, res, { page = false } = {}) {
  const v = await videos.bySlug(req.params.slug);
  if (!v) {
    if (page) res.status(404).send(pages.notFound(await settings.get()));
    else res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (!videos.canView(req, v)) {
    if (!page) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
    const ws = await settings.get();
    const why = videos.viewDenial(req, v);
    if (why === 'login') res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    else if (why === 'password') res.send(pages.password(v, ws));
    else if (why === 'expired') res.status(410).send(pages.notFound(ws, 'This link has expired.'));
    else res.status(404).send(pages.notFound(ws));
    return null;
  }
  return v;
}

router.get('/v/:slug', wrap(async (req, res) => {
  const v = await viewable(req, res, { page: true });
  if (!v) return;
  res.send(pages.share(v, { user: req.user, settings: await settings.get(), data: videos.serialize(v, req.user) }));
}));

router.post('/v/:slug/unlock', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  const v = await videos.bySlug(req.params.slug);
  const ws = await settings.get();
  if (!v || videos.expired(v)) return res.status(404).send(pages.notFound(ws));
  if (v.password_hash && (await bcrypt.compare(req.body?.password || '', v.password_hash))) {
    res.cookie(`fc_u_${v.id}`, auth.unlockToken(v.id), auth.cookieOpts(7 * 864e5));
    return res.redirect(`/v/${v.slug}`);
  }
  res.status(401).send(pages.password(v, ws, 'Incorrect password'));
}));

router.get('/v/:slug/media', wrap(async (req, res) => {
  const v = await viewable(req, res);
  if (!v) return;
  const key = v.kind === 'image' ? v.image_key : v.video_key;
  if (!key) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=600').redirect(await storage.signedUrl(key));
}));

router.get('/v/:slug/download', wrap(async (req, res) => {
  const v = await viewable(req, res);
  if (!v) return;
  if (!v.allow_download && !videos.canEdit(req.user, v)) return res.sendStatus(403);
  const key = v.kind === 'image' ? v.image_key : v.video_key;
  if (!key) return res.sendStatus(404);
  const ext = key.split('.').pop();
  const name = `${v.title.replace(/[^\w\- ]+/g, '').trim() || 'video'}.${ext}`;
  audit(req, 'video.download', { type: 'video', id: v.id });
  res.redirect(await storage.signedUrl(key, { downloadName: name }));
}));

router.get('/v/:slug/thumb.jpg', wrap(async (req, res) => {
  const v = await viewable(req, res);
  if (!v || !v.thumb_key) return v ? res.sendStatus(404) : undefined;
  res.set('Cache-Control', 'public, max-age=300').redirect(await storage.signedUrl(v.thumb_key));
}));

const vttTime = (s) => {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${sec}.${String(ms % 1000).padStart(3, '0')}`;
};

router.get('/v/:slug/captions.vtt', wrap(async (req, res) => {
  const v = await viewable(req, res);
  if (!v) return;
  const { lines } = videos.derived(v);
  const cues = lines.map((l, i) => {
    const next = lines[i + 1];
    const end = Math.min(l.s + Math.max(1.5, l.text.split(' ').length * 0.45), next ? next.s : Infinity);
    return `${vttTime(l.s)} --> ${vttTime(end)}\n${l.text}`;
  });
  res.type('text/vtt').send(`WEBVTT\n\n${cues.join('\n\n')}\n`);
}));

router.get('/embed/:slug', wrap(async (req, res) => {
  const v = await videos.bySlug(req.params.slug);
  if (!v || !videos.canView(req, v)) return res.status(404).send(pages.notFound(await settings.get()));
  res.set('Content-Security-Policy', 'frame-ancestors *');
  res.send(pages.embed(v, videos.serialize(v, req.user)));
}));

router.get('/oembed', wrap(async (req, res) => {
  const m = String(req.query.url || '').match(/\/v\/(\w+)/);
  const v = m && (await videos.bySlug(m[1]));
  if (!v || v.visibility !== 'public' || videos.expired(v)) return res.sendStatus(404);
  const w = 960;
  const h = v.width && v.height ? Math.round((w * v.height) / v.width) : 540;
  res.json({
    version: '1.0', type: v.kind === 'image' ? 'photo' : 'video', provider_name: (await settings.get()).workspaceName,
    provider_url: config.publicUrl, title: v.title, author_name: v.owner_name, width: w, height: h,
    thumbnail_url: `${config.publicUrl}/v/${v.slug}/thumb.jpg`,
    ...(v.kind === 'image'
      ? { url: `${config.publicUrl}/v/${v.slug}/media` }
      : { html: `<iframe src="${config.publicUrl}/embed/${v.slug}" width="${w}" height="${h}" frameborder="0" allowfullscreen></iframe>` }),
  });
}));

// ---------- Public JSON API used by the share page ----------
const api = express.Router();

api.use('/:slug', wrap(async (req, res, next) => {
  const v = await viewable(req, res);
  if (!v) return;
  req.video = v;
  next();
}));

api.get('/:slug', (req, res) => res.json(videos.serialize(req.video, req.user)));

api.get('/:slug/transcript', (req, res) => res.json({ lines: videos.derived(req.video).lines }));

api.get('/:slug/activity', wrap(async (req, res) => {
  const [c, r] = await Promise.all([
    db.query(`SELECT id, author_name, body, timestamp_s, created_at, user_id FROM comments WHERE video_id = $1 ORDER BY created_at`, [req.video.id]),
    db.query(`SELECT id, emoji, timestamp_s, author_name, created_at FROM reactions WHERE video_id = $1 ORDER BY created_at`, [req.video.id]),
  ]);
  const manage = videos.canEdit(req.user, req.video);
  res.json({
    comments: c.rows.map((x) => ({
      id: x.id, authorName: x.author_name, body: x.body, timestampS: x.timestamp_s, createdAt: x.created_at,
      canDelete: manage || (!!req.user && x.user_id === req.user.id),
    })),
    reactions: r.rows.map((x) => ({ id: x.id, emoji: x.emoji, timestampS: x.timestamp_s, authorName: x.author_name, createdAt: x.created_at })),
    emoji: EMOJI,
  });
}));

api.post('/:slug/comments', json, wrap(async (req, res) => {
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  const name = req.user?.name || String(req.body?.authorName || '').trim().slice(0, 80);
  if (!body) return res.status(400).json({ error: 'Comment is empty' });
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const ts = Number(req.body?.timestampS);
  const c = await db.one(
    `INSERT INTO comments (video_id, user_id, author_name, body, timestamp_s) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, author_name, body, timestamp_s, created_at`,
    [req.video.id, req.user?.id || null, name, body, Number.isFinite(ts) && req.body?.timestampS !== null ? ts : null],
  );
  const out = { id: c.id, authorName: c.author_name, body: c.body, timestampS: c.timestamp_s, createdAt: c.created_at, canDelete: true };
  await notify.commentCreated(req.video, out, req.user);
  res.json(out);
}));

api.post('/:slug/reactions', json, wrap(async (req, res) => {
  const emoji = String(req.body?.emoji || '');
  if (!EMOJI.includes(emoji)) return res.status(400).json({ error: 'Unsupported reaction' });
  const ts = Number(req.body?.timestampS);
  const r = await db.one(
    `INSERT INTO reactions (video_id, user_id, viewer_id, author_name, emoji, timestamp_s) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, emoji, timestamp_s, author_name, created_at`,
    [req.video.id, req.user?.id || null, String(req.body?.viewerId || '').slice(0, 64) || null,
      req.user?.name || String(req.body?.authorName || '').slice(0, 80) || null, emoji, Number.isFinite(ts) ? ts : null],
  );
  res.json({ id: r.id, emoji: r.emoji, timestampS: r.timestamp_s, authorName: r.author_name, createdAt: r.created_at });
}));

// Viewer tracking: buckets are 50 equal slices of the video, used for the retention curve.
api.post('/:slug/view', json, wrap(async (req, res) => {
  if (videos.isOwner(req.user, req.video)) return res.json({ ok: true });
  const viewer = req.user ? `u:${req.user.id}` : String(req.body?.viewerId || '').slice(0, 64);
  if (!viewer) return res.status(400).json({ error: 'viewerId required' });
  const pos = Math.max(0, Number(req.body?.position) || 0);
  const buckets = (Array.isArray(req.body?.buckets) ? req.body.buckets : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 50);
  const r = await db.query(
    `INSERT INTO views (video_id, viewer_id, user_id, max_position, buckets) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (video_id, viewer_id) DO UPDATE SET
       max_position = GREATEST(views.max_position, EXCLUDED.max_position),
       buckets = ARRAY(SELECT DISTINCT unnest(views.buckets || EXCLUDED.buckets) ORDER BY 1),
       updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [req.video.id, viewer, req.user?.id || null, pos, buckets],
  );
  if (r.rows[0]?.inserted) {
    await db.query('UPDATE videos SET view_count = view_count + 1 WHERE id = $1', [req.video.id]);
    await notify.viewed(req.video, req.user);
  }
  res.json({ ok: true });
}));

router.use('/api/public', api);

module.exports = router;
