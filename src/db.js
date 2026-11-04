const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DATABASE_POOL_SIZE || 10),
});

// Append-only. Never edit a migration that has shipped; add a new one.
const migrations = [
  `CREATE TABLE users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    name text NOT NULL,
    password_hash text,
    role text NOT NULL DEFAULT 'member',
    sso_subject text UNIQUE,
    notify_comment boolean NOT NULL DEFAULT true,
    notify_view boolean NOT NULL DEFAULT true,
    notify_ready boolean NOT NULL DEFAULT false,
    quota_bytes bigint,
    disabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

  CREATE TABLE settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL
  );

  CREATE TABLE invites (
    token text PRIMARY KEY,
    email text NOT NULL,
    role text NOT NULL DEFAULT 'member',
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    expires_at timestamptz NOT NULL,
    accepted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE folders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE videos (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text UNIQUE NOT NULL,
    owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    folder_id uuid REFERENCES folders(id) ON DELETE SET NULL,
    kind text NOT NULL DEFAULT 'video',
    title text NOT NULL,
    status text NOT NULL DEFAULT 'uploading',
    error text,
    has_camera boolean NOT NULL DEFAULT false,
    camera_position text NOT NULL DEFAULT 'bottom-left',
    camera_size text NOT NULL DEFAULT 'm',
    screen_key text,
    screen_upload_id text,
    cam_key text,
    cam_upload_id text,
    video_key text,
    thumb_key text,
    image_key text,
    source_duration_s real,
    duration_s real,
    width int,
    height int,
    size_bytes bigint NOT NULL DEFAULT 0,
    raw_bytes bigint NOT NULL DEFAULT 0,
    edits jsonb NOT NULL DEFAULT '{}'::jsonb,
    transcript jsonb,
    transcript_status text NOT NULL DEFAULT 'none',
    summary text,
    chapters jsonb,
    ai_status text NOT NULL DEFAULT 'none',
    visibility text NOT NULL DEFAULT 'public',
    password_hash text,
    allow_download boolean NOT NULL DEFAULT true,
    expires_at timestamptz,
    cta_label text,
    cta_url text,
    legal_hold boolean NOT NULL DEFAULT false,
    view_count int NOT NULL DEFAULT 0,
    first_view_notified boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX videos_owner_idx ON videos(owner_id, created_at DESC);
  CREATE INDEX videos_folder_idx ON videos(folder_id);
  CREATE INDEX videos_title_fts ON videos USING gin (to_tsvector('simple', title));

  CREATE TABLE upload_parts (
    video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    track text NOT NULL,
    part_number int NOT NULL,
    etag text NOT NULL,
    size_bytes bigint NOT NULL,
    PRIMARY KEY (video_id, track, part_number)
  );

  CREATE TABLE comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    author_name text NOT NULL,
    body text NOT NULL,
    timestamp_s real,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX comments_video_idx ON comments(video_id, created_at);

  CREATE TABLE reactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    viewer_id text,
    author_name text,
    emoji text NOT NULL,
    timestamp_s real,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX reactions_video_idx ON reactions(video_id);

  CREATE TABLE views (
    video_id uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    viewer_id text NOT NULL,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    max_position real NOT NULL DEFAULT 0,
    buckets int[] NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (video_id, viewer_id)
  );

  CREATE TABLE jobs (
    id bigserial PRIMARY KEY,
    type text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'queued',
    attempts int NOT NULL DEFAULT 0,
    max_attempts int NOT NULL DEFAULT 3,
    run_after timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    error text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX jobs_ready_idx ON jobs(run_after) WHERE status = 'queued';

  CREATE TABLE audit_log (
    id bigserial PRIMARY KEY,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    action text NOT NULL,
    target_type text,
    target_id text,
    meta jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX audit_log_created_idx ON audit_log(created_at DESC);

  CREATE TABLE api_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL,
    token_hash text UNIQUE NOT NULL,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    url text NOT NULL,
    events text[] NOT NULL,
    secret text NOT NULL,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT max(version) AS v FROM schema_migrations');
    for (let i = (rows[0].v ?? -1) + 1; i < migrations.length; i++) {
      await client.query('BEGIN');
      try {
        await client.query(migrations[i]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [i]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}

const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0];

module.exports = { pool, query, one, migrate };
