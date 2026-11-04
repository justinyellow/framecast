const { run } = require('./ffmpeg');
const { keepSegments, isNoEdit } = require('../../public/js/timeline');

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const BUBBLE = { s: 0.18, m: 0.26, l: 0.36 };

function outputSize(w, h) {
  // Cap at 1080p (long side 1920, short side 1080), never upscale.
  const scale = Math.min(1, 1920 / Math.max(w, h), 1080 / Math.min(w, h));
  return { W: even(w * scale), H: even(h * scale) };
}

// Builds and runs one ffmpeg pass: scale -> camera bubble -> blur regions -> trim/cuts -> H.264 MP4.
async function transcode({ screen, cam, out, info, video, annotations = [], live = null }) {
  const { W, H } = outputSize(info.width, info.height);
  const keeps = keepSegments(video.edits, info.duration);
  if (!keeps.length) throw new Error('Edits remove the entire video');

  const args = ['-y', '-i', screen];
  if (cam) args.push('-i', cam);
  const f = [];
  f.push(`[0:v]scale=${W}:${H}:flags=bicubic,setsar=1,format=yuv420p[v0]`);
  let v = 'v0';
  let n = 0;

  if (cam) {
    const size = even(Math.min(W, H) * (BUBBLE[video.camera_size] || BUBBLE.m));
    const m = Math.round(Math.min(W, H) * 0.03);
    const pos = video.camera_position || 'bottom-left';
    const x = pos.endsWith('right') ? `main_w-overlay_w-${m}` : `${m}`;
    const y = pos.startsWith('top') ? `${m}` : `main_h-overlay_h-${m}`;
    f.push(
      `[1:v]crop='min(iw,ih)':'min(iw,ih)',scale=${size}:${size},format=yuva420p,`
      + `geq=lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':a='if(lte(hypot(X-W/2,Y-H/2),W/2-1),255,0)'[cam]`,
      `[${v}][cam]overlay=${x}:${y}:eof_action=pass,format=yuv420p[v${++n}]`,
    );
    v = `v${n}`;
  }

  // Blur regions are normalised (0-1) rectangles on the source timeline.
  for (const r of video.edits?.blurs || []) {
    const bw = even(Math.max(8, r.w * W));
    const bh = even(Math.max(8, r.h * H));
    const bx = Math.round(Math.min(W - bw, Math.max(0, r.x * W)));
    const by = Math.round(Math.min(H - bh, Math.max(0, r.y * H)));
    const radius = Math.max(2, Math.min(30, Math.floor(Math.min(bw, bh) / 2) - 1));
    const enable = r.start != null || r.end != null
      ? `:enable='between(t,${Number(r.start) || 0},${r.end != null ? Number(r.end) : 1e9})'` : '';
    f.push(
      `[${v}]split[b${n}a][b${n}b]`,
      `[b${n}b]crop=${bw}:${bh}:${bx}:${by},boxblur=${radius}:3[b${n}c]`,
      `[b${n}a][b${n}c]overlay=${bx}:${by}${enable}[v${n + 1}]`,
    );
    v = `v${++n}`;
  }

  // Annotations: each PNG is looped as a stream that ends when the annotation does, faded in and out.
  let input = cam ? 2 : 1;
  for (const ann of annotations) {
    const s = Math.max(0, Number(ann.start));
    const d = Math.max(0.3, Number(ann.dur));
    const fade = Math.min(0.25, d / 4);
    args.push('-loop', '1', '-framerate', '30', '-t', (s + d).toFixed(3), '-i', ann.file);
    f.push(
      `[${input}:v]scale=${W}:${H},format=rgba,fade=t=in:st=${s}:d=${fade}:alpha=1,fade=t=out:st=${(s + d - fade).toFixed(3)}:d=${fade}:alpha=1[an${input}]`,
      `[${v}][an${input}]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[v${n + 1}]`,
    );
    v = `v${++n}`;
    input++;
  }

  if (live) {
    args.push('-f', 'concat', '-safe', '0', '-i', live);
    f.push(
      `[${input}:v]scale=${W}:${H},format=rgba,setsar=1[live]`,
      `[${v}][live]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[v${n + 1}]`,
    );
    v = `v${++n}`;
    input++;
  }

  let a = info.hasAudio ? '0:a' : null;
  if (a) {
    f.push('[0:a]aresample=async=1:first_pts=0[a0]');
    a = 'a0';
  }

  if (!isNoEdit(keeps, info.duration)) {
    const k = keeps.length;
    f.push(`[${v}]split=${k}${keeps.map((_, i) => `[vs${i}]`).join('')}`);
    if (a) f.push(`[${a}]asplit=${k}${keeps.map((_, i) => `[as${i}]`).join('')}`);
    const range = ([s, e]) => `start=${s}${Number.isFinite(e) ? `:end=${e}` : ''}`;
    keeps.forEach((seg, i) => {
      f.push(`[vs${i}]trim=${range(seg)},setpts=PTS-STARTPTS[vt${i}]`);
      if (a) f.push(`[as${i}]atrim=${range(seg)},asetpts=PTS-STARTPTS[at${i}]`);
    });
    const ins = keeps.map((_, i) => `[vt${i}]${a ? `[at${i}]` : ''}`).join('');
    f.push(`${ins}concat=n=${k}:v=1:a=${a ? 1 : 0}[vout]${a ? '[aout]' : ''}`);
    v = 'vout';
    if (a) a = 'aout';
  }

  args.push('-filter_complex', f.join(';'), '-map', `[${v}]`);
  if (a) args.push('-map', `[${a}]`, '-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  args.push(
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
    '-fps_mode', 'vfr', '-movflags', '+faststart', out,
  );
  await run('ffmpeg', args);
  return { keeps };
}

const thumbnail = (input, out, at) => run('ffmpeg', [
  '-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', out,
]);

module.exports = { transcode, thumbnail };
