const required = (name, fallback) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var ${name}`);
  return v;
};
const bool = (name, dflt = false) => (process.env[name] === undefined ? dflt : process.env[name] === 'true');

module.exports = {
  port: Number(process.env.PORT || 3000),
  // web: HTTP only. worker: jobs only. all: both (local/dev, small deployments).
  role: process.env.ROLE || 'all',
  publicUrl: required('PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET'),
  allowSignup: bool('ALLOW_SIGNUP'),
  // Local testing only: auto sign in as this email (created as admin). Ignored unless PUBLIC_URL is localhost.
  devAutoLogin: process.env.DEV_AUTO_LOGIN || null,
  s3: {
    bucket: required('S3_BUCKET'),
    region: process.env.AWS_REGION || 'us-east-1',
    // Leave endpoints unset on AWS; set them for a local/non-AWS S3.
    endpoint: process.env.S3_ENDPOINT || undefined,
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT || undefined,
    forcePathStyle: bool('S3_FORCE_PATH_STYLE'),
    createBucket: bool('S3_CREATE_BUCKET'),
  },
  // direct: browser PUTs parts straight to S3 via presigned URLs (needs bucket CORS).
  // proxy: parts go through the app (no CORS needed).
  uploadMode: process.env.UPLOAD_MODE || 'direct',
  cloudfront: process.env.CLOUDFRONT_DOMAIN ? {
    domain: process.env.CLOUDFRONT_DOMAIN.replace(/\/$/, ''),
    keyPairId: required('CLOUDFRONT_KEY_PAIR_ID'),
    privateKey: required('CLOUDFRONT_PRIVATE_KEY').replace(/\\n/g, '\n'),
  } : null,
  oidc: process.env.OIDC_ISSUER ? {
    issuer: process.env.OIDC_ISSUER,
    clientId: required('OIDC_CLIENT_ID'),
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    label: process.env.OIDC_LABEL || 'Single sign-on',
    allowedDomains: (process.env.OIDC_ALLOWED_DOMAINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    autoProvision: bool('OIDC_AUTO_PROVISION', true),
    disablePasswordLogin: bool('DISABLE_PASSWORD_LOGIN'),
  } : null,
  smtp: process.env.SMTP_HOST ? {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: bool('SMTP_SECURE'),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'Framecast <no-reply@localhost>',
  } : null,
  whisper: {
    bin: process.env.WHISPER_BIN || 'whisper-cli',
    model: process.env.WHISPER_MODEL || '/opt/whisper/models/ggml-base.en.bin',
    enabled: bool('TRANSCRIBE', true),
    threads: Number(process.env.WHISPER_THREADS || 4),
  },
  ai: {
    enabled: bool('AI_SUMMARIES', true),
    model: process.env.AI_MODEL || 'claude-opus-5-5',
  },
  processConcurrency: Number(process.env.PROCESS_CONCURRENCY || 1),
  tmpDir: process.env.TMP_DIR || require('os').tmpdir(),
};
