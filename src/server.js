const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./db');
const storage = require('./storage');
const jobs = require('./jobs');
const auth = require('./auth');
const pipeline = require('./processing/pipeline');
require('./notify'); // registers notification job handlers

async function startWeb() {
  const app = express();
  app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    next();
  });
  app.use(cookieParser());
  app.use(auth.loadUser);
  app.use(auth.devAutoLogin);
  app.use(auth.checkOrigin);

  const pub = path.join(__dirname, '..', 'public');
  // no-cache = always revalidate via ETag, so deploys take effect immediately without stale JS.
  app.use('/static', express.static(pub, { etag: true, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

  app.get('/healthz', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ ok: true, role: config.role });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const page = (file) => (_req, res) => res.sendFile(path.join(pub, file));
  app.get('/', (req, res) => res.redirect(req.user ? '/app' : '/login'));
  app.get('/login', page('login.html'));
  app.get('/app', auth.requireUser, page('library.html'));
  app.get('/record', auth.requireUser, page('record.html'));
  app.get('/screenshot', auth.requireUser, page('screenshot.html'));
  app.get('/settings', auth.requireUser, page('settings.html'));

  // Order matters: public + auth + admin routes do their own checks; the videos router requires a user for everything.
  app.use(require('./routes/public'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/admin'));
  app.use(require('./routes/videos'));

  app.use((err, req, res, _next) => {
    console.error(err);
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too large' });
    if (req.originalUrl.startsWith('/api/')) return res.status(500).json({ error: 'Something went wrong' });
    res.status(500).send('Something went wrong');
  });

  app.listen(config.port, () => console.log(`Framecast web listening on :${config.port} (${config.publicUrl})`));
}

(async () => {
  await db.migrate();
  await storage.ensureBucket();
  if (config.role === 'web' || config.role === 'all') await startWeb();
  if (config.role === 'worker' || config.role === 'all') {
    pipeline.registerAll();
    pipeline.startCrons();
    jobs.startWorker({ concurrency: config.processConcurrency });
    console.log(`Framecast worker started (concurrency ${config.processConcurrency})`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
