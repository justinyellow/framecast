(() => {
  const $ = (id) => document.getElementById(id);
  const boot = window.FC;
  const slug = boot.video.slug;
  let meta = boot.video;
  let player = null;
  let activity = { comments: [], reactions: [], emoji: [] };
  let lines = [];
  let currentSrc = null;

  const viewerId = (() => {
    try {
      let id = localStorage.getItem('fc_viewer');
      if (!id) localStorage.setItem('fc_viewer', (id = crypto.randomUUID()));
      return id;
    } catch {
      return crypto.randomUUID();
    }
  })();
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  $('created').textContent = new Date($('created').getAttribute('datetime')).toLocaleDateString(undefined, { dateStyle: 'medium' });
  const isVideo = () => meta.kind === 'video';
  const now = () => (player && isVideo() ? player.currentTime : null);
  const seek = (t) => {
    if (!player || !isVideo()) return;
    player.currentTime = t;
    player.play().catch(() => {});
  };

  // ---------- Player ----------
  function placeholder(html) {
    $('player-wrap').innerHTML = `<div class="player-placeholder">${html}</div>`;
    player = null;
    currentSrc = null;
  }

  function mountImage() {
    const wrap = $('player-wrap');
    wrap.classList.add('image');
    wrap.innerHTML = `<img class="share-img" src="/v/${slug}/media?t=${new Date(meta.updatedAt).getTime()}" alt="">`;
    player = wrap.firstElementChild;
    $('ts-wrap').hidden = true;
  }

  function mountVideo() {
    const src = `/v/${slug}/media?t=${new Date(meta.updatedAt).getTime()}`;
    if (currentSrc === src) return;
    const v = document.createElement('video');
    v.controls = true;
    v.playsInline = true;
    v.preload = 'metadata';
    if (meta.thumbUrl) v.poster = meta.thumbUrl;
    v.src = src;
    if (meta.hasCaptions) {
      const tr = document.createElement('track');
      Object.assign(tr, { kind: 'captions', srclang: 'en', label: 'English', src: `/v/${slug}/captions.vtt?t=${Date.now()}` });
      v.appendChild(tr);
    }
    const wrap = $('player-wrap');
    wrap.innerHTML = '';
    wrap.appendChild(v);
    if (meta.width && meta.height) wrap.style.aspectRatio = `${meta.width} / ${meta.height}`;
    player = v;
    currentSrc = src;

    const resumeKey = `fc_pos_${slug}`;
    v.addEventListener('loadedmetadata', () => {
      const pos = Number(store.get(resumeKey));
      if (pos > 5 && pos < v.duration - 5) {
        v.currentTime = pos;
        fc.toast(`Resumed at ${fc.fmtTime(pos)}`);
      }
      const rate = Number(store.get('fc_rate')) || 1;
      v.playbackRate = rate;
      renderSpeed();
      setCaptions(store.get('fc_cc') === '1');
    });
    v.addEventListener('timeupdate', () => {
      $('comment-ts-label').textContent = fc.fmtTime(v.currentTime);
      if (v.currentTime > 5) store.set(resumeKey, v.currentTime);
      renderProgress();
      highlightTranscript();
    });
    v.addEventListener('ended', () => store.set(resumeKey, 0));
    trackViews(v);
    $('player-bar').hidden = false;
    $('timeline').hidden = false;
    $('cc').hidden = !meta.hasCaptions;
  }

  function trackViews(v) {
    const buckets = new Set();
    let sent = false;
    let last = 0;
    const ping = () => fc.api(`/api/public/${slug}/view`, {
      json: { viewerId, position: v.currentTime, buckets: [...buckets] },
    }).catch(() => {});
    v.addEventListener('play', () => { if (!sent) { sent = true; ping(); } });
    v.addEventListener('timeupdate', () => {
      if (!v.duration || v.paused) return;
      buckets.add(Math.min(49, Math.floor((v.currentTime / v.duration) * 50)));
      if (Date.now() - last > 5000) { last = Date.now(); ping(); }
    });
    v.addEventListener('pause', ping);
    v.addEventListener('ended', ping);
  }

  const SPEEDS = [1, 1.25, 1.5, 2];
  function renderSpeed() {
    $('speed').innerHTML = SPEEDS.map((s) => `<button data-rate="${s}" class="${player?.playbackRate === s ? 'active' : ''}">${s}×</button>`).join('');
  }
  $('speed').onclick = (e) => {
    const b = e.target.closest('[data-rate]');
    if (!b || !player) return;
    player.playbackRate = Number(b.dataset.rate);
    store.set('fc_rate', b.dataset.rate);
    renderSpeed();
  };

  function setCaptions(on) {
    const track = player?.textTracks?.[0];
    if (track) track.mode = on ? 'showing' : 'hidden';
    $('cc').classList.toggle('cc-on', on);
    $('cc').setAttribute('aria-pressed', String(on));
  }
  $('cc').onclick = () => {
    const on = $('cc').getAttribute('aria-pressed') !== 'true';
    store.set('fc_cc', on ? '1' : '0');
    setCaptions(on);
  };

  // ---------- Timeline strip ----------
  function renderTimeline() {
    const dur = meta.durationS;
    if (!dur || !isVideo()) return;
    const pct = (t) => `${Math.min(100, Math.max(0, (t / dur) * 100))}%`;
    const chapters = (meta.chapters || []).filter((c) => c.s > 0.5).map((c) => `<span class="tl-chapter" style="left:${pct(c.s)}" title="${fc.esc(c.title)}"></span>`);
    const comments = activity.comments.filter((c) => c.timestampS != null).map((c) => `<span class="tl-dot" style="left:${pct(c.timestampS)}" data-seek="${c.timestampS}" title="${fc.esc(c.authorName)}: ${fc.esc(c.body.slice(0, 80))}"></span>`);
    const reactions = activity.reactions.filter((r) => r.timestampS != null).map((r) => `<span class="tl-mark" style="left:${pct(r.timestampS)}" data-seek="${r.timestampS}">${r.emoji}</span>`);
    $('timeline').innerHTML = `<span class="tl-progress" id="tl-progress"></span>${chapters.join('')}${comments.join('')}${reactions.join('')}`;
    renderProgress();
  }
  function renderProgress() {
    const el = $('tl-progress');
    if (el && player && meta.durationS) el.style.width = `${(player.currentTime / meta.durationS) * 100}%`;
    const cur = (meta.chapters || []).filter((c) => player && c.s <= player.currentTime + 0.25).pop();
    document.querySelectorAll('#chapters li').forEach((li) => li.classList.toggle('current', cur && Number(li.dataset.s) === cur.s));
  }
  $('timeline').onclick = (e) => {
    const mark = e.target.closest('[data-seek]');
    if (mark) return seek(Number(mark.dataset.seek));
    const r = $('timeline').getBoundingClientRect();
    if (meta.durationS) seek(((e.clientX - r.left) / r.width) * meta.durationS);
  };

  // ---------- Summary & chapters ----------
  function renderSummary() {
    const has = meta.summary || meta.chapters?.length;
    $('summary-card').hidden = !has && !(meta.canEdit && meta.aiStatus === 'processing');
    $('summary').textContent = meta.summary || (meta.aiStatus === 'processing' ? 'Writing a summary…' : '');
    $('chapters').innerHTML = (meta.chapters || []).map((c) => `<li data-s="${c.s}"><button data-seek="${c.s}"><span class="ts-chip">${fc.fmtTime(c.s)}</span>${fc.esc(c.title)}</button></li>`).join('');
    $('regen').hidden = !(meta.canEdit && meta.transcriptStatus === 'ready');
  }
  $('chapters').onclick = (e) => {
    const b = e.target.closest('[data-seek]');
    if (b) seek(Number(b.dataset.seek));
  };
  $('regen').onclick = async () => {
    try {
      await fc.api(`/api/videos/${meta.id}/ai`, { method: 'POST' });
      meta.aiStatus = 'processing';
      renderSummary();
      poll();
    } catch (e) {
      fc.toast(e.message);
    }
  };

  // ---------- Transcript ----------
  async function loadTranscript() {
    if (!isVideo() || meta.transcriptStatus !== 'ready') {
      $('transcript-tab').hidden = true;
      return;
    }
    lines = (await fc.api(`/api/public/${slug}/transcript`)).lines;
    $('transcript-tab').hidden = !lines.length;
    renderTranscript();
  }
  function renderTranscript() {
    const q = $('transcript-search').value.trim().toLowerCase();
    const mark = (text) => {
      const safe = fc.esc(text);
      if (!q) return safe;
      return safe.replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
    };
    const shown = q ? lines.filter((l) => l.text.toLowerCase().includes(q)) : lines;
    $('transcript').innerHTML = shown.length
      ? shown.map((l) => `<button class="line" data-seek="${l.s}" data-s="${l.s}"><span class="t">${fc.fmtTime(l.s)}</span><span>${mark(l.text)}</span></button>`).join('')
      : '<p class="muted small">No matches.</p>';
  }
  function highlightTranscript() {
    if (!lines.length || !player) return;
    const t = player.currentTime;
    let cur = null;
    for (const l of lines) if (l.s <= t + 0.1) cur = l.s;
    document.querySelectorAll('#transcript .line').forEach((el) => el.classList.toggle('current', Number(el.dataset.s) === cur));
  }
  $('transcript-search').oninput = renderTranscript;
  $('transcript').onclick = (e) => {
    const b = e.target.closest('[data-seek]');
    if (b) seek(Number(b.dataset.seek));
  };

  document.querySelectorAll('.side-tabs .tab').forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll('.side-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
      document.querySelectorAll('[data-side-body]').forEach((b) => { b.hidden = b.dataset.sideBody !== t.dataset.side; });
    };
  });

  // ---------- Comments & reactions ----------
  function renderActivity() {
    const items = [
      ...activity.comments.map((c) => ({ ...c, type: 'comment' })),
      ...activity.reactions.map((r) => ({ ...r, type: 'reaction' })),
    ].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    $('comment-count').textContent = activity.comments.length || '';
    const ts = (t) => (t != null && isVideo() ? `<button class="ts-chip" data-seek="${t}">${fc.fmtTime(t)}</button>` : '');
    $('activity').innerHTML = items.length ? items.map((x) => (x.type === 'reaction'
      ? `<li class="activity-reaction"><span style="font-size:16px">${x.emoji}</span>${ts(x.timestampS)}<span>${fc.esc(x.authorName || 'Someone')} reacted · ${fc.fmtAgo(x.createdAt)}</span></li>`
      : `<li class="comment">
          <div class="comment-head"><strong>${fc.esc(x.authorName)}</strong><time>${fc.fmtAgo(x.createdAt)}</time>
            ${x.canDelete ? `<button class="del" data-del="${x.id}">Delete</button>` : ''}</div>
          <div class="comment-body">${ts(x.timestampS)}${fc.esc(x.body)}</div>
        </li>`)).join('')
      : `<li class="muted small">No comments yet.${isVideo() ? ' Leave one at a specific moment.' : ''}</li>`;
    renderTimeline();
  }

  async function loadActivity() {
    activity = await fc.api(`/api/public/${slug}/activity`);
    $('reaction-bar').innerHTML = activity.emoji.map((e) => `<button class="react-btn" data-emoji="${e}" title="React at the current moment">${e}</button>`).join('');
    renderActivity();
  }

  const authorName = () => boot.user?.name || $('comment-name').value.trim() || store.get('fc_name') || null;

  $('reaction-bar').onclick = async (e) => {
    const b = e.target.closest('[data-emoji]');
    if (!b) return;
    try {
      const r = await fc.api(`/api/public/${slug}/reactions`, { json: { emoji: b.dataset.emoji, timestampS: now(), viewerId, authorName: authorName() } });
      activity.reactions.push(r);
      renderActivity();
      b.animate([{ transform: 'scale(1.4)' }, { transform: 'scale(1)' }], { duration: 250 });
    } catch (err) {
      fc.toast(err.message);
    }
  };

  $('activity').onclick = async (e) => {
    const s = e.target.closest('[data-seek]');
    if (s) seek(Number(s.dataset.seek));
    const del = e.target.closest('[data-del]');
    if (del && confirm('Delete this comment?')) {
      await fc.api(`/api/comments/${del.dataset.del}`, { method: 'DELETE' });
      activity.comments = activity.comments.filter((c) => c.id !== del.dataset.del);
      renderActivity();
    }
  };

  $('comment-name').value = store.get('fc_name') || '';
  $('comment-form').onsubmit = async (e) => {
    e.preventDefault();
    const name = $('comment-name').value.trim();
    if (name) store.set('fc_name', name);
    try {
      const c = await fc.api(`/api/public/${slug}/comments`, {
        json: { body: $('comment-body').value, authorName: name, timestampS: $('comment-ts').checked ? now() : null },
      });
      activity.comments.push(c);
      renderActivity();
      $('comment-body').value = '';
      $('activity').lastElementChild?.scrollIntoView({ block: 'nearest' });
    } catch (err) {
      fc.toast(err.message);
    }
  };

  $('copy-link').onclick = () => fc.copy(meta.shareUrl);

  // ---------- Status / polling ----------
  function render() {
    const ready = meta.status === 'ready';
    const dl = $('download');
    dl.hidden = !(ready && (meta.allowDownload || meta.canEdit));
    dl.href = `/v/${slug}/download`;
    const cta = $('cta');
    cta.hidden = !meta.cta;
    if (meta.cta) {
      cta.textContent = meta.cta.label;
      cta.href = meta.cta.url;
    }
    if (meta.kind === 'image') mountImage();
    else if (ready) mountVideo();
    else if (meta.status === 'failed') placeholder(`Processing failed.${meta.canEdit && meta.error ? `<br><small>${fc.esc(meta.error.slice(-300))}</small>` : ''}`);
    else placeholder('<div><div class="spinner"></div>Processing…<br><small>The link already works, so you can share it now.</small></div>');
    renderSummary();
    renderTimeline();
  }

  let pollTimer = null;
  function poll() {
    clearTimeout(pollTimer);
    const busy = () => meta.status === 'processing' || meta.transcriptStatus === 'processing' || meta.aiStatus === 'processing';
    if (!busy()) return;
    pollTimer = setTimeout(async () => {
      const prev = meta;
      meta = await fc.api(`/api/public/${slug}`).catch(() => meta);
      if (prev.status !== meta.status || prev.updatedAt !== meta.updatedAt) {
        if (meta.title !== prev.title && document.activeElement !== $('title')) $('title').textContent = meta.title;
        render();
        window.FCShare?.onUpdate?.(meta);
      }
      if (prev.transcriptStatus !== meta.transcriptStatus || prev.updatedAt !== meta.updatedAt) loadTranscript();
      poll();
    }, 2500);
  }

  window.FCShare = {
    get meta() { return meta; },
    set meta(m) { meta = m; },
    get player() { return player; },
    seek,
    render,
    poll,
    reloadTranscript: loadTranscript,
    onUpdate: null,
  };

  render();
  loadActivity();
  loadTranscript();
  poll();
})();
