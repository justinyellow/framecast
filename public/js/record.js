(() => {
  const $ = (id) => document.getElementById(id);
  let mode = 'screen-cam';
  let camPos = 'bottom-left';
  let camSize = 'm';
  const BUBBLE_PCT = { s: '15%', m: '22%', l: '30%' };
  let camStream = null;
  let micStream = null;
  let displayStream = null;
  let audioCtx = null;
  let video = null;
  let recorders = [];
  let uploaders = [];
  let elapsed = 0;
  let tickStart = 0;
  let timer = null;
  let state = 'idle';
  let pad = null;
  // Recording clock in seconds, excluding paused time: matches the recorded media timeline.
  const recTime = () => (elapsed + (state === 'recording' ? performance.now() - tickStart : 0)) / 1000;

  const usesCam = () => mode !== 'screen';
  const usesScreen = () => mode !== 'cam';

  function showError(msg) {
    $('err').textContent = msg;
    $('err').hidden = !msg;
  }

  function pickMime() {
    const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  const stopStream = (s) => s && s.getTracks().forEach((t) => t.stop());

  async function listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, noneLabel) => {
      const prev = sel.value;
      const opts = devices.filter((d) => d.kind === kind)
        .map((d, i) => `<option value="${d.deviceId}">${fc.esc(d.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${i + 1}`)}</option>`);
      sel.innerHTML = (noneLabel ? `<option value="none">${noneLabel}</option>` : '') + opts.join('');
      if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
      else if (sel.options.length > (noneLabel ? 1 : 0)) sel.selectedIndex = noneLabel ? 1 : 0;
    };
    fill($('cam'), 'videoinput');
    fill($('mic'), 'audioinput', 'No microphone');
  }

  async function refreshCam() {
    stopStream(camStream);
    camStream = null;
    $('bubble').hidden = true;
    if (!usesCam()) return renderPreview();
    try {
      const id = $('cam').value;
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: id ? { exact: id } : undefined, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      $('cam-video').srcObject = camStream;
    } catch (e) {
      showError(`Camera unavailable: ${e.message}`);
    }
    renderPreview();
  }

  async function refreshMic() {
    stopStream(micStream);
    micStream = null;
    if ($('mic').value === 'none') return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: $('mic').value ? { exact: $('mic').value } : undefined, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      showError(`Microphone unavailable: ${e.message}`);
    }
  }

  function renderPreview() {
    const main = $('main-video');
    const src = displayStream || (mode === 'cam' ? camStream : null);
    if (main.srcObject !== src) main.srcObject = src;
    main.hidden = !src;
    main.style.transform = !displayStream && mode === 'cam' ? 'scaleX(-1)' : '';
    $('bubble').hidden = !(mode === 'screen-cam' && camStream);
    $('hint').hidden = !!src;
    $('cam-field').hidden = !usesCam();
    $('bubble-opts').hidden = mode !== 'screen-cam';
    const b = $('bubble').style;
    b.width = BUBBLE_PCT[camSize];
    b.left = camPos.endsWith('left') ? '16px' : 'auto';
    b.right = camPos.endsWith('right') ? '16px' : 'auto';
    b.top = camPos.startsWith('top') ? '16px' : 'auto';
    b.bottom = camPos.startsWith('bottom') ? '16px' : 'auto';
  }

  $('pos').onclick = (e) => {
    const p = e.target.closest('[data-pos]');
    if (!p) return;
    camPos = p.dataset.pos;
    $('pos').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === p));
    renderPreview();
  };
  $('size').onclick = (e) => {
    const s = e.target.closest('[data-size]');
    if (!s) return;
    camSize = s.dataset.size;
    $('size').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === s));
    renderPreview();
  };

  function mixAudio() {
    const sources = [];
    if (micStream) sources.push(micStream);
    const sys = displayStream?.getAudioTracks() || [];
    if (sys.length) sources.push(new MediaStream(sys));
    if (!sources.length) return [];
    audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    sources.forEach((s) => audioCtx.createMediaStreamSource(s).connect(dest));
    return dest.stream.getAudioTracks();
  }

  async function countdown() {
    const el = $('countdown');
    el.hidden = false;
    for (let i = 3; i > 0; i--) {
      el.textContent = i;
      await new Promise((r) => setTimeout(r, 800));
    }
    el.hidden = true;
  }

  function startTimer() {
    tickStart = performance.now();
    timer = setInterval(() => {
      $('time').textContent = fc.fmtTime((elapsed + performance.now() - tickStart) / 1000);
    }, 250);
  }

  function pauseTimer() {
    elapsed += performance.now() - tickStart;
    clearInterval(timer);
  }

  function updateUploadStatus() {
    const sent = uploaders.reduce((a, u) => a + u.sent, 0);
    $('up-status').textContent = sent ? `${(sent / 1048576).toFixed(1)} MB uploaded` : '';
  }

  function makeRecorder(stream, uploader, bitrate, mimeType) {
    const rec = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: bitrate });
    rec.ondataavailable = (e) => uploader.push(e.data);
    rec.stopped = new Promise((r) => { rec.onstop = r; });
    return rec;
  }

  async function start() {
    showError('');
    try {
      if (usesScreen()) {
        // Must be called directly from the click to keep the user gesture.
        displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30 }, width: { max: 2560 }, height: { max: 1440 } },
          audio: $('sysaudio').checked,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
        });
        displayStream.getVideoTracks()[0].addEventListener('ended', () => state !== 'idle' && stop());
      }
      if (usesCam() && !camStream) throw new Error('Camera is not available');

      // Live draw pad (Chrome/Edge): floating preview to draw on, plus timer and controls.
      // Falls back to a camera-only Picture-in-Picture so you can still see yourself.
      if (usesScreen() && DrawPad.supported()) {
        pad = new DrawPad.DrawPad({
          stream: displayStream,
          camStream: mode === 'screen-cam' ? camStream : null,
          getTime: recTime,
          isPaused: () => state === 'paused',
          onPause: togglePause,
          onStop: stop,
        });
        await pad.open().catch(() => {}); // needs a fresh click if the picker took a while
      } else if (mode === 'screen-cam' && document.pictureInPictureEnabled) {
        $('cam-video').requestPictureInPicture().catch(() => {});
      }
      renderPreview();
      await countdown();

      const mimeType = pickMime();
      const hasCamera = mode === 'screen-cam';
      video = await fc.api('/api/videos', { json: {
        title: $('title').value.trim() || undefined, hasCamera, mimeType, cameraPosition: camPos, cameraSize: camSize,
        folderId: new URLSearchParams(location.search).get('folder') || undefined,
      } });

      const audio = mixAudio();
      const mainVideo = usesScreen() ? displayStream.getVideoTracks()[0] : camStream.getVideoTracks()[0];
      const screenUp = new TrackUploader(video.id, 'screen', updateUploadStatus);
      uploaders = [screenUp];
      recorders = [makeRecorder(new MediaStream([mainVideo, ...audio]), screenUp, 4_000_000, mimeType)];
      if (hasCamera) {
        const camUp = new TrackUploader(video.id, 'cam', updateUploadStatus);
        uploaders.push(camUp);
        recorders.push(makeRecorder(new MediaStream(camStream.getVideoTracks()), camUp, 1_500_000, mimeType));
      }
      recorders.forEach((r) => r.start(1000));

      state = 'recording';
      $('setup').hidden = true;
      $('start-row').hidden = true;
      $('rec-bar').hidden = false;
      $('pip').hidden = !!pad || !(hasCamera && document.pictureInPictureEnabled);
      $('padbtn').hidden = !pad;
      startTimer();
    } catch (e) {
      cleanup();
      if (e.name !== 'NotAllowedError') showError(e.message);
    }
  }

  function togglePause() {
    if (state === 'recording') {
      recorders.forEach((r) => r.pause());
      pauseTimer();
      state = 'paused';
      $('pause').textContent = 'Resume';
      $('dot').classList.add('paused');
    } else if (state === 'paused') {
      recorders.forEach((r) => r.resume());
      startTimer();
      state = 'recording';
      $('pause').textContent = 'Pause';
      $('dot').classList.remove('paused');
    }
  }

  async function stop() {
    if (state !== 'recording' && state !== 'paused') return;
    const total = recTime();
    state = 'finishing';
    clearInterval(timer);
    $('stop').disabled = true;
    $('pause').disabled = true;
    $('stop').textContent = 'Finishing…';
    recorders.forEach((r) => r.state !== 'inactive' && r.stop());
    await Promise.all(recorders.map((r) => r.stopped));
    pad?.close();
    releaseDevices();
    try {
      await Promise.all(uploaders.map((u) => u.finish()));
      if (pad?.strokes.length) {
        $('up-status').textContent = 'Saving drawings…';
        await pad.upload(video.id, total, (p) => { $('up-status').textContent = `Saving drawings… ${Math.round(p * 100)}%`; });
      }
      const done = await fc.api(`/api/videos/${video.id}/complete`, { method: 'POST' });
      await fc.copy(done.shareUrl).catch(() => {});
      location.href = `/v/${done.slug}`;
    } catch (e) {
      showError(`Upload failed: ${e.message}`);
      $('stop').textContent = 'Failed';
    }
  }

  async function cancel() {
    if (!confirm('Discard this recording?')) return;
    state = 'idle';
    recorders.forEach((r) => r.state !== 'inactive' && r.stop());
    if (video) await fc.api(`/api/videos/${video.id}`, { method: 'DELETE' }).catch(() => {});
    location.reload();
  }

  function releaseDevices() {
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    stopStream(displayStream);
    stopStream(camStream);
    stopStream(micStream);
    audioCtx?.close();
  }

  function cleanup() {
    stopStream(displayStream);
    displayStream = null;
    audioCtx?.close();
    audioCtx = null;
    state = 'idle';
    renderPreview();
  }

  document.querySelectorAll('.mode').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.mode').forEach((x) => x.classList.toggle('active', x === b));
      mode = b.dataset.mode;
      refreshCam();
    };
  });
  $('cam').onchange = refreshCam;
  $('mic').onchange = refreshMic;
  $('start').onclick = start;
  $('stop').onclick = stop;
  $('pause').onclick = togglePause;
  $('cancel').onclick = cancel;
  $('padbtn').onclick = () => pad?.open().catch((e) => fc.toast(e.message));
  $('pip').onclick = () => $('cam-video').requestPictureInPicture().catch((e) => fc.toast(e.message));
  window.addEventListener('beforeunload', (e) => {
    if (state === 'recording' || state === 'paused' || state === 'finishing') e.preventDefault();
  });

  (async () => {
    fc.brand();
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
      showError('This browser does not support screen recording. Use a recent Chrome, Edge, Firefox or Safari.');
      $('start').disabled = true;
      return;
    }
    try {
      // Ask once up front so device labels are available.
      const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      stopStream(s);
    } catch {
      try { stopStream(await navigator.mediaDevices.getUserMedia({ audio: true })); } catch { /* ignore */ }
    }
    await listDevices();
    await Promise.all([refreshCam(), refreshMic()]);
  })();
})();
