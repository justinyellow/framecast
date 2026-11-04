// Workspace-wide settings stored as JSON in the settings table, cached briefly per task.
const db = require('./db');

const DEFAULTS = {
  workspaceName: 'Framecast',
  brandColor: '#5b4cf0',
  logoKey: null,
  retentionDays: null,
  defaultVisibility: 'public',
  allowPublicLinks: true,
  chatWebhookUrl: null,
  chatNotifyNewVideo: true,
  chatNotifyComment: false,
  userQuotaGb: null,
};

let cache = null;
let cachedAt = 0;

async function get() {
  if (cache && Date.now() - cachedAt < 10000) return cache;
  const row = await db.one(`SELECT value FROM settings WHERE key = 'workspace'`);
  cache = { ...DEFAULTS, ...(row?.value || {}) };
  cachedAt = Date.now();
  return cache;
}

async function update(patch) {
  const next = { ...(await get()) };
  for (const k of Object.keys(DEFAULTS)) if (k in patch) next[k] = patch[k];
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('workspace', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [next],
  );
  cache = next;
  cachedAt = Date.now();
  return next;
}

module.exports = { get, update, DEFAULTS };
