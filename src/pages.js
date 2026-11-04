const config = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const jsonForScript = (o) => JSON.stringify(o).replace(/</g, '\\u003c');

function layout({ title, head = '', body, bodyClass = '', ws }) {
  const brand = ws?.brandColor && /^#[0-9a-f]{6}$/i.test(ws.brandColor) ? `<style>:root{--accent:${ws.brandColor}}</style>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/css/app.css">
${brand}
${head}
</head>
<body class="${bodyClass}">${body}</body>
</html>`;
}

const brandMark = (ws) => (ws?.logoKey
  ? `<img class="brand-logo" src="/brand/logo" alt="">`
  : '<span class="brand-dot"></span>');

const topbar = (user, ws) => `<header class="topbar">
  <a class="brand" href="${user ? '/app' : '/'}">${brandMark(ws)}${esc(ws?.workspaceName || 'Framecast')}</a>
  <nav>${user
    ? '<a class="btn btn-ghost" href="/app">Library</a><a class="btn btn-primary" href="/record">Record</a>'
    : '<a class="btn btn-ghost" href="/login">Sign in</a>'}</nav>
</header>`;

function share(v, { user, settings: ws, data }) {
  const url = data.shareUrl;
  const pub = v.visibility === 'public';
  const thumb = `${config.publicUrl}/v/${v.slug}/thumb.jpg`;
  const desc = v.summary || `${v.kind === 'image' ? 'A screenshot' : 'A video'} by ${v.owner_name}`;
  const head = `
<meta name="description" content="${esc(desc.slice(0, 300))}">
<meta property="og:type" content="${v.kind === 'image' ? 'website' : 'video.other'}">
<meta property="og:site_name" content="${esc(ws.workspaceName)}">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${esc(desc.slice(0, 300))}">
<meta property="og:url" content="${esc(url)}">
${pub && v.thumb_key ? `<meta property="og:image" content="${esc(thumb)}"><meta name="twitter:image" content="${esc(thumb)}">` : ''}
${pub && v.video_key ? `<meta property="og:video" content="${esc(`${config.publicUrl}/v/${v.slug}/media`)}"><meta property="og:video:type" content="video/mp4">` : ''}
<meta name="twitter:card" content="${pub ? 'summary_large_image' : 'summary'}">
${pub ? `<link rel="alternate" type="application/json+oembed" href="${esc(`${config.publicUrl}/oembed?url=${encodeURIComponent(url)}`)}">` : ''}`;

  const boot = {
    video: data,
    user: user ? { id: user.id, name: user.name, role: user.role } : null,
    embedUrl: `${config.publicUrl}/embed/${v.slug}`,
  };

  const body = `${topbar(user, ws)}
<main class="share">
  <section class="share-main">
    <div class="player-wrap" id="player-wrap"><div class="player-placeholder">Loading…</div></div>
    <div class="timeline" id="timeline" hidden></div>
    <div class="player-bar" id="player-bar" hidden>
      <div class="row wrap" id="reaction-bar"></div>
      <div class="row">
        <button class="btn btn-ghost btn-sm" id="cc" hidden aria-pressed="false" title="Captions">CC</button>
        <div class="speed" id="speed" role="group" aria-label="Playback speed"></div>
      </div>
    </div>
    <div class="share-head">
      <div class="share-title">
        <h1 id="title" ${data.canEdit ? 'contenteditable="plaintext-only" spellcheck="false" title="Click to rename"' : ''}>${esc(v.title)}</h1>
        <p class="muted">${esc(v.owner_name)} · <time datetime="${new Date(v.created_at).toISOString()}" id="created"></time> · <span id="views">${v.view_count}</span> views</p>
      </div>
      <div class="share-actions">
        <a class="btn btn-cta" id="cta" hidden target="_blank" rel="noopener"></a>
        <button class="btn btn-primary" id="copy-link">Copy link</button>
        <a class="btn" id="download" hidden>Download</a>
      </div>
    </div>
    <section class="card-flat" id="summary-card" hidden>
      <div class="summary-head"><span class="pill">Summary</span><button class="btn btn-ghost btn-sm" id="regen" hidden>Regenerate</button></div>
      <p id="summary"></p>
      <ol class="chapters" id="chapters"></ol>
    </section>
    ${data.canEdit ? '<section class="panel" id="owner-panel"></section>' : ''}
  </section>
  <aside class="sidebar">
    <div class="side-tabs" role="tablist">
      <button class="tab active" data-side="comments">Comments <span class="muted" id="comment-count"></span></button>
      <button class="tab" data-side="transcript" id="transcript-tab" hidden>Transcript</button>
    </div>
    <div class="side-body" data-side-body="comments">
      <ol id="activity" class="comment-list"></ol>
      <form id="comment-form" class="comment-form">
        <input id="comment-name" placeholder="Your name" maxlength="80" ${user ? 'hidden' : 'required'}>
        <textarea id="comment-body" placeholder="Add a comment…" rows="3" maxlength="2000" required></textarea>
        <div class="row between">
          <label class="check small muted" id="ts-wrap"><input type="checkbox" id="comment-ts" checked> at <span id="comment-ts-label">0:00</span></label>
          <button class="btn btn-primary" type="submit">Post</button>
        </div>
      </form>
    </div>
    <div class="side-body" data-side-body="transcript" hidden>
      <input type="search" id="transcript-search" placeholder="Search transcript">
      <div id="transcript" class="transcript"></div>
    </div>
  </aside>
</main>
<script>window.FC = ${jsonForScript(boot)};</script>
<script src="/static/js/common.js"></script>
<script src="/static/js/timeline.js"></script>
<script src="/static/js/share.js"></script>
${data.canEdit ? '<script src="/static/js/owner.js"></script><script src="/static/js/draw.js"></script>' : ''}`;
  return layout({ title: `${v.title} · ${ws.workspaceName}`, head, body, ws });
}

function password(v, ws, error) {
  const body = `${topbar(null, ws)}
<main class="center">
  <form class="card auth-card" method="post" action="/v/${esc(v.slug)}/unlock">
    <h1>${esc(v.title)}</h1>
    <p class="muted">This ${v.kind === 'image' ? 'screenshot' : 'video'} is password protected.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <input name="password" type="password" placeholder="Password" required autofocus>
    <button class="btn btn-primary" type="submit">Continue</button>
  </form>
</main>`;
  return layout({ title: `Protected · ${ws.workspaceName}`, body, ws });
}

function embed(v, data) {
  let body;
  if (v.kind === 'image') body = `<img class="embed-img" src="/v/${esc(v.slug)}/media" alt="${esc(v.title)}">`;
  else if (v.video_key) {
    body = `<video src="/v/${esc(v.slug)}/media" ${v.thumb_key ? `poster="/v/${esc(v.slug)}/thumb.jpg"` : ''} controls playsinline preload="metadata">
  ${data.hasCaptions ? `<track kind="captions" src="/v/${esc(v.slug)}/captions.vtt" srclang="en" label="English">` : ''}
</video>`;
  } else body = '<div class="player-placeholder">Processing…</div>';
  body += `<a class="embed-badge" href="/v/${esc(v.slug)}" target="_blank" rel="noopener">${esc(v.title)}</a>`;
  if (data.cta) body += `<a class="embed-cta" href="${esc(data.cta.url)}" target="_blank" rel="noopener">${esc(data.cta.label)}</a>`;
  return layout({ title: v.title, body, bodyClass: 'embed' });
}

function notFound(ws, message = 'It may have been deleted, or the link is wrong.') {
  return layout({
    title: `Not available · ${ws?.workspaceName || 'Framecast'}`,
    ws,
    body: `${topbar(null, ws)}<main class="center"><div class="card auth-card"><h1>Not available</h1><p class="muted">${esc(message)}</p></div></main>`,
  });
}

module.exports = { share, password, embed, notFound, esc };
