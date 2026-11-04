// Live draw pad: an always-on-top Document Picture-in-Picture window showing a preview of the
// shared screen. Strokes drawn on it are timestamped against the recording clock; when the
// recording finishes they are rasterised into time slices and burned in by the worker.
(() => {
  const FADE_HOLD = 3; // seconds a stroke stays fully visible in "fade" mode
  const FADE_OUT = 0.3;
  const TOOLS = [['pen', 'Pen'], ['arrow', 'Arrow'], ['rect', 'Box'], ['highlight', 'Highlight']];
  const COLORS = ['#e5484d', '#ffd60a', '#30a46c', '#3e63dd', '#ffffff'];

  const supported = () => 'documentPictureInPicture' in window;

  // Shapes use normalised 0-1 coordinates; width is a fraction of the frame height.
  function drawShape(c, s, W, H, alpha = 1) {
    c.save();
    c.globalAlpha = alpha;
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = Math.max(2, s.width * H);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const x1 = s.x1 * W; const y1 = s.y1 * H; const x2 = s.x2 * W; const y2 = s.y2 * H;
    if (s.tool !== 'highlight') { c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = Math.max(2, H / 250); }
    if (s.tool === 'pen') {
      c.beginPath();
      s.points.forEach(([px, py], i) => (i ? c.lineTo(px * W, py * H) : c.moveTo(px * W, py * H)));
      c.stroke();
    } else if (s.tool === 'rect') {
      c.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (s.tool === 'highlight') {
      c.globalAlpha = alpha * 0.3;
      c.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (s.tool === 'arrow') {
      const head = c.lineWidth * 4.5;
      const a = Math.atan2(y2 - y1, x2 - x1);
      c.beginPath();
      c.moveTo(x1, y1);
      c.lineTo(x2 - Math.cos(a) * head * 0.6, y2 - Math.sin(a) * head * 0.6);
      c.stroke();
      c.beginPath();
      c.moveTo(x2, y2);
      c.lineTo(x2 - head * Math.cos(a - Math.PI / 7), y2 - head * Math.sin(a - Math.PI / 7));
      c.lineTo(x2 - head * Math.cos(a + Math.PI / 7), y2 - head * Math.sin(a + Math.PI / 7));
      c.closePath();
      c.fill();
    }
    c.restore();
  }

  const strokeEnd = (s, clears, total) => {
    if (s.mode === 'fade') return s.t + FADE_HOLD + FADE_OUT;
    const clear = clears.find((t) => t > s.t);
    return clear ?? total;
  };

  function alphaAt(s, t, end) {
    if (t < s.t || t >= end) return 0;
    if (s.mode === 'fade' && t > end - FADE_OUT) return Math.max(0, (end - t) / FADE_OUT);
    return 1;
  }

  // Splits the timeline wherever the visible ink changes; each slice becomes one PNG.
  function slices(strokes, clears, total) {
    const ends = strokes.map((s) => strokeEnd(s, clears, total));
    const times = new Set([0, total]);
    strokes.forEach((s, i) => {
      times.add(s.t);
      times.add(ends[i]);
      if (s.mode === 'fade') [0.2, 0.1].forEach((d) => times.add(ends[i] - d));
    });
    const sorted = [...times].filter((t) => t >= 0 && t <= total).sort((a, b) => a - b);
    const out = [];
    for (let k = 0; k < sorted.length - 1; k++) {
      const a = sorted[k];
      const b = sorted[k + 1];
      if (b - a < 0.02) continue;
      const visible = strokes.map((s, i) => [s, alphaAt(s, a + 0.001, ends[i])]).filter(([, al]) => al > 0.01);
      if (visible.length) out.push({ start: a, end: b, visible });
    }
    return out.slice(0, 2000);
  }

  class DrawPad {
    constructor({ stream, camStream, getTime, isPaused, onPause, onStop }) {
      Object.assign(this, { stream, camStream, getTime, isPaused, onPause, onStop });
      this.strokes = [];
      this.clears = [];
      this.tool = 'pen';
      this.color = COLORS[0];
      this.mode = 'fade';
      this.drawing = null;
      this.win = null;
    }

    async open() {
      if (this.win && !this.win.closed) return this.win;
      const settings = this.stream.getVideoTracks()[0]?.getSettings() || {};
      const aspect = settings.width && settings.height ? settings.width / settings.height : 16 / 9;
      const width = 560;
      this.win = await window.documentPictureInPicture.requestWindow({ width, height: Math.round(width / aspect) + 92 });
      this.build(settings.displaySurface);
      return this.win;
    }

    build(surface) {
      const d = this.win.document;
      const link = d.createElement('link');
      link.rel = 'stylesheet';
      link.href = new URL('/static/css/app.css', location.href).href;
      d.head.appendChild(link);
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent');
      d.body.className = 'pad';
      if (accent) d.documentElement.style.setProperty('--accent', accent);
      d.body.innerHTML = `
        <div class="pad-bar">
          ${TOOLS.map(([k, l]) => `<button class="tool ${k === this.tool ? 'active' : ''}" data-tool="${k}">${l}</button>`).join('')}
          <span class="pad-colors">${COLORS.map((c) => `<button class="swatch ${c === this.color ? 'active' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}</span>
          <button class="tool" data-mode title="Fade: ink disappears after a few seconds. Keep: ink stays until you clear it.">Fade</button>
          <button class="tool" data-clear>Clear</button>
        </div>
        <div class="pad-stage"><video muted autoplay playsinline></video><canvas></canvas>
          ${this.camStream ? '<video class="pad-cam" muted autoplay playsinline></video>' : ''}</div>
        ${surface === 'monitor' ? '<p class="pad-warn">You’re sharing your whole screen, so this pad appears in the recording. Share a window or tab to keep it out.</p>' : ''}
        <div class="pad-foot"><span class="rec-time"><span class="rec-dot"></span><span data-time>0:00</span></span>
          <span class="grow"></span><button class="btn btn-sm" data-pause>Pause</button><button class="btn btn-primary btn-sm" data-stop>Finish</button></div>`;
      this.video = d.querySelector('.pad-stage video');
      this.video.srcObject = this.stream;
      if (this.camStream) {
        const cam = d.querySelector('.pad-cam');
        cam.srcObject = this.camStream;
      }
      this.canvas = d.querySelector('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.bind(d);
      const loop = () => {
        if (this.win.closed) return;
        this.layout();
        this.paint();
        d.querySelector('[data-time]').textContent = fc.fmtTime(this.getTime());
        const paused = this.isPaused();
        d.querySelector('.rec-dot').classList.toggle('paused', paused);
        d.querySelector('[data-pause]').textContent = paused ? 'Resume' : 'Pause';
        this.win.requestAnimationFrame(loop);
      };
      this.win.requestAnimationFrame(loop);
    }

    // Keep the canvas exactly over the visible video area (object-fit: contain letterboxing).
    layout() {
      const stage = this.video.parentElement.getBoundingClientRect();
      const vw = this.video.videoWidth || 16;
      const vh = this.video.videoHeight || 9;
      const scale = Math.min(stage.width / vw, stage.height / vh);
      const w = vw * scale;
      const h = vh * scale;
      const dpr = this.win.devicePixelRatio || 1;
      Object.assign(this.canvas.style, { left: `${(stage.width - w) / 2}px`, top: `${(stage.height - h) / 2}px`, width: `${w}px`, height: `${h}px` });
      if (this.canvas.width !== Math.round(w * dpr)) { this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr); }
    }

    paint() {
      const { ctx, canvas } = this;
      const t = this.getTime();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of this.strokes) {
        const al = alphaAt(s, t, strokeEnd(s, this.clears, Infinity));
        if (al > 0) drawShape(ctx, s, canvas.width, canvas.height, al);
      }
      if (this.drawing) drawShape(ctx, this.drawing, canvas.width, canvas.height);
    }

    bind(d) {
      const pos = (e) => {
        const r = this.canvas.getBoundingClientRect();
        return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
      };
      this.canvas.onpointerdown = (e) => {
        const [x, y] = pos(e);
        this.drawing = { tool: this.tool, color: this.color, width: this.tool === 'pen' ? 0.006 : 0.005, x1: x, y1: y, x2: x, y2: y, points: [[x, y]], mode: this.mode };
        this.canvas.setPointerCapture(e.pointerId);
      };
      this.canvas.onpointermove = (e) => {
        if (!this.drawing) return;
        const [x, y] = pos(e);
        this.drawing.x2 = x;
        this.drawing.y2 = y;
        if (this.drawing.tool === 'pen') this.drawing.points.push([+x.toFixed(4), +y.toFixed(4)]);
      };
      this.canvas.onpointerup = () => {
        const s = this.drawing;
        this.drawing = null;
        if (!s) return;
        const big = Math.abs(s.x2 - s.x1) > 0.005 || Math.abs(s.y2 - s.y1) > 0.005;
        if (s.tool === 'pen' ? s.points.length > 2 : big) this.strokes.push({ ...s, t: +this.getTime().toFixed(3) });
      };
      d.querySelector('.pad-bar').onclick = (e) => {
        const tool = e.target.closest('[data-tool]');
        const color = e.target.closest('[data-color]');
        if (tool) { this.tool = tool.dataset.tool; d.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b === tool)); }
        if (color) { this.color = color.dataset.color; d.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b === color)); }
        if (e.target.closest('[data-mode]')) {
          this.mode = this.mode === 'fade' ? 'keep' : 'fade';
          e.target.textContent = this.mode === 'fade' ? 'Fade' : 'Keep';
        }
        if (e.target.closest('[data-clear]')) this.clears.push(+this.getTime().toFixed(3));
      };
      d.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.strokes.pop(); }
        if (e.key === 'Escape') this.clears.push(+this.getTime().toFixed(3));
      });
      d.querySelector('[data-pause]').onclick = () => this.onPause();
      d.querySelector('[data-stop]').onclick = () => this.onStop();
    }

    close() {
      if (this.win && !this.win.closed) this.win.close();
    }

    // Rasterise every slice at (capped) capture resolution and upload it. Returns slice count.
    async upload(videoId, total, onProgress) {
      if (!this.strokes.length) return 0;
      const settings = this.stream.getVideoTracks()[0]?.getSettings() || {};
      const sw = settings.width || 1920;
      const sh = settings.height || 1080;
      const scale = Math.min(1, 1920 / Math.max(sw, sh));
      const W = Math.round(sw * scale);
      const H = Math.round(sh * scale);
      const list = slices(this.strokes, this.clears, total);
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      let done = 0;
      const send = async (sl, i) => {
        ctx.clearRect(0, 0, W, H);
        sl.visible.forEach(([s, al]) => drawShape(ctx, s, W, H, al));
        const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
        const qs = new URLSearchParams({ i, start: sl.start.toFixed(3), end: sl.end.toFixed(3) });
        for (let attempt = 0; ; attempt++) {
          const r = await fetch(`/api/videos/${videoId}/live?${qs}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/png' }, credentials: 'same-origin' });
          if (r.ok) break;
          if (attempt >= 3) throw new Error('Could not save drawings');
          await new Promise((res) => setTimeout(res, 800 * 2 ** attempt));
        }
        onProgress?.(++done / list.length);
      };
      // One shared canvas, so slices render and upload one at a time.
      for (const [i, sl] of list.entries()) await send(sl, i);
      return list.length;
    }
  }

  window.DrawPad = { DrawPad, supported, slices };
})();
