const { spawn } = require('child_process');

function run(cmd, args, { timeoutMs = 4 * 3600 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${err}`));
    });
  });
}

async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const j = JSON.parse(out);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const rotation = Number(v?.tags?.rotate || v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0);
  const rotated = Math.abs(rotation) % 180 === 90;
  return {
    width: rotated ? v?.height : v?.width,
    height: rotated ? v?.width : v?.height,
    duration: Number(j.format?.duration) || null,
    hasVideo: !!v,
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}

// MediaRecorder output has no duration/cues; a stream-copy remux to MKV fixes both.
const remux = (input, output) => run('ffmpeg', ['-y', '-fflags', '+genpts', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', output]);

module.exports = { run, probe, remux };
