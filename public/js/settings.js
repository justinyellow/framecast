(() => {
  const $ = (id) => document.getElementById(id);
  const api = fc.api;
  let cfg = null;
  let me = null;

  const SECTIONS = [
    ['profile', 'Profile'],
    ['notifications', 'Notifications'],
    ['tokens', 'API tokens'],
    ['workspace', 'Workspace & branding', true],
    ['members', 'Members & invites', true],
    ['integrations', 'Integrations', true],
    ['retention', 'Retention & storage', true],
    ['audit', 'Audit log', true],
  ];

  const field = (label, input, hint = '') => `<div class="field"><label>${label}</label>${input}${hint ? `<span class="muted small">${hint}</span>` : ''}</div>`;
  const content = $('content');

  async function show(key) {
    history.replaceState(null, '', `#${key}`);
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.k === key));
    content.innerHTML = '<p class="muted">Loading…</p>';
    try {
      await renderers[key]();
    } catch (e) {
      content.innerHTML = `<p class="error">${fc.esc(e.message)}</p>`;
    }
  }

  const renderers = {
    async profile() {
      content.innerHTML = `<section><h2>Profile</h2>
        ${field('Name', `<input id="name" value="${fc.esc(me.name)}" maxlength="80">`)}
        ${field('Email', `<input value="${fc.esc(me.email)}" disabled>`)}
        ${field('Role', `<input value="${me.role}" disabled>`)}
        <button class="btn btn-primary" id="save-name">Save</button></section>
        ${me.has_password ? `<section><h2>Password</h2>
          ${field('Current password', '<input id="cur" type="password" autocomplete="current-password">')}
          ${field('New password', '<input id="new" type="password" autocomplete="new-password" minlength="8">')}
          <button class="btn" id="save-pw">Change password</button></section>` : '<section><h2>Password</h2><p class="muted">You sign in with single sign-on.</p></section>'}`;
      $('save-name').onclick = async () => { me = await api('/api/me', { method: 'PATCH', json: { name: $('name').value } }); fc.toast('Saved'); };
      if ($('save-pw')) {
        $('save-pw').onclick = async () => {
          try {
            await api('/api/me', { method: 'PATCH', json: { currentPassword: $('cur').value, newPassword: $('new').value } });
            $('cur').value = '';
            $('new').value = '';
            fc.toast('Password changed');
          } catch (e) { fc.toast(e.message); }
        };
      }
    },

    async notifications() {
      const opt = (k, label) => `<label class="check" style="display:flex;margin-bottom:10px"><input type="checkbox" data-n="${k}" ${me[k] ? 'checked' : ''}> ${label}</label>`;
      content.innerHTML = `<section><h2>Email notifications</h2>
        ${cfg.email ? '' : '<p class="muted small">Email isn’t configured on this server yet (set SMTP_HOST). Preferences are saved for when it is.</p>'}
        ${opt('notify_comment', 'Someone comments on my video')}
        ${opt('notify_view', 'My video gets its first view')}
        ${opt('notify_ready', 'My upload finishes processing')}</section>`;
      content.querySelectorAll('[data-n]').forEach((c) => {
        c.onchange = async () => { me = await api('/api/me', { method: 'PATCH', json: { [c.dataset.n]: c.checked } }); fc.toast('Saved'); };
      });
    },

    async tokens() {
      const rows = await api('/api/tokens');
      content.innerHTML = `<section><h2>API tokens</h2>
        <p class="muted small">Use a token as <code>Authorization: Bearer fc_…</code> to call the same API the web app uses, e.g. <code>GET /api/videos</code>.</p>
        <div class="row" style="margin:12px 0"><input id="tname" placeholder="Token name, e.g. Zapier"><button class="btn btn-primary" id="tcreate">Create token</button></div>
        <div id="tnew"></div>
        <table><thead><tr><th>Name</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>
        ${rows.map((t) => `<tr><td>${fc.esc(t.name)}</td><td>${new Date(t.created_at).toLocaleDateString()}</td><td>${t.last_used_at ? fc.fmtAgo(t.last_used_at) : 'Never'}</td>
          <td><button class="btn btn-sm btn-danger" data-del="${t.id}">Revoke</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No tokens yet.</td></tr>'}
        </tbody></table></section>`;
      $('tcreate').onclick = async () => {
        const t = await api('/api/tokens', { json: { name: $('tname').value || 'API token' } });
        await renderers.tokens();
        $('tnew').innerHTML = `<p class="small">Copy this now. It won’t be shown again.</p><div class="secret">${fc.esc(t.token)}</div><br>`;
      };
      content.querySelectorAll('[data-del]').forEach((b) => {
        b.onclick = async () => { if (confirm('Revoke this token?')) { await api(`/api/tokens/${b.dataset.del}`, { method: 'DELETE' }); renderers.tokens(); } };
      });
    },

    async workspace() {
      const s = await api('/api/admin/settings');
      content.innerHTML = `<section><h2>Workspace</h2>
        ${field('Workspace name', `<input id="ws-name" value="${fc.esc(s.workspaceName)}" maxlength="60">`, 'Shown in the header, share pages, emails and link previews.')}
        ${field('Brand color', `<input id="ws-color" type="color" value="${fc.esc(s.brandColor)}" style="width:80px;height:40px;padding:3px">`)}
        ${field('Default sharing for new recordings', `<select id="ws-vis">${[['public', 'Anyone with the link'], ['workspace', 'Signed-in members only'], ['private', 'Only the owner']].map(([v, l]) => `<option value="${v}" ${s.defaultVisibility === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
        <label class="check" style="margin-bottom:14px"><input type="checkbox" id="ws-public" ${s.allowPublicLinks ? 'checked' : ''}> Allow public links (turn off to keep everything inside the workspace)</label>
        <div><button class="btn btn-primary" id="ws-save">Save</button></div></section>
        <section><h2>Logo</h2>
          ${s.logoUrl ? `<p><img src="${s.logoUrl}?t=${Date.now()}" alt="" style="max-height:40px"></p>` : '<p class="muted small">No logo. The workspace name is shown instead.</p>'}
          <div class="row"><label class="btn" for="logo">Upload logo</label><input type="file" id="logo" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden>
          ${s.logoUrl ? '<button class="btn btn-ghost btn-danger" id="logo-rm">Remove</button>' : ''}</div></section>
        <section><h2>Custom domain</h2><p class="muted small">Point your domain (e.g. video.yourcompany.com) at the load balancer and set <code>PUBLIC_URL</code> to it. Share links, embeds and emails use that URL.</p></section>`;
      $('ws-save').onclick = async () => {
        try {
          await api('/api/admin/settings', { method: 'PATCH', json: { workspaceName: $('ws-name').value, brandColor: $('ws-color').value, defaultVisibility: $('ws-vis').value, allowPublicLinks: $('ws-public').checked } });
          await fc.brand();
          fc.toast('Saved');
        } catch (e) { fc.toast(e.message); }
      };
      $('logo').onchange = async () => {
        const f = $('logo').files[0];
        if (!f) return;
        const r = await fetch('/api/admin/logo', { method: 'POST', body: f, headers: { 'Content-Type': f.type }, credentials: 'same-origin' });
        if (!r.ok) return fc.toast((await r.json()).error);
        renderers.workspace();
      };
      if ($('logo-rm')) $('logo-rm').onclick = async () => { await api('/api/admin/logo', { method: 'DELETE' }); renderers.workspace(); };
    },

    async members() {
      const [members, invites] = await Promise.all([api('/api/admin/members'), api('/api/admin/invites')]);
      const roleSel = (m) => `<select data-role="${m.id}">${['admin', 'member', 'viewer'].map((r) => `<option ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>`;
      content.innerHTML = `<section><h2>Invite people</h2>
        <div class="row wrap"><input id="inv-email" type="email" placeholder="name@company.com" style="max-width:280px">
          <select id="inv-role" style="width:auto"><option>member</option><option>viewer</option><option>admin</option></select>
          <button class="btn btn-primary" id="inv-send">Send invite</button></div>
        <p class="muted small">Members record and share. Viewers can only watch and comment. Admins manage everything.${cfg.email ? '' : ' Email isn’t configured, so copy the invite link and send it yourself.'}</p>
        <div id="inv-result"></div>
        ${invites.length ? `<table><thead><tr><th>Pending invite</th><th>Role</th><th>Expires</th><th></th></tr></thead><tbody>
          ${invites.map((i) => `<tr><td>${fc.esc(i.email)}</td><td>${i.role}</td><td>${new Date(i.expires_at).toLocaleDateString()}</td>
            <td class="row"><button class="btn btn-sm" data-copy="${fc.esc(i.url)}">Copy link</button><button class="btn btn-sm btn-ghost btn-danger" data-revoke="${i.token}">Revoke</button></td></tr>`).join('')}
          </tbody></table>` : ''}</section>
        <section><h2>Members</h2><table><thead><tr><th>Name</th><th>Role</th><th>Videos</th><th>Storage</th><th>Quota (GB)</th><th></th></tr></thead><tbody>
        ${members.map((m) => `<tr style="${m.disabled ? 'opacity:.5' : ''}"><td>${fc.esc(m.name)}<br><span class="muted small">${fc.esc(m.email)}${m.sso ? ' · SSO' : ''}</span></td>
          <td>${roleSel(m)}</td><td>${m.videos}</td><td>${fc.fmtBytes(m.bytes)}</td>
          <td><input type="number" min="0" step="0.5" data-quota="${m.id}" value="${m.quota_bytes ? (m.quota_bytes / 1024 ** 3).toFixed(1) : ''}" placeholder="default" style="width:90px"></td>
          <td><button class="btn btn-sm btn-ghost ${m.disabled ? '' : 'btn-danger'}" data-disable="${m.id}" data-on="${m.disabled ? '0' : '1'}">${m.disabled ? 'Re-enable' : 'Deactivate'}</button></td></tr>`).join('')}
        </tbody></table></section>`;
      $('inv-send').onclick = async () => {
        try {
          const r = await api('/api/admin/invites', { json: { email: $('inv-email').value, role: $('inv-role').value } });
          await renderers.members();
          $('inv-result').innerHTML = `<p class="small">${r.emailed ? 'Invite emailed.' : 'Invite created.'} Link:</p><div class="secret">${fc.esc(r.url)}</div><br>`;
        } catch (e) { fc.toast(e.message); }
      };
      const upd = async (id, body) => { try { await api(`/api/admin/members/${id}`, { method: 'PATCH', json: body }); fc.toast('Updated'); } catch (e) { fc.toast(e.message); renderers.members(); } };
      content.querySelectorAll('[data-role]').forEach((s) => { s.onchange = () => upd(s.dataset.role, { role: s.value }); });
      content.querySelectorAll('[data-quota]').forEach((i) => { i.onchange = () => upd(i.dataset.quota, { quotaGb: i.value || null }); });
      content.querySelectorAll('[data-disable]').forEach((b) => { b.onclick = async () => { await upd(b.dataset.disable, { disabled: b.dataset.on === '1' }); renderers.members(); }; });
      content.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = () => fc.copy(b.dataset.copy, 'Invite link copied'); });
      content.querySelectorAll('[data-revoke]').forEach((b) => { b.onclick = async () => { await api(`/api/admin/invites/${b.dataset.revoke}`, { method: 'DELETE' }); renderers.members(); }; });
    },

    async integrations() {
      const [s, wh] = await Promise.all([api('/api/admin/settings'), api('/api/admin/webhooks')]);
      content.innerHTML = `<section><h2>Slack / Microsoft Teams</h2>
        <p class="muted small">Paste an incoming webhook URL from Slack (Apps → Incoming Webhooks) or Teams (channel → Workflows → “Post to a channel when a webhook request is received”). Links posted in either also unfurl with a thumbnail.</p>
        ${field('Webhook URL', `<input id="chat-url" value="${fc.esc(s.chatWebhookUrl || '')}" placeholder="https://hooks.slack.com/…">`)}
        <label class="check" style="display:flex;margin-bottom:8px"><input type="checkbox" id="chat-new" ${s.chatNotifyNewVideo ? 'checked' : ''}> Post when someone shares a new video (not private ones)</label>
        <label class="check" style="display:flex;margin-bottom:14px"><input type="checkbox" id="chat-comment" ${s.chatNotifyComment ? 'checked' : ''}> Post new comments</label>
        <div class="row"><button class="btn btn-primary" id="chat-save">Save</button><button class="btn" id="chat-test">Send test message</button></div></section>
        <section><h2>Outgoing webhooks</h2>
        <p class="muted small">We POST JSON to your URL with an <code>X-Framecast-Signature: sha256=…</code> HMAC header, retrying failures with backoff.</p>
        <div class="field"><input id="wh-url" placeholder="https://example.com/framecast-hook"></div>
        <div class="row wrap" style="margin-bottom:10px">${wh.events.map((e) => `<label class="check small"><input type="checkbox" class="wh-ev" value="${e}" checked> ${e}</label>`).join('')}</div>
        <button class="btn btn-primary" id="wh-add">Add webhook</button><div id="wh-secret"></div>
        <table style="margin-top:14px"><thead><tr><th>URL</th><th>Events</th><th></th></tr></thead><tbody>
        ${wh.webhooks.map((w) => `<tr><td>${fc.esc(w.url)}</td><td class="small">${w.events.join(', ')}</td><td><button class="btn btn-sm btn-danger" data-del="${w.id}">Delete</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">None yet.</td></tr>'}
        </tbody></table></section>
        <section><h2>Single sign-on</h2><p class="muted small">${s.ssoConfigured ? 'SSO is enabled.' : 'SSO is off.'} Configure an OIDC app in Google Workspace, Microsoft Entra ID or Okta with redirect URL <code>${location.origin}/auth/sso/callback</code>, then set <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>, <code>OIDC_CLIENT_SECRET</code> and optionally <code>OIDC_ALLOWED_DOMAINS</code>.</p></section>`;
      $('chat-save').onclick = async () => {
        try {
          await api('/api/admin/settings', { method: 'PATCH', json: { chatWebhookUrl: $('chat-url').value.trim() || null, chatNotifyNewVideo: $('chat-new').checked, chatNotifyComment: $('chat-comment').checked } });
          fc.toast('Saved');
        } catch (e) { fc.toast(e.message); }
      };
      $('chat-test').onclick = async () => { try { await api('/api/admin/test-chat', { method: 'POST' }); fc.toast('Test message sent'); } catch (e) { fc.toast(e.message); } };
      $('wh-add').onclick = async () => {
        try {
          const events = [...document.querySelectorAll('.wh-ev:checked')].map((c) => c.value);
          const w = await api('/api/admin/webhooks', { json: { url: $('wh-url').value, events } });
          await renderers.integrations();
          $('wh-secret').innerHTML = `<p class="small">Signing secret (copy now, it won’t be shown again):</p><div class="secret">${fc.esc(w.secret)}</div>`;
        } catch (e) { fc.toast(e.message); }
      };
      content.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { await api(`/api/admin/webhooks/${b.dataset.del}`, { method: 'DELETE' }); renderers.integrations(); }; });
    },

    async retention() {
      const [s, st] = await Promise.all([api('/api/admin/settings'), api('/api/admin/storage')]);
      content.innerHTML = `<section><h2>Storage</h2>
        <div class="stats"><div class="stat"><span class="stat-v">${st.videos}</span><span class="stat-l">Videos</span></div>
        <div class="stat"><span class="stat-v">${st.images}</span><span class="stat-l">Screenshots</span></div>
        <div class="stat"><span class="stat-v">${fc.fmtBytes(Number(st.output_bytes) + Number(st.raw_bytes))}</span><span class="stat-l">Total in S3</span></div>
        <div class="stat"><span class="stat-v">${st.legal_holds}</span><span class="stat-l">On legal hold</span></div></div>
        <p class="muted small" style="margin-top:12px">${fc.fmtBytes(st.raw_bytes)} of that is original recordings, kept so trims, cuts, blur and camera changes can be redone.</p></section>
        <section><h2>Retention</h2>
        ${field('Delete videos older than (days)', `<input id="ret" type="number" min="1" value="${s.retentionDays || ''}" placeholder="Keep forever" style="max-width:180px">`, 'Runs hourly. Videos on legal hold are never deleted. Deletions are recorded in the audit log.')}
        ${field('Default storage quota per member (GB)', `<input id="quota" type="number" min="0.1" step="0.5" value="${s.userQuotaGb || ''}" placeholder="Unlimited" style="max-width:180px">`, 'Override per person on the Members page.')}
        <button class="btn btn-primary" id="ret-save">Save</button></section>`;
      $('ret-save').onclick = async () => {
        if ($('ret').value && !confirm(`Videos older than ${$('ret').value} days will be permanently deleted. Continue?`)) return;
        await api('/api/admin/settings', { method: 'PATCH', json: { retentionDays: $('ret').value || null, userQuotaGb: $('quota').value || null } });
        fc.toast('Saved');
      };
    },

    async audit() {
      const rows = await api('/api/admin/audit?limit=300');
      content.innerHTML = `<section><div class="row between"><h2 style="margin:0">Audit log</h2><a class="btn btn-sm" href="/api/admin/audit?format=csv">Export CSV</a></div>
        <table style="margin-top:12px"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td class="small" title="${new Date(r.created_at).toLocaleString()}">${fc.fmtAgo(r.created_at)}</td><td class="small">${fc.esc(r.user_name || 'System')}</td>
          <td class="small"><code>${fc.esc(r.action)}</code></td><td class="audit-meta" title="${fc.esc(JSON.stringify(r.meta))}">${fc.esc(r.target_type || '')} ${fc.esc(JSON.stringify(r.meta) === '{}' ? '' : JSON.stringify(r.meta))}</td></tr>`).join('')}
        </tbody></table></section>`;
    },
  };

  $('logout').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/login'; };

  (async () => {
    cfg = await fc.brand();
    me = await api('/api/me');
    const sections = SECTIONS.filter(([, , adminOnly]) => !adminOnly || me.role === 'admin');
    $('nav').innerHTML = sections.map(([k, l], i) => `${i === 3 ? '<div class="label">Admin</div>' : ''}<a href="#${k}" data-k="${k}">${l}</a>`).join('');
    $('nav').onclick = (e) => {
      const a = e.target.closest('[data-k]');
      if (!a) return;
      e.preventDefault();
      show(a.dataset.k);
    };
    const want = location.hash.slice(1);
    show(sections.some(([k]) => k === want) ? want : 'profile');
  })();
})();
