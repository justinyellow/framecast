const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const settings = require('../settings');
const { audit } = require('../audit');

const router = express.Router();
const json = express.json({ limit: '100kb' });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const noUsers = async () => !(await db.one('SELECT 1 AS x FROM users LIMIT 1'));
const passwordLogin = () => !config.oidc?.disablePasswordLogin;
const validInvite = (token) => token && db.one(
  `SELECT * FROM invites WHERE token = $1 AND accepted_at IS NULL AND expires_at > now()`, [token],
);

router.get('/api/auth/config', wrap(async (req, res) => {
  const ws = await settings.get();
  const invite = await validInvite(req.query.invite);
  res.json({
    signupOpen: (await noUsers()) || config.allowSignup || !!invite,
    passwordLogin: passwordLogin() || (await noUsers()),
    sso: config.oidc ? { label: config.oidc.label, provider: config.oidc.provider } : null,
    invite: invite ? { email: invite.email } : null,
    workspaceName: ws.workspaceName,
    brandColor: ws.brandColor,
  });
}));

router.post('/api/auth/signup', json, wrap(async (req, res) => {
  const { email, name, password, invite: inviteToken } = req.body || {};
  const first = await noUsers();
  const invite = await validInvite(inviteToken);
  if (!first && !config.allowSignup && !invite) return res.status(403).json({ error: 'Sign-ups are invite-only' });
  if (!first && !passwordLogin()) return res.status(403).json({ error: 'Use single sign-on' });
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Email and a password of at least 8 characters are required' });
  }
  if (invite && invite.email.toLowerCase() !== email.trim().toLowerCase()) {
    return res.status(400).json({ error: `This invite is for ${invite.email}` });
  }
  if (await db.one('SELECT 1 AS x FROM users WHERE lower(email) = lower($1)', [email.trim()])) {
    return res.status(409).json({ error: 'An account with that email already exists' });
  }
  const role = first ? 'admin' : invite?.role || 'member';
  const user = await db.one(
    'INSERT INTO users (email, name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [email.trim(), (name || email.split('@')[0]).trim().slice(0, 80), await bcrypt.hash(password, 11), role],
  );
  if (invite) await db.query('UPDATE invites SET accepted_at = now() WHERE token = $1', [invite.token]);
  auth.setSession(res, user.id);
  audit({ user, ip: req.ip }, 'user.signup', { type: 'user', id: user.id }, { role, invited: !!invite });
  res.json({ ok: true });
}));

router.post('/api/auth/login', json, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const user = await db.one('SELECT * FROM users WHERE lower(email) = lower($1) AND NOT disabled', [email || '']);
  const isAdminBreakGlass = user?.role === 'admin';
  if (!passwordLogin() && !isAdminBreakGlass) return res.status(403).json({ error: 'Use single sign-on' });
  if (!user?.password_hash || !(await bcrypt.compare(password || '', user.password_hash))) {
    audit({ ip: req.ip }, 'auth.login_failed', { type: 'user', id: user?.id }, { email });
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  auth.setSession(res, user.id);
  res.clearCookie('fc_no_auto', { path: '/' });
  audit({ user, ip: req.ip }, 'auth.login', { type: 'user', id: user.id });
  res.json({ ok: true });
}));

router.post('/api/auth/logout', (req, res) => {
  res.clearCookie('fc_sid', { path: '/' });
  if (config.devAutoLogin) res.cookie('fc_no_auto', '1', auth.cookieOpts(864e5));
  // SSO users also end their session at the provider, so "Sign out" doesn't bounce straight back in.
  const ssoUser = req.user?.sso_subject && config.oidc?.logoutUrl;
  res.json({ ok: true, redirect: ssoUser ? config.oidc.logoutUrl : '/login' });
});

router.get('/api/me', auth.requireUser, (req, res) => res.json(req.user));

router.patch('/api/me', auth.requireUser, json, wrap(async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const vals = [req.user.id];
  const set = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
  if (typeof b.name === 'string' && b.name.trim()) set('name', b.name.trim().slice(0, 80));
  for (const k of ['notify_comment', 'notify_view', 'notify_ready']) if (typeof b[k] === 'boolean') set(k, b[k]);
  if (b.newPassword) {
    const row = await db.one('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (row.password_hash && !(await bcrypt.compare(b.currentPassword || '', row.password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    if (String(b.newPassword).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    set('password_hash', await bcrypt.hash(String(b.newPassword), 11));
    audit(req, 'user.password_changed', { type: 'user', id: req.user.id });
  }
  if (sets.length) await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
  res.json(await db.one(`SELECT ${auth.USER_COLS} FROM users WHERE id = $1`, [req.user.id]));
}));

// ---------- Single sign-on: Cognito, Google, or any OIDC provider (see src/sso-config.js) ----------
const sso = require('../sso-config');

let oidcConfig = null;
async function oidc() {
  const client = await import('openid-client');
  if (!oidcConfig) {
    const o = config.oidc;
    const opts = o.issuer.startsWith('http://') ? { execute: [client.allowInsecureRequests] } : undefined;
    // No secret = public client (e.g. Cognito app clients without a secret); PKCE protects the code exchange.
    oidcConfig = await client.discovery(new URL(o.issuer), o.clientId, o.clientSecret || undefined, o.clientSecret ? undefined : client.None(), opts);
  }
  return { client, cfg: oidcConfig };
}
const redirectUri = () => `${config.publicUrl}${config.oidc.redirectPath}`;
const verified = (v) => !(v === false || v === 'false');

router.get('/auth/sso', wrap(async (req, res) => {
  if (!config.oidc) return res.status(404).send('SSO is not configured');
  const { client, cfg } = await oidc();
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.startsWith('//') ? req.query.next : '/app';
  res.cookie('fc_sso', auth.sign({ verifier, state, nonce, next, invite: req.query.invite || null, exp: Date.now() + 600000 }), auth.cookieOpts(600000));
  const url = client.buildAuthorizationUrl(cfg, {
    ...config.oidc.authParams,
    redirect_uri: redirectUri(),
    scope: config.oidc.scope,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  res.redirect(url.href);
}));

async function ssoCallback(req, res) {
  if (!config.oidc) return res.status(404).send('SSO is not configured');
  const o = config.oidc;
  const pending = auth.verify(req.cookies.fc_sso);
  res.clearCookie('fc_sso', { path: '/' });
  if (req.query.error) {
    console.error('SSO provider returned an error:', req.query.error, req.query.error_description);
    return res.redirect('/login?error=sso_failed');
  }
  if (!pending) return res.redirect('/login?error=sso_expired');
  const { client, cfg } = await oidc();
  const current = new URL(req.originalUrl, config.publicUrl);
  let claims;
  try {
    const tokens = await client.authorizationCodeGrant(cfg, current, {
      pkceCodeVerifier: pending.verifier, expectedState: pending.state, expectedNonce: pending.nonce,
    });
    claims = tokens.claims();
  } catch (e) {
    console.error('SSO callback failed', e);
    return res.redirect('/login?error=sso_failed');
  }
  const email = String(claims.email || '').toLowerCase();
  if (!email || !verified(claims.email_verified)) return res.redirect('/login?error=sso_no_email');
  const domain = email.split('@')[1];
  const domainOk = !o.allowedDomains.length || o.allowedDomains.includes(domain);
  const groups = sso.groupsFrom(o, claims);
  const groupRole = o.mapsRoles ? sso.roleFor(o, groups) : null;
  const invite = await validInvite(pending.invite);
  const first = await noUsers();

  // Group membership is the source of truth when mapping is on: no matching group, no access.
  if (o.requireGroup && !groupRole && !first) {
    audit({ ip: req.ip }, 'auth.sso_denied', { type: 'user', id: email }, { reason: 'no_group', groups });
    return res.redirect('/login?error=sso_no_group');
  }

  let user = await db.one('SELECT * FROM users WHERE sso_subject = $1 OR lower(email) = $2 ORDER BY (sso_subject = $1) DESC LIMIT 1', [claims.sub, email]);
  if (user?.disabled) return res.redirect('/login?error=disabled');
  if (!user) {
    if (!first && !invite && !(o.autoProvision && domainOk)) {
      audit({ ip: req.ip }, 'auth.sso_denied', { type: 'user', id: email }, { reason: domainOk ? 'no_invite' : 'domain' });
      return res.redirect('/login?error=sso_not_allowed');
    }
    const role = first ? 'admin' : groupRole || invite?.role || o.defaultRole;
    user = await db.one(
      `INSERT INTO users (email, name, role, sso_subject) VALUES ($1, $2, $3, $4) RETURNING *`,
      [email, String(claims.name || claims.given_name || email.split('@')[0]).slice(0, 80), role, claims.sub],
    );
    if (invite) await db.query('UPDATE invites SET accepted_at = now() WHERE token = $1', [invite.token]);
    audit({ user, ip: req.ip }, 'user.signup', { type: 'user', id: user.id }, { via: 'sso', provider: o.provider, role });
  } else {
    if (!user.sso_subject) await db.query('UPDATE users SET sso_subject = $2 WHERE id = $1', [user.id, claims.sub]);
    if (groupRole && groupRole !== user.role) {
      await db.query('UPDATE users SET role = $2 WHERE id = $1', [user.id, groupRole]);
      audit({ user, ip: req.ip }, 'member.role_synced', { type: 'user', id: user.id }, { from: user.role, to: groupRole, groups });
    }
  }
  auth.setSession(res, user.id);
  res.clearCookie('fc_no_auto', { path: '/' });
  audit({ user, ip: req.ip }, 'auth.login', { type: 'user', id: user.id }, { via: 'sso', provider: o.provider });
  res.redirect(pending.next || '/app');
}

router.get('/auth/sso/callback', wrap(ssoCallback));
if (config.oidc && config.oidc.redirectPath !== '/auth/sso/callback') router.get(config.oidc.redirectPath, wrap(ssoCallback));

module.exports = router;
