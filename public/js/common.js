window.fc = {
  async api(path, opts = {}) {
    const init = { credentials: 'same-origin', ...opts };
    if (opts.json !== undefined) {
      init.method = init.method || 'POST';
      init.headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
      init.body = JSON.stringify(opts.json);
    }
    delete init.json;
    const r = await fetch(path, init);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  },
  fmtTime(s) {
    if (s == null || !isFinite(s)) return '–';
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  },
  fmtAgo(d) {
    const s = (Date.now() - new Date(d).getTime()) / 1000;
    if (s < 60) return 'just now';
    const units = [[31536000, 'y'], [2592000, 'mo'], [604800, 'w'], [86400, 'd'], [3600, 'h'], [60, 'm']];
    for (const [n, u] of units) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
    return '';
  },
  fmtBytes(b) {
    b = Number(b) || 0;
    if (b < 1024 ** 2) return `${(b / 1024).toFixed(0)} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  toast(msg) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      t.className = 'toast';
      t.setAttribute('role', 'status');
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), 2400);
  },
  async copy(text, msg = 'Link copied') {
    try {
      await navigator.clipboard.writeText(text);
      fc.toast(msg);
    } catch {
      prompt('Copy this:', text);
    }
  },
  // Applies workspace branding to app pages (share pages get it server-side).
  async brand() {
    try {
      const c = await fc.api('/api/config');
      if (c.brandColor) document.documentElement.style.setProperty('--accent', c.brandColor);
      document.querySelectorAll('[data-workspace-name]').forEach((el) => { el.textContent = c.workspaceName; });
      return c;
    } catch {
      return null;
    }
  },
};
