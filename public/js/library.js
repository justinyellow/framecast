(() => {
  const $ = (id) => document.getElementById(id);
  let items = [];
  let folders = [];
  let me = null;
  const params = new URLSearchParams(location.search);
  const state = { scope: params.get('scope') || 'mine', folder: params.get('folder') || '', q: '' };

  function setUrl() {
    const p = new URLSearchParams();
    if (state.scope !== 'mine') p.set('scope', state.scope);
    if (state.folder) p.set('folder', state.folder);
    history.replaceState(null, '', `/app${p.toString() ? `?${p}` : ''}`);
  }

  function renderNav() {
    const link = (label, scope, folder = '', count = '') => {
      const active = state.scope === scope && state.folder === folder;
      return `<a href="#" class="${active ? 'active' : ''}" data-scope="${scope}" data-folder="${folder}"><span>${fc.esc(label)}</span><span class="count">${count}</span></a>`;
    };
    $('nav').innerHTML = `${link('My library', 'mine')}${link('Team library', 'team')}
      <div class="label">Folders</div>
      ${folders.map((f) => link(f.name, 'team', f.id, f.count)).join('')}
      ${me?.role !== 'viewer' ? '<button class="navlink muted" id="new-folder">+ New folder</button>' : ''}`;
    const f = folders.find((x) => x.id === state.folder);
    $('heading').textContent = f ? f.name : state.scope === 'team' ? 'Team library' : 'My library';
    if ($('new-folder')) $('new-folder').onclick = newFolder;
  }

  async function newFolder() {
    const name = prompt('Folder name');
    if (!name?.trim()) return;
    const f = await fc.api('/api/folders', { json: { name } });
    folders = await fc.api('/api/folders');
    state.scope = 'team';
    state.folder = f.id;
    setUrl();
    load();
  }

  $('nav').onclick = (e) => {
    const a = e.target.closest('[data-scope]');
    if (!a) return;
    e.preventDefault();
    state.scope = a.dataset.scope;
    state.folder = a.dataset.folder;
    setUrl();
    load();
  };

  function card(v) {
    const thumb = v.status === 'ready' && v.thumbUrl
      ? `<img src="${v.thumbUrl}" alt="" loading="lazy">${v.kind === 'video' ? `<span class="badge">${fc.fmtTime(v.durationS)}</span>` : '<span class="kind">Screenshot</span>'}`
      : `<span class="state">${v.status === 'failed' ? 'Processing failed' : 'Processing…'}</span>`;
    const vis = { password: 'Protected', private: 'Private', workspace: 'Team only' }[v.visibility];
    const mine = me && v.ownerId === me.id;
    return `<article class="vcard" data-id="${v.id}">
      <a class="vthumb" href="/v/${v.slug}">${thumb}</a>
      <div class="vbody">
        <a class="vtitle" href="/v/${v.slug}" title="${fc.esc(v.title)}">${fc.esc(v.title)}</a>
        <div class="vmeta">
          ${state.scope !== 'mine' ? `<span class="owner">${fc.esc(v.ownerName)}</span>` : ''}
          <span>${fc.fmtAgo(v.createdAt)}</span>
          <span>${v.viewCount} view${v.viewCount === 1 ? '' : 's'}</span>
          ${v.commentCount ? `<span>${v.commentCount} comment${v.commentCount === 1 ? '' : 's'}</span>` : ''}
          ${vis ? `<span>${vis}</span>` : ''}
          ${v.expiresAt ? `<span>${new Date(v.expiresAt) < new Date() ? 'Expired' : 'Expires'} ${new Date(v.expiresAt).toLocaleDateString()}</span>` : ''}
        </div>
      </div>
      <div class="vactions">
        <button class="btn btn-ghost" data-act="copy">Copy link</button>
        ${v.canEdit ? `<span class="menu"><button class="btn btn-ghost" data-act="menu">Move</button></span>
          <button class="btn btn-ghost btn-danger" data-act="delete">Delete</button>` : ''}
        ${!mine && v.canEdit ? '<span class="badge-soft" title="You can manage this as an admin">admin</span>' : ''}
      </div>
    </article>`;
  }

  function render() {
    $('grid').innerHTML = items.map(card).join('');
    $('empty').hidden = items.length > 0 || !!state.q;
    if (!items.length && state.q) $('grid').innerHTML = '<p class="muted">No matches.</p>';
  }

  let loadTimer = null;
  async function load() {
    clearTimeout(loadTimer);
    renderNav();
    const qs = new URLSearchParams({ scope: state.scope, ...(state.folder ? { folder: state.folder } : {}), ...(state.q ? { q: state.q } : {}) });
    items = await fc.api(`/api/videos?${qs}`);
    render();
    if (items.some((v) => v.status === 'processing')) loadTimer = setTimeout(load, 3000);
  }

  let qTimer = null;
  $('q').oninput = () => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.q = $('q').value.trim(); load(); }, 250);
  };

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) document.querySelectorAll('.menu-list').forEach((m) => m.remove());
  });

  $('grid').onclick = async (e) => {
    const btn = e.target.closest('[data-act], [data-move]');
    if (!btn) return;
    const v = items.find((x) => x.id === btn.closest('.vcard').dataset.id);
    if (btn.dataset.move !== undefined) {
      await fc.api(`/api/videos/${v.id}`, { method: 'PATCH', json: { folderId: btn.dataset.move || null } });
      fc.toast('Moved');
      folders = await fc.api('/api/folders');
      return load();
    }
    if (btn.dataset.act === 'copy') fc.copy(v.shareUrl);
    if (btn.dataset.act === 'menu') {
      document.querySelectorAll('.menu-list').forEach((m) => m.remove());
      const list = document.createElement('div');
      list.className = 'menu-list';
      list.innerHTML = `<button data-move="">No folder</button>${folders.map((f) => `<button data-move="${f.id}">${fc.esc(f.name)}</button>`).join('')}`;
      btn.parentElement.appendChild(list);
    }
    if (btn.dataset.act === 'delete' && confirm(`Delete “${v.title}”? This can't be undone.`)) {
      try {
        await fc.api(`/api/videos/${v.id}`, { method: 'DELETE' });
        items = items.filter((x) => x.id !== v.id);
        render();
      } catch (err) { fc.toast(err.message); }
    }
  };

  async function uploadAll(files) {
    const status = $('upload-status');
    status.hidden = false;
    const list = [...files].filter((f) => f.type.startsWith('video/') || f.type.startsWith('image/'));
    let done = 0;
    for (const file of list) {
      try {
        await uploadFile(file, (p) => {
          status.textContent = `Uploading ${done + 1} of ${list.length}: ${file.name} (${Math.round(p * 100)}%)`;
        }, { folderId: state.folder || undefined });
        done++;
      } catch (err) {
        fc.toast(`${file.name}: ${err.message}`);
      }
    }
    status.textContent = `Uploaded ${done} of ${list.length}. Processing has started.`;
    if (list.length === 1 && done === 1) fc.toast('Uploaded');
    load();
  }

  $('file').onchange = () => { uploadAll($('file').files); $('file').value = ''; };

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('drop').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop').hidden = true;
    if (e.dataTransfer.files.length) uploadAll(e.dataTransfer.files);
  });

  (async () => {
    const cfg = await fc.brand();
    me = cfg?.user;
    folders = await fc.api('/api/folders');
    load();
  })();
})();
