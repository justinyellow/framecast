// Builds the single sign-on (OIDC) config from env vars. Three ways to configure it:
//
//   OIDC_PROVIDER=cognito  AWS Cognito user pool, using the standard COGNITO_* variables
//                          (COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, COGNITO_DOMAIN, COGNITO_REGION,
//                          optional COGNITO_CLIENT_SECRET and COGNITO_IDENTITY_PROVIDER). Picked
//                          automatically when COGNITO_USER_POOL_ID is set and OIDC_ISSUER isn't.
//   OIDC_PROVIDER=google   Google accounts directly (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//                          GOOGLE_WORKSPACE_DOMAINS to restrict to your Workspace).
//   OIDC_ISSUER=...        Any other OpenID Connect provider (Entra ID, Okta, Keycloak, ...).
//
// Role mapping (all providers): OIDC_ADMIN_GROUPS / OIDC_MEMBER_GROUPS / OIDC_VIEWER_GROUPS list
// group names from the token's groups claim. When any are set, roles are re-synced at every login.
const env = (k) => (process.env[k] ?? '').trim();
const list = (k) => env(k).split(',').map((s) => s.trim()).filter(Boolean);
const bool = (k, dflt) => (env(k) === '' ? dflt : env(k) === 'true');

function parseParams(s) {
  const out = {};
  for (const [k, v] of new URLSearchParams(s)) out[k] = v;
  return out;
}

function provider() {
  const p = env('OIDC_PROVIDER').toLowerCase();
  if (p) return p;
  if (env('OIDC_ISSUER')) return 'oidc';
  if (env('COGNITO_USER_POOL_ID')) return 'cognito';
  return null;
}

function base(kind, publicUrl) {
  if (kind === 'cognito') {
    const region = env('COGNITO_REGION') || env('AWS_REGION');
    const pool = env('COGNITO_USER_POOL_ID');
    const clientId = env('COGNITO_CLIENT_ID');
    if (!region || !pool || !clientId) throw new Error('Cognito SSO needs COGNITO_REGION (or AWS_REGION), COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID');
    let domain = env('COGNITO_DOMAIN').replace(/\/$/, '');
    if (domain && !/^https?:\/\//.test(domain)) domain = `https://${domain}`;
    const idp = env('COGNITO_IDENTITY_PROVIDER');
    return {
      issuer: `https://cognito-idp.${region}.amazonaws.com/${pool}`,
      clientId,
      clientSecret: env('COGNITO_CLIENT_SECRET') || undefined,
      // identity_provider skips Cognito's hosted UI and goes straight to e.g. Google Workspace.
      authParams: idp ? { identity_provider: idp } : {},
      groupsClaim: 'cognito:groups',
      redirectPath: '/callback',
      logoutUrl: domain ? `${domain}/logout?client_id=${encodeURIComponent(clientId)}&logout_uri=${encodeURIComponent(`${publicUrl}/login`)}` : null,
      label: /google/i.test(idp) ? 'Sign in with Google' : 'Sign in with SSO',
    };
  }
  if (kind === 'google') {
    const domains = list('GOOGLE_WORKSPACE_DOMAINS').map((d) => d.toLowerCase());
    if (!env('GOOGLE_CLIENT_ID') || !env('GOOGLE_CLIENT_SECRET')) throw new Error('Google SSO needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    return {
      issuer: 'https://accounts.google.com',
      clientId: env('GOOGLE_CLIENT_ID'),
      clientSecret: env('GOOGLE_CLIENT_SECRET'),
      // hd pre-selects the Workspace account in Google's picker; the email domain is still enforced server-side.
      authParams: domains.length === 1 ? { hd: domains[0], prompt: 'select_account' } : { prompt: 'select_account' },
      allowedDomains: domains,
      groupsClaim: 'groups',
      label: 'Sign in with Google',
    };
  }
  if (kind === 'oidc') {
    if (!env('OIDC_ISSUER') || !env('OIDC_CLIENT_ID')) throw new Error('OIDC SSO needs OIDC_ISSUER and OIDC_CLIENT_ID');
    return {
      issuer: env('OIDC_ISSUER'),
      clientId: env('OIDC_CLIENT_ID'),
      clientSecret: env('OIDC_CLIENT_SECRET') || undefined,
      authParams: {},
      groupsClaim: 'groups',
      label: 'Sign in with SSO',
    };
  }
  throw new Error(`Unknown OIDC_PROVIDER "${kind}" (use cognito, google or oidc)`);
}

function load(publicUrl) {
  const kind = provider();
  if (!kind) return null;
  const b = base(kind, publicUrl);
  const roleGroups = { admin: list('OIDC_ADMIN_GROUPS'), member: list('OIDC_MEMBER_GROUPS'), viewer: list('OIDC_VIEWER_GROUPS') };
  const mapsRoles = Object.values(roleGroups).some((g) => g.length);
  return {
    provider: kind,
    issuer: b.issuer,
    clientId: b.clientId,
    clientSecret: b.clientSecret,
    label: env('OIDC_LABEL') || b.label,
    scope: env('OIDC_SCOPE') || 'openid email profile',
    authParams: { ...b.authParams, ...parseParams(env('OIDC_AUTH_PARAMS')) },
    redirectPath: env('OIDC_REDIRECT_PATH') || b.redirectPath || '/auth/sso/callback',
    logoutUrl: env('OIDC_LOGOUT_URL') || b.logoutUrl || null,
    allowedDomains: [...(b.allowedDomains || []), ...list('OIDC_ALLOWED_DOMAINS').map((d) => d.toLowerCase())],
    groupsClaim: env('OIDC_GROUPS_CLAIM') || b.groupsClaim,
    roleGroups,
    mapsRoles,
    // With group mapping on, only people in one of the listed groups may sign in (unless turned off).
    requireGroup: bool('OIDC_REQUIRE_GROUP', mapsRoles),
    defaultRole: ['admin', 'member', 'viewer'].includes(env('OIDC_DEFAULT_ROLE')) ? env('OIDC_DEFAULT_ROLE') : 'member',
    autoProvision: bool('OIDC_AUTO_PROVISION', true),
    disablePasswordLogin: bool('DISABLE_PASSWORD_LOGIN', false),
  };
}

// Highest role whose groups intersect the user's groups; null when none match.
function roleFor(cfg, groups) {
  const have = new Set(groups);
  for (const role of ['admin', 'member', 'viewer']) {
    if (cfg.roleGroups[role].some((g) => have.has(g))) return role;
  }
  return null;
}

function groupsFrom(cfg, claims) {
  const raw = claims[cfg.groupsClaim];
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(/[,\s]+/).filter(Boolean);
  return [];
}

module.exports = { load, roleFor, groupsFrom };
