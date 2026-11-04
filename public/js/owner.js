// Owner/admin tools on the share page: insights, sharing, editing, blur, camera bubble.
(() => {
  const $ = (id) => document.getElementById(id);
  const S = window.FCShare;
  const TL = window.FCTimeline;
  const panel = $('owner-panel');
  const isVideo = () => S.meta.kind === 'video';
  let detail = null;
  let folders = [];

  const api = (path, opts) => fc.api(path, opts);
  const patch = (body) => api(`/api/videos/${S.meta.id}`, { method: 'PATCH', json: body });

  function afterReprocess(updated) {
    S.meta = updated;
    S.render();
    S.poll();
    fc.toast('Re-processing… the link keeps working.');
  }

  const tabs = [
    ['insights', 'Insights'],
    ['share', 'Sharing'],
    ...(isVideo() ? [['edit', 'Edit'], ['blur', 'Blur']] : []),
    ...(isVideo() && S.meta.hasCamera ? [['camera', 'Camera']] : []),
  ];
  panel.innerHTML = `<div class="panel-tabs" role="tablist">${tabs.map(([k, l], i) => `<button class="tab ${i ? '' : 'active'}" data-tab="${k}">${l}</button>`).join('')}</div>
    ${tabs.map(([k], i) => `<div class="tab-body" data-body="${k}" ${i ? 'hidden' : ''}></div>`).join('')}`;
  const body = (k) => panel.querySelector(`[data-body="${k}"]`);
  const loaded = {};
  panel.querySelector('.panel-tabs').onclick = (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    panel.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    panel.querySelectorAll('.tab-body').forEach((b) => { b.hidden = b.dataset.body !== t.dataset.tab; });
    if (!loaded[t.dataset.tab]) { loaded[t.dataset.tab] = true; renderers[t.dataset.tab](); }
  };

  // ---------- Title ----------
  const title = $('title');
  let lastTitle = title.textContent;
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', async () => {
    const t = title.textContent.trim();
    if (!t) { title.textContent = lastTitle; return; }
    if (t === lastTitle) return;
    await patch({ title: t });
    lastTitle = t;
    fc.toast('Renamed');
  });

  // ---------- Insights ----------
  async function renderInsights() {
    const el = body('insights');
    detail = await api(`/api/videos/${S.meta.id}`);
    const a = await api(`/api/videos/${S.meta.id}/analytics`);
    const max = Math.max(0.01, ...a.retention);
    el.innerHTML = `
      <div class="stats">
        <div class="stat"><span class="stat-v">${detail.viewCount}</span><span class="stat-l">Views</span></div>
        <div class="stat"><span class="stat-v">${detail.uniqueViewers}</span><span class="stat-l">Unique viewers</span></div>
        <div class="stat"><span class="stat-v">${detail.avgCompletion == null ? '–' : `${Math.round(detail.avgCompletion * 100)}%`}</span><span class="stat-l">Avg. watched</span></div>
        <div class="stat"><span class="stat-v">${isVideo() ? fc.fmtTime(detail.durationS) : fc.fmtBytes(detail.sizeBytes)}</span><span class="stat-l">${isVideo() ? 'Length' : 'Size'}</span></div>
      </div>
      ${isVideo() && a.viewers.length ? `<h3 style="margin-top:18px">Audience retention</h3>
        <div class="chart" title="Share of viewers who watched each part">${a.retention.map((r) => `<span style="height:${(r / max) * 100}%"></span>`).join('')}</div>
        <div class="chart-axis"><span>0:00</span><span>${fc.fmtTime(a.durationS / 2)}</span><span>${fc.fmtTime(a.durationS)}</span></div>` : ''}
      ${a.reactions.length ? `<p class="small muted" style="margin-top:14px">${a.reactions.map((r) => `${r.emoji} ${r.n}`).join(' &nbsp; ')}</p>` : ''}
      <div class="row between" style="margin-top:18px"><h3 style="margin:0">Viewers</h3>
        ${a.viewers.length ? `<a class="btn btn-sm" href="/api/videos/${S.meta.id}/analytics?format=csv">Export CSV</a>` : ''}</div>
      ${a.viewers.length ? `<table class="viewer-table"><thead><tr><th>Viewer</th><th>Watched</th><th>Last viewed</th></tr></thead><tbody>
        ${a.viewers.slice(0, 100).map((v) => `<tr><td>${fc.esc(v.name)}${v.email ? ` <span class="muted">${fc.esc(v.email)}</span>` : ''}</td><td>${v.watchedPct == null ? '–' : `${v.watchedPct}%`}</td><td>${fc.fmtAgo(v.lastViewedAt)}</td></tr>`).join('')}
        </tbody></table>` : '<p class="muted small">No views yet. Signed-in viewers show by name, everyone else as anonymous.</p>'}`;
  }

  // ---------- Sharing ----------
  async function renderShare() {
    const el = body('share');
    const [cfg, fl] = await Promise.all([api('/api/config'), api('/api/folders')]);
    folders = fl;
    detail ||= await api(`/api/videos/${S.meta.id}`);
    const m = detail;
    const vis = [
      ['public', 'Anyone with the link', cfg.allowPublicLinks],
      ['workspace', `Anyone signed in to ${cfg.workspaceName}`, true],
      ['password', 'Anyone with the link and password', true],
      ['private', 'Only me (and admins)', true],
    ];
    const exp = m.expiresAt ? new Date(m.expiresAt) : null;
    el.innerHTML = `
      <div class="field"><label>Who can view</label><div class="seg">
        ${vis.map(([v, l, ok]) => `<label><input type="radio" name="visibility" value="${v}" ${m.visibility === v ? 'checked' : ''} ${ok ? '' : 'disabled'}> ${l}${ok ? '' : ' <span class="muted small">(disabled by admin)</span>'}</label>`).join('')}
      </div></div>
      <div class="field" id="pw-field" ${m.visibility === 'password' ? '' : 'hidden'}><label for="pw">Password</label>
        <div class="row"><input id="pw" type="password" placeholder="${m.visibility === 'password' ? 'Set a new password' : 'Choose a password'}" autocomplete="new-password"><button class="btn" id="pw-save">Save</button></div></div>
      <div class="field"><label for="expiry">Link expires</label>
        <div class="row"><select id="expiry">
          <option value="">Never</option><option value="1">In 1 day</option><option value="7">In 7 days</option><option value="30">In 30 days</option>
          ${exp ? `<option value="keep" selected>${exp < new Date() ? 'Expired' : 'On'} ${exp.toLocaleDateString()}</option>` : ''}
        </select></div></div>
      <label class="check"><input type="checkbox" id="allow-dl" ${m.allowDownload ? 'checked' : ''}> Allow viewers to download</label>
      <div class="field" style="margin-top:14px"><label for="folder">Folder</label>
        <select id="folder"><option value="">No folder</option>${folders.map((f) => `<option value="${f.id}" ${m.folderId === f.id ? 'selected' : ''}>${fc.esc(f.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Call-to-action button</label>
        <div class="row"><input id="cta-label" placeholder="Book a call" maxlength="40" value="${fc.esc(m.cta?.label || '')}" style="max-width:180px"><input id="cta-url" placeholder="https://…" value="${fc.esc(m.cta?.url || '')}"><button class="btn" id="cta-save">Save</button></div></div>
      ${isVideo() ? `<div class="field"><label for="embed">Embed code</label>
        <div class="row"><input id="embed" readonly value="${fc.esc(`<iframe src="${window.FC.embedUrl}" width="960" height="540" frameborder="0" allowfullscreen></iframe>`)}"><button class="btn" id="copy-embed">Copy</button></div></div>` : ''}
      ${window.FC.user?.role === 'admin' ? `<label class="check"><input type="checkbox" id="legal-hold" ${m.legalHold ? 'checked' : ''}> Legal hold (blocks deletion and retention cleanup)</label>` : ''}
      <hr><button class="btn btn-danger" id="delete">Delete ${isVideo() ? 'video' : 'screenshot'}</button>`;

    el.querySelectorAll('input[name=visibility]').forEach((r) => {
      r.onchange = async () => {
        $('pw-field').hidden = r.value !== 'password';
        if (r.value === 'password') return $('pw').focus();
        try {
          await patch({ visibility: r.value });
          fc.toast('Sharing updated');
        } catch (e) { fc.toast(e.message); }
      };
    });
    $('pw-save').onclick = async () => {
      try {
        await patch({ visibility: 'password', password: $('pw').value });
        $('pw').value = '';
        fc.toast('Password set');
      } catch (e) { fc.toast(e.message); }
    };
    $('expiry').onchange = async () => {
      const d = $('expiry').value;
      if (d === 'keep') return;
      await patch({ expiresAt: d ? new Date(Date.now() + Number(d) * 864e5).toISOString() : null });
      fc.toast(d ? `Link expires in ${d} day${d === '1' ? '' : 's'}` : 'Link never expires');
    };
    $('allow-dl').onchange = async () => {
      await patch({ allowDownload: $('allow-dl').checked });
      fc.toast($('allow-dl').checked ? 'Downloads allowed' : 'Downloads disabled');
    };
    $('folder').onchange = async () => { await patch({ folderId: $('folder').value || null }); fc.toast('Moved'); };
    $('cta-save').onclick = async () => {
      try {
        const updated = await patch({ cta: { label: $('cta-label').value, url: $('cta-url').value } });
        S.meta = { ...S.meta, cta: updated.cta };
        S.render();
        fc.toast(updated.cta ? 'Button added' : 'Button removed');
      } catch (e) { fc.toast(e.message); }
    };
    if ($('copy-embed')) $('copy-embed').onclick = () => fc.copy($('embed').value, 'Embed code copied');
    if ($('legal-hold')) $('legal-hold').onchange = async () => { await patch({ legalHold: $('legal-hold').checked }); fc.toast('Legal hold updated'); };
    $('delete').onclick = async () => {
      if (!confirm('Delete permanently? The link will stop working.')) return;
      try {
        await api(`/api/videos/${S.meta.id}`, { method: 'DELETE' });
        location.href = '/app';
      } catch (e) { fc.toast(e.message); }
    };
  }

  // ---------- Edit: trim + transcript-based cuts ----------
  const FILLERS = new Set(['um', 'uh', 'uhm', 'umm', 'er', 'erm', 'ah', 'hmm', 'mm']);
  let words = [];
  let cutWords = new Set();
  let cutGaps = new Set();
  let srcDur = null;

  const norm = (w) => w.toLowerCase().replace(/[^a-z']/g, '');
  const currentKeeps = () => TL.keepSegments(S.meta.edits || detail?.edits, srcDur);
  const playerSourceTime = () => (S.player ? TL.toSource(S.player.currentTime, currentKeeps()) : 0);

  async function renderEdit() {
    const el = body('edit');
    const t = await api(`/api/videos/${S.meta.id}/transcript`);
    words = t.words;
    srcDur = t.sourceDurationS;
    const edits = t.edits || {};
    const inCut = (s, e) => (edits.cuts || []).some(([a, b]) => s >= a - 0.01 && e <= b + 0.01);
    cutWords = new Set(words.map((w, i) => (inCut(w.s, w.e) ? i : -1)).filter((i) => i >= 0));
    cutGaps = new Set(words.map((w, i) => (i && inCut(words[i - 1].e + 0.15, w.s - 0.15) && !cutWords.has(i) && w.s - words[i - 1].e > 1 ? i : -1)).filter((i) => i >= 0));
    const status = {
      processing: '<span class="status-line"><span class="spinner-sm"></span>Transcribing…</span>',
      failed: '<span class="status-line">Transcription failed. <button class="btn btn-sm" id="retx">Retry</button></span>',
      empty: '<span class="status-line">No speech detected.</span>',
      none: '<span class="status-line">No transcript (no audio, or transcription is off).</span>',
    }[t.status] || '';

    el.innerHTML = `
      <h3>Trim</h3>
      <p class="muted small" style="margin:0 0 10px">Times are on the original recording (${fc.fmtTime(srcDur)}). Play to a point and press Set.</p>
      <div class="trim-row">
        <div class="field"><label for="trim-start">Start (s)</label><div class="row"><input id="trim-start" type="number" min="0" step="0.1" placeholder="0" value="${edits.trimStart ?? ''}"><button class="btn" data-set="trim-start">Set</button></div></div>
        <div class="field"><label for="trim-end">End (s)</label><div class="row"><input id="trim-end" type="number" min="0" step="0.1" placeholder="end" value="${edits.trimEnd ?? ''}"><button class="btn" data-set="trim-end">Set</button></div></div>
      </div>
      <h3 style="margin-top:8px">Edit by transcript</h3>
      ${words.length ? `<p class="muted small" style="margin:0 0 8px">Click words to cut them. Double-click to jump there. Dotted words are fillers; bracketed times are pauses.</p>
        <div class="row wrap" style="margin-bottom:8px">
          <button class="btn btn-sm" id="mark-fillers">Cut filler words</button>
          <button class="btn btn-sm" id="mark-pauses">Shorten pauses over 1s</button>
          <button class="btn btn-sm btn-ghost" id="clear-cuts">Clear cuts</button>
          <span class="small muted grow" id="cut-summary"></span>
        </div>
        <div class="word-editor" id="words"></div>` : status}
      <div class="row" style="margin-top:14px">
        <button class="btn btn-primary" id="apply-edits">Apply edits</button>
        <button class="btn btn-ghost" id="reset-edits">Revert to original</button>
      </div>`;

    if ($('retx')) $('retx').onclick = async () => { await api(`/api/videos/${S.meta.id}/transcribe`, { method: 'POST' }); renderEdit(); };
    el.querySelectorAll('[data-set]').forEach((b) => {
      b.onclick = () => { $(b.dataset.set).value = playerSourceTime().toFixed(1); };
    });
    if (words.length) {
      renderWords();
      $('words').onclick = (e) => {
        const w = e.target.closest('[data-i]');
        const g = e.target.closest('[data-gap]');
        if (w) toggle(cutWords, Number(w.dataset.i));
        if (g) toggle(cutGaps, Number(g.dataset.gap));
        renderWords();
      };
      $('words').ondblclick = (e) => {
        const w = e.target.closest('[data-i]');
        if (!w) return;
        const out = TL.toOutput(words[Number(w.dataset.i)].s, currentKeeps());
        if (out != null) S.seek(out);
      };
      $('mark-fillers').onclick = () => {
        words.forEach((w, i) => { if (FILLERS.has(norm(w.w))) cutWords.add(i); });
        renderWords();
      };
      $('mark-pauses').onclick = () => {
        words.forEach((w, i) => { if (i && w.s - words[i - 1].e > 1) cutGaps.add(i); });
        renderWords();
      };
      $('clear-cuts').onclick = () => { cutWords.clear(); cutGaps.clear(); renderWords(); };
    }
    $('apply-edits').onclick = () => saveEdits(false);
    $('reset-edits').onclick = () => { if (confirm('Remove all trims and cuts?')) saveEdits(true); };
  }

  const toggle = (set, i) => (set.has(i) ? set.delete(i) : set.add(i));

  function renderWords() {
    let html = '';
    words.forEach((w, i) => {
      if (i) {
        const gap = w.s - words[i - 1].e;
        if (gap > 1) html += `<span class="gap ${cutGaps.has(i) ? 'cut' : ''}" data-gap="${i}">[${gap.toFixed(1)}s]</span> `;
      }
      html += `<span class="w ${cutWords.has(i) ? 'cut' : ''} ${FILLERS.has(norm(w.w)) ? 'filler' : ''}" data-i="${i}">${fc.esc(w.w)}</span> `;
    });
    $('words').innerHTML = html;
    const secs = buildCuts().reduce((a, [s, e]) => a + (e - s), 0);
    $('cut-summary').textContent = secs ? `${fc.fmtTime(secs)} will be removed` : '';
  }

  // Contiguous cut words become one range; a cut pause keeps 0.15s of air on each side.
  function buildCuts() {
    const ranges = [];
    let i = 0;
    while (i < words.length) {
      if (!cutWords.has(i)) { i++; continue; }
      const start = i;
      while (i + 1 < words.length && cutWords.has(i + 1)) i++;
      const before = words[start - 1];
      const after = words[i + 1];
      ranges.push([before ? Math.max(before.e, words[start].s - 0.05) : words[start].s - 0.05, after ? Math.min(after.s, words[i].e + 0.05) : words[i].e + 0.05]);
      i++;
    }
    for (const g of cutGaps) {
      const a = words[g - 1].e + 0.15;
      const b = words[g].s - 0.15;
      if (b > a) ranges.push([a, b]);
    }
    return ranges.map(([a, b]) => [Math.max(0, +a.toFixed(3)), +b.toFixed(3)]).sort((x, y) => x[0] - y[0]);
  }

  async function saveEdits(reset) {
    detail ||= await api(`/api/videos/${S.meta.id}`);
    const prev = S.meta.edits || detail.edits || {};
    const payload = reset ? { cuts: [], blurs: prev.blurs || [] } : {
      trimStart: $('trim-start').value || null,
      trimEnd: $('trim-end').value || null,
      cuts: words.length ? buildCuts() : prev.cuts || [],
      blurs: prev.blurs || [],
    };
    try {
      const updated = await api(`/api/videos/${S.meta.id}/edits`, { json: payload });
      afterReprocess(updated);
      if (reset) renderEdit();
    } catch (e) { fc.toast(e.message); }
  }

  // ---------- Blur ----------
  let blurs = [];
  async function renderBlur() {
    const el = body('blur');
    detail ||= await api(`/api/videos/${S.meta.id}`);
    blurs = [...((S.meta.edits || detail.edits)?.blurs || [])];
    el.innerHTML = `
      <p class="muted small" style="margin:0 0 10px">Drag on the frame to cover passwords, customer data or anything private. Blur is burned into the shared video.</p>
      <div class="blur-stage" id="blur-stage"><img src="${S.meta.thumbUrl}" alt="Video frame"></div>
      <div id="blur-list" style="margin-top:10px;display:grid;gap:6px"></div>
      <div class="row" style="margin-top:12px"><button class="btn btn-primary" id="blur-save">Apply blur</button></div>`;
    const stage = $('blur-stage');
    let start = null;
    let ghost = null;
    const rel = (e) => {
      const r = stage.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    };
    stage.onpointerdown = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      start = rel(e);
      ghost = document.createElement('div');
      ghost.className = 'blur-rect';
      stage.appendChild(ghost);
      stage.setPointerCapture(e.pointerId);
    };
    stage.onpointermove = (e) => {
      if (!start) return;
      const p = rel(e);
      Object.assign(ghost.style, {
        left: `${Math.min(start.x, p.x) * 100}%`, top: `${Math.min(start.y, p.y) * 100}%`,
        width: `${Math.abs(p.x - start.x) * 100}%`, height: `${Math.abs(p.y - start.y) * 100}%`,
      });
    };
    stage.onpointerup = (e) => {
      if (!start) return;
      const p = rel(e);
      const r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y), start: null, end: null };
      start = null;
      ghost.remove();
      if (r.w > 0.01 && r.h > 0.01) blurs.push(r);
      drawBlurs();
    };
    $('blur-save').onclick = async () => {
      const prev = S.meta.edits || detail.edits || {};
      try {
        afterReprocess(await api(`/api/videos/${S.meta.id}/edits`, { json: { ...prev, blurs } }));
      } catch (e) { fc.toast(e.message); }
    };
    drawBlurs();
  }

  function drawBlurs() {
    const stage = $('blur-stage');
    stage.querySelectorAll('.blur-rect').forEach((n) => n.remove());
    blurs.forEach((b, i) => {
      const d = document.createElement('div');
      d.className = 'blur-rect';
      Object.assign(d.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
      d.innerHTML = `<button data-rm="${i}" title="Remove">×</button>`;
      stage.appendChild(d);
    });
    stage.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { blurs.splice(Number(b.dataset.rm), 1); drawBlurs(); }; });
    $('blur-list').innerHTML = blurs.map((b, i) => `<div class="row small">
      <span class="badge-soft">Area ${i + 1}</span>
      <select data-when="${i}" style="width:auto;padding:4px 8px">
        <option value="all" ${b.start == null && b.end == null ? 'selected' : ''}>Whole video</option>
        <option value="range" ${b.start != null || b.end != null ? 'selected' : ''}>Time range</option>
      </select>
      <span data-range="${i}" ${b.start == null && b.end == null ? 'hidden' : ''}>
        <input type="number" step="0.1" min="0" data-k="start" data-i="${i}" value="${b.start ?? ''}" placeholder="from s" style="width:90px;padding:4px 8px">
        <input type="number" step="0.1" min="0" data-k="end" data-i="${i}" value="${b.end ?? ''}" placeholder="to s" style="width:90px;padding:4px 8px">
        <button class="btn btn-sm" data-now="${i}">From now</button>
      </span></div>`).join('') || '<p class="muted small">No blurred areas.</p>';
    document.querySelectorAll('[data-when]').forEach((s) => {
      s.onchange = () => {
        const i = Number(s.dataset.when);
        if (s.value === 'all') { blurs[i].start = null; blurs[i].end = null; }
        document.querySelector(`[data-range="${i}"]`).hidden = s.value === 'all';
      };
    });
    document.querySelectorAll('[data-k]').forEach((inp) => {
      inp.onchange = () => { blurs[Number(inp.dataset.i)][inp.dataset.k] = inp.value === '' ? null : Number(inp.value); };
    });
    document.querySelectorAll('[data-now]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.dataset.now);
        blurs[i].start = +playerSourceTime().toFixed(1);
        drawBlurs();
      };
    });
  }

  // ---------- Camera bubble ----------
  function renderCamera() {
    const el = body('camera');
    const m = S.meta;
    el.innerHTML = `
      <p class="muted small" style="margin:0 0 12px">The camera is recorded separately, so you can move or resize the bubble after recording.</p>
      <div class="row" style="gap:28px;align-items:flex-start">
        <div class="field"><label>Position</label><div class="pos-grid">
          ${['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((p) => `<button data-pos="${p}" class="${m.cameraPosition === p ? 'active' : ''}" aria-label="${p}"></button>`).join('')}
        </div></div>
        <div class="field"><label>Size</label><div class="seg-inline">
          ${[['s', 'Small'], ['m', 'Medium'], ['l', 'Large']].map(([k, l]) => `<button data-size="${k}" class="${m.cameraSize === k ? 'active' : ''}">${l}</button>`).join('')}
        </div></div>
      </div>`;
    el.onclick = async (e) => {
      const p = e.target.closest('[data-pos]');
      const s = e.target.closest('[data-size]');
      if (!p && !s) return;
      try {
        const updated = await patch(p ? { cameraPosition: p.dataset.pos } : { cameraSize: s.dataset.size });
        afterReprocess(updated);
        renderCamera();
      } catch (err) { fc.toast(err.message); }
    };
  }

  const renderers = { insights: renderInsights, share: renderShare, edit: renderEdit, blur: renderBlur, camera: renderCamera };
  loaded.insights = true;
  renderInsights().catch((e) => { body('insights').textContent = e.message; });
  S.onUpdate = (m) => {
    if (m.status === 'ready' && loaded.blur) renderBlur();
    if (loaded.edit && m.transcriptStatus === 'ready' && !words.length) renderEdit();
  };
})();
