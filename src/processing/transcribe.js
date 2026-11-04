const fs = require('fs');
const path = require('path');
const config = require('../config');
const { run } = require('./ffmpeg');

// DTW alignment gives much tighter word timings than segment offsets; it needs the model preset name.
const dtwPreset = () => process.env.WHISPER_DTW || path.basename(config.whisper.model).match(/^ggml-(.+)\.bin$/)?.[1];

// Runs whisper.cpp locally (no external service) and returns word-level timings
// on the source timeline: [{ s, e, w }].
async function transcribe(sourceFile, dir) {
  const wav = path.join(dir, 'audio.wav');
  await run('ffmpeg', ['-y', '-i', sourceFile, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const base = path.join(dir, 'whisper');
  const dtw = dtwPreset();
  await run(config.whisper.bin, [
    '-m', config.whisper.model, '-f', wav, '-t', String(config.whisper.threads),
    '-ojf', '-of', base, '-np', ...(dtw ? ['-dtw', dtw] : []),
  ]);
  const j = JSON.parse(await fs.promises.readFile(`${base}.json`, 'utf8'));
  return wordsFromTokens(j.transcription || [], !!dtw);
}

function wordsFromTokens(segments, useDtw) {
  const words = [];
  for (const seg of segments) {
    const segEnd = seg.offsets.to / 1000;
    const first = words.length;
    let cur = null;
    for (const t of seg.tokens || []) {
      if (/^\[_.*_\]$/.test(t.text) || /^\[.*\]$/.test(t.text.trim())) continue;
      const at = useDtw && t.t_dtw >= 0 ? t.t_dtw / 100 : t.offsets.from / 1000;
      if (!cur || /^\s/.test(t.text)) {
        if (cur) words.push(cur);
        cur = { s: at, e: at, w: t.text.trim() };
      } else {
        cur.w += t.text;
        cur.e = at;
      }
    }
    if (cur) words.push(cur);
    // Close each word at the next word's start (bounded), giving cut ranges a sensible end.
    for (let i = first; i < words.length; i++) {
      const next = words[i + 1];
      const end = next ? next.s : Math.min(segEnd, words[i].e + 0.6);
      words[i].e = Math.max(words[i].s + 0.05, Math.min(end, words[i].e + 0.6));
    }
  }
  return words
    .filter((x) => x.w && !/^[([].*[)\]]$/.test(x.w))
    .map((x) => ({ s: +Math.max(0, x.s - 0.05).toFixed(3), e: +x.e.toFixed(3), w: x.w }));
}

// Groups words into caption-sized lines.
function toLines(words, maxWords = 14) {
  const lines = [];
  let cur = null;
  for (const word of words) {
    const gap = cur ? word.s - cur.e : 0;
    if (!cur || cur.words.length >= maxWords || gap > 1.2 || /[.?!]$/.test(cur.words[cur.words.length - 1].w)) {
      cur = { s: word.s, e: word.e, words: [] };
      lines.push(cur);
    }
    cur.words.push(word);
    cur.e = word.e;
  }
  return lines.map((l) => ({ s: l.s, e: l.e, text: l.words.map((x) => x.w).join(' ') }));
}

module.exports = { transcribe, toLines };
