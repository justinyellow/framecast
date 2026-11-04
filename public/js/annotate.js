(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  let base = null; // ImageBitmap/HTMLImageElement/canvas of the captured image
  let crop = null; // {x,y,w,h} in base pixels
  let shapes = [];
  let tool = 'arrow';
  let drawing = null;

  fc.brand();

  function showError(msg) {
    $('err').textContent = msg;
    $('err').hidden = !msg;
  }

  function setImage(img) {
    base = img;
    crop = null;
    shapes = [];
    $('hint').hidden = true;
    canvas.hidden = false;
    $('tools').hidden = false;
    redraw();
  }

  async function capture() {
    showError('');
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false, selfBrowserSurface: 'exclude' });
      const track = stream.getVideoTracks()[0];
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();
      // Give the share picker a moment to disappear from the captured frame.
      await new Promise((r) => setTimeout(r, 350));
      const c = document.createElement('canvas');
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      track.stop();
      setImage(c);
    } catch (e) {
      if (e.name !== 'NotAllowedError') showError(e.message);
    }
  }

  function loadBlob(blob) {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = URL.createObjectURL(blob);
  }

  const view = () => crop || { x: 0, y: 0, w: base.width, h: base.height };

  function pixelate(r) {
    const { x, y, w, h } = normRect(r);
    if (w < 2 || h < 2) return;
    const block = Math.max(6, Math.round(Math.min(w, h) / 12));
    const tmp = document.createElement('canvas');
    tmp.width = Math.max(1, Math.round(w / block));
    tmp.height = Math.max(1, Math.round(h / block));
    tmp.getContext('2d').drawImage(base, x, y, w, h, 0, 0, tmp.width, tmp.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, tmp.width, tmp.height, x, y, w, h);
    ctx.imageSmoothingEnabled = true;
  }

  const normRect = (r) => ({ x: Math.min(r.x1, r.x2), y: Math.min(r.y1, r.y2), w: Math.abs(r.x2 - r.x1), h: Math.abs(r.y2 - r.y1) });

  function drawShape(s) {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.tool === 'blur') pixelate(s);
    if (s.tool === 'rect') {
      const r = normRect(s);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    if (s.tool === 'highlight') {
      const r = normRect(s);
      ctx.globalAlpha = 0.3;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    if (s.tool === 'pen') {
      ctx.beginPath();
      s.points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
      ctx.stroke();
    }
    if (s.tool === 'arrow') {
      const head = Math.max(12, s.width * 4);
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      ctx.beginPath();
      ctx.moveTo(s.x1, s.y1);
      ctx.lineTo(s.x2 - Math.cos(ang) * head * 0.6, s.y2 - Math.sin(ang) * head * 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(ang - Math.PI / 7), s.y2 - head * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(s.x2 - head * Math.cos(ang + Math.PI / 7), s.y2 - head * Math.sin(ang + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    }
    if (s.tool === 'text') {
      const size = Math.max(16, s.width * 5);
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      const m = ctx.measureText(s.text);
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(s.x1 - 6, s.y1 - 4, m.width + 12, size + 10);
      ctx.fillStyle = s.color;
      ctx.fillText(s.text, s.x1, s.y1);
    }
    if (s.tool === 'crop') {
      const r = normRect(s);
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  }

  function redraw() {
    const v = view();
    canvas.width = v.w;
    canvas.height = v.h;
    ctx.setTransform(1, 0, 0, 1, -v.x, -v.y);
    ctx.drawImage(base, 0, 0);
    shapes.forEach(drawShape);
    if (drawing) drawShape(drawing);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // Pointer position in base-image pixels.
  function pos(e) {
    const r = canvas.getBoundingClientRect();
    const v = view();
    return [v.x + ((e.clientX - r.left) / r.width) * v.w, v.y + ((e.clientY - r.top) / r.height) * v.h];
  }

  canvas.onpointerdown = (e) => {
    if (!base) return;
    const [x, y] = pos(e);
    const style = { color: $('color').value, width: Number($('width').value) * Math.max(1, base.width / 1600) };
    if (tool === 'text') {
      const text = prompt('Text');
      if (text) { shapes.push({ tool, x1: x, y1: y, text, ...style }); redraw(); }
      return;
    }
    drawing = { tool, x1: x, y1: y, x2: x, y2: y, points: [[x, y]], ...style };
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
    const r = normRect(d);
    if (d.tool === 'crop') {
      if (r.w > 10 && r.h > 10) crop = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
      selectTool('arrow');
    } else if (d.tool === 'pen' ? d.points.length > 1 : r.w > 3 || r.h > 3) {
      shapes.push(d);
    }
    redraw();
  };

  function selectTool(t) {
    tool = t;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  }
  $('tools').onclick = (e) => {
    const b = e.target.closest('[data-tool]');
    if (b) selectTool(b.dataset.tool);
  };
  const undo = () => {
    if (shapes.length) shapes.pop();
    else crop = null;
    redraw();
  };
  $('undo').onclick = undo;
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); undo(); }
  });

  $('capture').onclick = capture;
  $('open').onchange = () => { if ($('open').files[0]) loadBlob($('open').files[0]); };
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) loadBlob(item.getAsFile());
  });

  $('save').onclick = async () => {
    $('save').disabled = true;
    try {
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
      const qs = new URLSearchParams({ w: canvas.width, h: canvas.height, ...($('title').value.trim() ? { title: $('title').value.trim() } : {}) });
      const r = await fetch(`/api/images?${qs}`, { method: 'POST', body: blob, headers: { 'Content-Type': 'image/png' }, credentials: 'same-origin' });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error || 'Upload failed');
      await fc.copy(v.shareUrl).catch(() => {});
      location.href = `/v/${v.slug}`;
    } catch (e) {
      showError(e.message);
      $('save').disabled = false;
    }
  };

  if (new URLSearchParams(location.search).get('capture') === '1') $('hint').textContent = 'Press “Capture screen” to pick what to capture.';
})();
