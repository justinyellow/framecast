// Postgres-backed job queue. Any number of worker tasks can poll it; FOR UPDATE SKIP LOCKED
// guarantees each job is claimed once. On ECS run the same image as a separate service with ROLE=worker.
const db = require('./db');

const handlers = {};
const register = (type, fn) => { handlers[type] = fn; };

async function enqueue(type, payload = {}, { delaySeconds = 0, maxAttempts = 3 } = {}) {
  await db.query(
    `INSERT INTO jobs (type, payload, run_after, max_attempts) VALUES ($1, $2, now() + make_interval(secs => $3), $4)`,
    [type, payload, delaySeconds, maxAttempts],
  );
}

async function claim() {
  return db.one(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now()
                  ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
  );
}

async function runOne(job) {
  const fn = handlers[job.type];
  try {
    if (!fn) throw new Error(`No handler for job type ${job.type}`);
    await fn(job.payload, job);
    await db.query(`UPDATE jobs SET status = 'done', error = NULL WHERE id = $1`, [job.id]);
  } catch (e) {
    const final = job.attempts >= job.max_attempts;
    console.error(`job ${job.id} (${job.type}) failed${final ? '' : ', will retry'}:`, e.message);
    await db.query(
      `UPDATE jobs SET status = $2, error = $3, run_after = now() + make_interval(secs => $4) WHERE id = $1`,
      [job.id, final ? 'failed' : 'queued', String(e.stack || e.message).slice(0, 4000), 30 * 2 ** job.attempts],
    );
    if (final && fn?.onFinalFailure) await fn.onFinalFailure(job.payload, e).catch(() => {});
  }
}

function startWorker({ concurrency = 1, pollMs = 1500 } = {}) {
  let active = 0;
  let stopped = false;
  const tick = async () => {
    while (!stopped && active < concurrency) {
      const job = await claim().catch((e) => { console.error('claim failed', e.message); return null; });
      if (!job) break;
      active++;
      runOne(job).finally(() => { active--; setImmediate(tick); });
    }
  };
  const interval = setInterval(tick, pollMs);
  // Re-queue jobs held by a task that died mid-run (e.g. ECS replaced it).
  const reaper = setInterval(() => db.query(
    `UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '2 hours'`,
  ).catch(() => {}), 10 * 60 * 1000);
  tick();
  return () => { stopped = true; clearInterval(interval); clearInterval(reaper); };
}

// Runs fn at most once per interval across all tasks, using an advisory lock + settings timestamp.
function every(name, ms, fn) {
  const go = async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [name]);
      if (!rows[0].ok) return client.query('ROLLBACK');
      const last = await client.query(`SELECT value FROM settings WHERE key = $1`, [`cron:${name}`]);
      if (last.rows[0] && Date.now() - last.rows[0].value < ms) return client.query('ROLLBACK');
      await client.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [`cron:${name}`, Date.now()],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      return console.error(`cron ${name}`, e.message);
    } finally {
      client.release();
    }
    await fn().catch((e) => console.error(`cron ${name}`, e));
  };
  setInterval(go, Math.min(ms, 5 * 60 * 1000)).unref();
  setTimeout(go, 10000).unref();
}

module.exports = { register, enqueue, startWorker, every };
