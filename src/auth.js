const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const SESSION_DAYS = 30;

const hmac = (s) => crypto.createHmac('sha256', config.sessionSecret).update(s).digest('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body)}`;
}

function verify(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = hmac(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp && p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

const cookieOpts = (maxAgeMs) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.publicUrl.startsWith('https://'),
  maxAge: maxAgeMs,
  path: '/',
});

function setSession(res, userId) {
  const ms = SESSION_DAYS * 864e5;
  res.cookie('fc_sid', sign({ uid: userId, exp: Date.now() + ms }), cookieOpts(ms));
}

const USER_COLS = 'id, email, name, role, notify_comment, notify_view, notify_ready, quota_bytes, sso_subject, (password_hash IS NOT NULL) AS has_password';

async function loadUser(req, _res, next) {
  req.user = null;
  try {
    const bearer = req.get('authorization')?.match(/^Bearer\s+(fc_\w+)$/)?.[1];
    if (bearer) {
      const row = await db.one(
        `UPDATE api_tokens SET last_used_at = now() WHERE token_hash = $1 RETURNING user_id`, [sha256(bearer)],
      );
      if (row) {
        req.user = await db.one(`SELECT ${USER_COLS} FROM users WHERE id = $1 AND NOT disabled`, [row.user_id]);
        req.viaToken = !!req.user;
      }
    } else {
      const p = verify(req.cookies.fc_sid);
      if (p) req.user = await db.one(`SELECT ${USER_COLS} FROM users WHERE id = $1 AND NOT disabled`, [p.uid]);
    }
    next();
  } catch (e) {
    next(e);
  }
}

const isLocal = () => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(config.publicUrl);
if (config.devAutoLogin && !isLocal()) console.warn('DEV_AUTO_LOGIN ignored: PUBLIC_URL is not localhost');

// Signs every request in as the dev user. Signing out sets fc_no_auto so you can test as an
// anonymous viewer or another account; signing in again clears it.
async function devAutoLogin(req, res, next) {
  if (!config.devAutoLogin || !isLocal() || req.user || req.viaToken || req.cookies.fc_no_auto) return next();
  try {
    const email = config.devAutoLogin.toLowerCase();
    let user = await db.one(`SELECT ${USER_COLS} FROM users WHERE lower(email) = $1`, [email]);
    if (!user) {
      await db.query(
        `INSERT INTO users (email, name, role) VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
        [email, process.env.DEV_AUTO_LOGIN_NAME || email.split('@')[0]],
      );
      user = await db.one(`SELECT ${USER_COLS} FROM users WHERE lower(email) = $1`, [email]);
    }
    setSession(res, user.id);
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

function requireUser(req, res, next) {
  if (req.user) return next();
  if (req.originalUrl.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

function requireAdmin(req, res, next) {
  if (req.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Admins only' });
}

// Cookie-authenticated state changes must come from our own origin (CSRF defence on top of SameSite=Lax).
function checkOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.viaToken) return next();
  const origin = req.get('origin') || req.get('referer');
  if (origin && !origin.startsWith(config.publicUrl)) return res.status(403).json({ error: 'Bad origin' });
  next();
}

function newApiToken() {
  const token = `fc_${crypto.randomBytes(24).toString('base64url').replace(/[^\w]/g, '')}`;
  return { token, hash: sha256(token) };
}

// Password-protected share links: cookie proves the viewer entered the password.
const unlockToken = (videoId) => sign({ vid: videoId, exp: Date.now() + 7 * 864e5 });
const isUnlocked = (req, videoId) => verify(req.cookies[`fc_u_${videoId}`])?.vid === videoId;

module.exports = {
  sign, verify, setSession, loadUser, devAutoLogin, requireUser, requireAdmin, checkOrigin, newApiToken, sha256,
  unlockToken, isUnlocked, cookieOpts, USER_COLS,
};
