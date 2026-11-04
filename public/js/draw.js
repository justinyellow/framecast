// Owner tool: pause the video, draw on top of it, and show the drawing for a few seconds.
// Drawings are rendered to a transparent PNG at the video's resolution and burned in by the worker.
(() => {
  const S = window.FCShare;
  const TL = window.FCTimeline;
  if (!S || S.meta.kind !== 'video') return;
  const $ = (id) => document.getElementById(id);

  let active = false;
  let tool = 'arrow';
  let shapes = [];
  let drawing = null;
  let canvas = null;
  let ctx = null;
  let dirty = false;

  const bar = document.createElement('div');
  bar.className = 'tools draw-tools';
  bar.hidden = true;
  bar.innerHTML = `
    ${[['arrow', 'Arrow'], ['rect', 'Box'], ['highlight', 'Highlight'], ['pen', 'Pen'], ['text', 'Text'], ['click', 'Click']].map(([k, l]) => `<button class="tool ${k === tool ? 'active' : ''}" data-tool="${k}">${l}</button>`).join('')}
    <input type="color" id="d-color" value="#e5484d" title="Color">
    <label class="small muted">Show for <select id="d-dur" style="width:auto;padding:4px 8px">
      <option value="auto">Auto</option><option value="1">1s</option><option value="2">2s</option><option value="3">3s</option><option value="5">5s</option><option value="8">8s</option>
    </select></label>
    <span class="grow"></span>
    <button class="tool" id="d-undo">Undo</button>
    <button class="btn btn-ghost btn-sm" id="d-cancel">Cancel</button>
    <button class="btn btn-primary btn-sm" id="d-add">Add to video</button>`;

  const list = document.createElement('div');
  list.className = 'ann-list';

  const player = () => S.player;
  const W = () => S.meta.width || 1920;
  const H = () => S.meta.height || 1080;
  const keeps = () => TL.keepSegments(S.meta.edits, S.meta.sourceDurationS);
  const color = () => $('d-color').value;
  const lineW = () => Math.max(4, Math.round(H() / 180));

  function mountButton() {
    const pb = $('player-bar');
    if (!pb || $('annotate-btn')) return;
    const b = document.createElement('button');
    b.className = 'btn btn-sm';
    b.id = 'annotate-btn';
    b.textContent = '✎ Annotate';
    b.title = 'Pause and draw on the video';
    b.onclick = start;
    pb.lastElementChild.prepend(b);
    pb.after(bar);
    bar.after(list);
    renderList();
  }

  function start() {
    if (!player() || S.meta.status !== 'ready') return;
    player().pause();
    active = true;
    shapes = [];
    canvas = document.createElement('canvas');
    canvas.className = 'draw-layer';
    canvas.width = W();
    canvas.height = H();
    ctx = canvas.getContext('2d');
    $('player-wrap').appendChild(canvas);
    bar.hidden = false;
    $('annotate-btn').hidden = true;
    bindCanvas();
    redraw();
  }

  function stop() {
    active = false;
    canvas?.remove();
    canvas = null;
    bar.hidden = true;
    if ($('annotate-btn')) $('annotate-btn').hidden = false;
  }

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };

  function drawShape(c, s) {
    c.save();
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = s.width;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const r = { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
    if (s.tool === 'rect') { c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = 6; c.strokeRect(r.x, r.y, r.w, r.h); }
    if (s.tool === 'highlight') { c.globalAlpha = 0.28; c.fillRect(r.x, r.y, r.w, r.h); }
    if (s.tool === 'pen') {
      c.beginPath();
      s.points.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.stroke();
    }
    if (s.tool === 'arrow') {
      const head = s.width * 4.5;
      const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      c.shadowColor = 'rgba(0,0,0,.35)';
      c.shadowBlur = 6;
      c.beginPath();
      c.moveTo(s.x1, s.y1);
      c.lineTo(s.x2 - Math.cos(a) * head * 0.6, s.y2 - Math.sin(a) * head * 0.6);
      c.stroke();
      c.beginPath();
      c.moveTo(s.x2, s.y2);
      c.lineTo(s.x2 - head * Math.cos(a - Math.PI / 7), s.y2 - head * Math.sin(a - Math.PI / 7));
      c.lineTo(s.x2 - head * Math.cos(a + Math.PI / 7), s.y2 - head * Math.sin(a + Math.PI / 7));
      c.closePath();
      c.fill();
    }
    if (s.tool === 'click') {
      const R = H() / 22;
      c.globalAlpha = 0.25;
      c.beginPath(); c.arc(s.x1, s.y1, R, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 0.9;
      c.lineWidth = Math.max(3, R / 6);
      c.beginPath(); c.arc(s.x1, s.y1, R, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(s.x1, s.y1, R * 0.28, 0, Math.PI * 2); c.fill();
    }
    if (s.tool === 'text') {
      const size = Math.round(H() / 22);
      c.font = `600 ${size}px system-ui, sans-serif`;
      c.textBaseline = 'top';
      const m = c.measureText(s.text);
      c.fillStyle = 'rgba(0,0,0,.65)';
      const pad = size * 0.35;
      c.beginPath();
      c.roundRect?.(s.x1 - pad, s.y1 - pad, m.width + pad * 2, size + pad * 2, pad);
      if (!c.roundRect) c.rect(s.x1 - pad, s.y1 - pad, m.width + pad * 2, size + pad * 2);
      c.fill();
      c.fillStyle = s.color;
      c.fillText(s.text, s.x1, s.y1);
    }
    c.restore();
  }

  function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    shapes.forEach((s) => drawShape(ctx, s));
    if (drawing) drawShape(ctx, drawing);
  }

  function bindCanvas() {
    canvas.onpointerdown = (e) => {
      const [x, y] = pos(e);
      const base = { tool, color: color(), width: lineW(), x1: x, y1: y, x2: x, y2: y };
      if (tool === 'click') { shapes.push(base); return redraw(); }
      if (tool === 'text') {
        const text = prompt('Text');
        if (text?.trim()) { shapes.push({ ...base, text: text.trim() }); redraw(); }
        return;
      }
      drawing = { ...base, points: [[x, y]] };
      canvas.setPointerCapture(e.pointerId);
    };
    canvas.onpointermove = (e) => {
      if (!drawing) return;
      const [x, y] = pos(e);
      drawing.x2 = x;
      drawing.y2 = y;
      if (drawing.tool === 'pen') drawing.points.push([x, y]);
      redraw();
    };
    canvas.onpointerup = () => {
      if (!drawing) return;
      const d = drawing;
      drawing = null;
      const big = Math.abs(d.x2 - d.x1) > 4 || Math.abs(d.y2 - d.y1) > 4;
      if (d.tool === 'pen' ? d.points.length > 2 : big) shapes.push(d);
      redraw();
    };
  }

  bar.onclick = (e) => {
    const t = e.target.closest('[data-tool]');
    if (!t) return;
    tool = t.dataset.tool;
    bar.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b === t));
  };
  bar.querySelector('#d-undo').onclick = () => { shapes.pop(); redraw(); };
  bar.querySelector('#d-cancel').onclick = stop;
  bar.querySelector('#d-add').onclick = async () => {
    if (!shapes.length) return fc.toast('Draw something first');
    const onlyClicks = shapes.every((s) => s.tool === 'click');
    const choice = $('d-dur').value;
    const dur = choice === 'auto' ? (onlyClicks ? 0.9 : 3) : Number(choice);
    const outT = player().currentTime;
    const srcT = TL.toSource(outT, keeps());
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    try {
      const qs = new URLSearchParams({ start: srcT.toFixed(3), dur, kind: onlyClicks ? 'click' : 'drawing' });
      const r = await fetch(`/api/videos/${S.meta.id}/annotations?${qs}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/png' }, credentials: 'same-origin' });
      const ann = await r.json();
      if (!r.ok) throw new Error(ann.error || 'Could not save');
      S.meta = { ...S.meta, edits: { ...(S.meta.edits || {}), annotations: [...(S.meta.edits?.annotations || []), ann] } };
      dirty = true;
      stop();
      renderList();
      fc.toast(`Added at ${fc.fmtTime(outT)}. Render when you're done.`);
    } catch (err) {
      fc.toast(err.message);
    }
  };

  document.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key === 'Escape') stop();
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); shapes.pop(); redraw(); }
  });

  function renderList() {
    const anns = [...(S.meta.edits?.annotations || [])];
    const k = keeps();
    const rows = anns.map((a) => ({ ...a, out: TL.toOutput(a.start, k) })).sort((x, y) => (x.out ?? 1e9) - (y.out ?? 1e9));
    list.hidden = !rows.length && !dirty;
    list.innerHTML = `
      <div class="row between wrap">
        <span class="small muted">${rows.length} annotation${rows.length === 1 ? '' : 's'}${dirty ? ' · not rendered yet' : ''}</span>
        ${dirty ? '<button class="btn btn-primary btn-sm" id="d-render">Render video</button>' : ''}
      </div>
      <div class="row wrap" style="margin-top:6px">${rows.map((a) => `<span class="ann-chip">
        <button class="ts-chip" data-seek="${a.out ?? ''}" ${a.out == null ? 'disabled title="Inside a cut"' : ''}>${a.out == null ? 'cut' : fc.fmtTime(a.out)}</button>
        ${a.kind === 'click' ? 'Click' : 'Drawing'} · ${a.dur}s
        <button class="del" data-rm="${a.id}" title="Remove">×</button></span>`).join('')}</div>`;
    const render = list.querySelector('#d-render');
    if (render) {
      render.onclick = async () => {
        try {
          const updated = await fc.api(`/api/videos/${S.meta.id}/reprocess`, { method: 'POST' });
          dirty = false;
          S.meta = updated;
          S.render();
          S.poll();
          renderList();
          fc.toast('Rendering… the link keeps working.');
        } catch (e) { fc.toast(e.message); }
      };
    }
    list.querySelectorAll('[data-seek]').forEach((b) => { b.onclick = () => b.dataset.seek !== '' && S.seek(Number(b.dataset.seek)); });
    list.querySelectorAll('[data-rm]').forEach((b) => {
      b.onclick = async () => {
        try {
          await fc.api(`/api/videos/${S.meta.id}/annotations/${b.dataset.rm}`, { method: 'DELETE' });
          S.meta = { ...S.meta, edits: { ...S.meta.edits, annotations: S.meta.edits.annotations.filter((a) => a.id !== b.dataset.rm) } };
          dirty = true;
          renderList();
        } catch (e) { fc.toast(e.message); }
      };
    });
  }

  // The player is re-created after each render; re-attach the button when it appears.
  const prev = S.onUpdate;
  S.onUpdate = (m) => { prev?.(m); mountButton(); renderList(); };
  const wait = setInterval(() => { if ($('player-bar') && !$('player-bar').hidden) { mountButton(); clearInterval(wait); } }, 300);
})();
