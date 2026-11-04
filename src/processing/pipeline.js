const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const jobs = require('../jobs');
const storage = require('../storage');
const notify = require('../notify');
const settings = require('../settings');
const videos = require('../videos');
const { probe, remux, run } = require('./ffmpeg');
const { transcode, thumbnail } = require('./transcode');
const { transcribe } = require('./transcribe');
const ai = require('./ai');

async function withTmp(fn) {
  const dir = await fs.promises.mkdtemp(path.join(config.tmpDir, 'fc-'));
  try {
    return await fn(dir);
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchSource(key, dir, name) {
  const raw = path.join(dir, `${name}.raw`);
  const src = path.join(dir, `${name}.mkv`);
  await storage.download(key, raw);
  await remux(raw, src);
  await fs.promises.rm(raw, { force: true });
  return src;
}

// Builds an ffconcat playlist of the live-drawing slices, with a transparent frame filling the gaps,
// so all live ink becomes one overlay input regardless of how many strokes there were.
async function fetchLive(v, dir) {
  const slices = [...(v.edits?.live || [])].sort((a, b) => a.start - b.start);
  if (!slices.length) return null;
  const liveDir = path.join(dir, 'live');
  await fs.promises.mkdir(liveDir);
  for (let i = 0; i < slices.length; i += 8) {
    await Promise.all(slices.slice(i, i + 8).map((s, j) => {
      s.file = path.join(liveDir, `${String(i + j).padStart(4, '0')}.png`);
      return storage.download(s.key, s.file);
    }));
  }
  const dims = await probe(slices[0].file);
  const blank = path.join(liveDir, 'blank.png');
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black@0.0:s=${dims.width}x${dims.height},format=rgba`, '-frames:v', '1', blank]);
  const lines = ['ffconcat version 1.0'];
  let t = 0;
  const entry = (file, d) => { lines.push(`file '${file}'`, `duration ${d.toFixed(3)}`); };
  for (const s of slices) {
    if (s.start > t + 0.001) entry(blank, s.start - t);
    const startAt = Math.max(t, s.start);
    if (s.end > startAt) entry(s.file, s.end - startAt);
    t = Math.max(t, s.end);
  }
  entry(blank, 1);
  lines.push(`file '${blank}'`);
  const list = path.join(liveDir, 'list.ffconcat');
  await fs.promises.writeFile(list, `${lines.join('\n')}\n`);
  return list;
}

async function processVideo({ videoId, initial }) {
  const v = await db.one('SELECT * FROM videos WHERE id = $1', [videoId]);
  if (!v || v.kind !== 'video') return;
  await withTmp(async (dir) => {
    const screen = await fetchSource(v.screen_key, dir, 'screen');
    const cam = v.has_camera && v.cam_key ? await fetchSource(v.cam_key, dir, 'cam') : null;
    const info = await probe(screen);
    if (!info.hasVideo) throw new Error('No video stream found in recording');

    const annotations = [];
    for (const [i, a] of (v.edits?.annotations || []).entries()) {
      const file = path.join(dir, `ann-${i}.png`);
      await storage.download(a.key, file);
      annotations.push({ ...a, file });
    }
    const live = await fetchLive(v, dir);
    const out = path.join(dir, 'out.mp4');
    await transcode({ screen, cam, out, info, video: v, annotations, live });
    const outInfo = await probe(out);
    const thumb = path.join(dir, 'thumb.jpg');
    await thumbnail(out, thumb, outInfo.duration ? Math.min(1, outInfo.duration / 2) : 0);

    const videoKey = `videos/${v.id}/video.mp4`;
    const thumbKey = `videos/${v.id}/thumb.jpg`;
    const size = await storage.uploadFile(videoKey, out, 'video/mp4');
    await storage.uploadFile(thumbKey, thumb, 'image/jpeg');

    const transcribing = initial && config.whisper.enabled && info.hasAudio;
    const updated = await db.one(
      `UPDATE videos SET status='ready', error=NULL, video_key=$2, thumb_key=$3, duration_s=$4, source_duration_s=$5,
         width=$6, height=$7, size_bytes=$8,
         transcript_status = CASE WHEN $9 THEN 'processing' ELSE transcript_status END,
         updated_at=now() WHERE id=$1 RETURNING *`,
      [v.id, videoKey, thumbKey, outInfo.duration, info.duration, outInfo.width, outInfo.height, size, transcribing],
    );
    if (transcribing) await jobs.enqueue('transcribe', { videoId: v.id });
    await notify.videoReady(updated, { initial });
  });
}
processVideo.onFinalFailure = ({ videoId }, e) => db.query(
  `UPDATE videos SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [videoId, String(e.message).slice(0, 2000)],
);

async function transcribeVideo({ videoId }) {
  const v = await db.one('SELECT * FROM videos WHERE id = $1', [videoId]);
  if (!v) return;
  await withTmp(async (dir) => {
    const screen = await fetchSource(v.screen_key, dir, 'screen');
    const words = await transcribe(screen, dir);
    await db.query(
      `UPDATE videos SET transcript=$2, transcript_status=$3, updated_at=now() WHERE id=$1`,
      [v.id, JSON.stringify(words), words.length ? 'ready' : 'empty'],
    );
    if (words.length && config.ai.enabled && ai.hasCredentials()) {
      await db.query(`UPDATE videos SET ai_status='processing' WHERE id=$1`, [v.id]);
      await jobs.enqueue('summarize', { videoId: v.id });
    }
  });
}
transcribeVideo.onFinalFailure = ({ videoId }) => db.query(`UPDATE videos SET transcript_status='failed' WHERE id=$1`, [videoId]);

const isDefaultTitle = (t) => /^Recording \w{3} \d{1,2}, \d{4}/.test(t);

async function summarizeVideo({ videoId }) {
  const v = await db.one('SELECT * FROM videos WHERE id = $1', [videoId]);
  if (!v?.transcript?.length) return;
  const result = await ai.summarize(v.transcript, v.source_duration_s);
  if (!result) {
    await db.query(`UPDATE videos SET ai_status='unavailable' WHERE id=$1`, [v.id]);
    return;
  }
  await db.query(
    `UPDATE videos SET summary=$2, chapters=$3, ai_status='ready',
       title = CASE WHEN $4 THEN $5 ELSE title END, updated_at=now() WHERE id=$1`,
    [v.id, result.summary, JSON.stringify(result.chapters), isDefaultTitle(v.title) && !!result.title, result.title],
  );
}
summarizeVideo.onFinalFailure = ({ videoId }) => db.query(`UPDATE videos SET ai_status='failed' WHERE id=$1`, [videoId]);

async function retentionSweep() {
  const { retentionDays } = await settings.get();
  if (!retentionDays) return;
  const { rows } = await db.query(
    `SELECT * FROM videos WHERE legal_hold = false AND created_at < now() - make_interval(days => $1) LIMIT 200`,
    [Number(retentionDays)],
  );
  for (const v of rows) {
    await videos.deleteVideo(v);
    await db.query(
      `INSERT INTO audit_log (action, target_type, target_id, meta) VALUES ('video.retention_delete', 'video', $1, $2)`,
      [v.id, { title: v.title, createdAt: v.created_at }],
    );
  }
  if (rows.length) console.log(`retention: deleted ${rows.length} videos older than ${retentionDays} days`);
}

// Abandoned recordings (tab closed mid-upload) are cleaned up after a day.
async function abandonedSweep() {
  const { rows } = await db.query(`SELECT * FROM videos WHERE status = 'uploading' AND created_at < now() - interval '1 day' LIMIT 200`);
  for (const v of rows) await videos.deleteVideo(v);
  await db.query(`DELETE FROM jobs WHERE status IN ('done', 'failed') AND created_at < now() - interval '14 days'`);
}

function registerAll() {
  jobs.register('process', processVideo);
  jobs.register('transcribe', transcribeVideo);
  jobs.register('summarize', summarizeVideo);
}

function startCrons() {
  jobs.every('retention', 60 * 60 * 1000, retentionSweep);
  jobs.every('abandoned', 6 * 60 * 60 * 1000, abandonedSweep);
}

module.exports = { registerAll, startCrons };
