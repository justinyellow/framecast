const crypto = require('crypto');
const nodemailer = require('nodemailer');
const config = require('./config');
const db = require('./db');
const jobs = require('./jobs');
const settings = require('./settings');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const link = (v) => `${config.publicUrl}/v/${v.slug}`;

let transport = null;
const mailer = () => (transport ||= nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.secure,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
}));

const emailEnabled = () => !!config.smtp;

async function sendEmail({ to, subject, text, html }) {
  if (!emailEnabled()) return;
  await mailer().sendMail({ from: config.smtp.from, to, subject, text, html });
}

function emailHtml(heading, body, url, cta) {
  return `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#17171c">
<h2 style="font-size:18px;margin:0 0 12px">${esc(heading)}</h2>
<div style="font-size:15px;line-height:1.5;color:#444">${body}</div>
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#5b4cf0;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">${esc(cta)}</a></p>
<p style="font-size:12px;color:#888">You can change notification settings in Framecast under Settings.</p></div>`;
}

// Posts to a Slack or Microsoft Teams incoming webhook. Both accept { text }.
async function postChat(text) {
  const { chatWebhookUrl } = await settings.get();
  if (!chatWebhookUrl) return;
  const r = await fetch(chatWebhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  if (!r.ok) throw new Error(`Chat webhook returned ${r.status}`);
}

async function deliverWebhook({ webhookId, event, data }) {
  const hook = await db.one('SELECT * FROM webhooks WHERE id = $1', [webhookId]);
  if (!hook) return;
  const body = JSON.stringify({ event, data, sentAt: new Date().toISOString() });
  const sig = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
  const r = await fetch(hook.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Framecast-Event': event, 'X-Framecast-Signature': `sha256=${sig}` },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Webhook ${hook.url} returned ${r.status}`);
}

jobs.register('email', sendEmail);
jobs.register('chat', ({ text }) => postChat(text));
jobs.register('webhook', deliverWebhook);

const videoPayload = (v) => ({
  id: v.id, slug: v.slug, title: v.title, url: link(v), kind: v.kind, durationS: v.duration_s, ownerId: v.owner_id,
});

async function fanOutWebhooks(event, data) {
  const { rows } = await db.query('SELECT id FROM webhooks WHERE $1 = ANY(events)', [event]);
  for (const h of rows) await jobs.enqueue('webhook', { webhookId: h.id, event, data }, { maxAttempts: 6 });
}

const owner = (v) => db.one('SELECT * FROM users WHERE id = $1', [v.owner_id]);

async function videoReady(v, { initial = false } = {}) {
  const o = await owner(v);
  const ws = await settings.get();
  if (o?.notify_ready) {
    await jobs.enqueue('email', {
      to: o.email,
      subject: `Your video is ready: ${v.title}`,
      text: `"${v.title}" has finished processing.\n${link(v)}`,
      html: emailHtml('Your video is ready', `<b>${esc(v.title)}</b> has finished processing.`, link(v), 'Open video'),
    });
  }
  if (ws.chatNotifyNewVideo && ['public', 'workspace'].includes(v.visibility) && initial) {
    await jobs.enqueue('chat', { text: `${o?.name || 'Someone'} shared a new ${v.kind === 'image' ? 'screenshot' : 'video'}: ${v.title} - ${link(v)}` });
  }
  await fanOutWebhooks('video.ready', videoPayload(v));
}

async function commentCreated(v, comment, actor) {
  const o = await owner(v);
  const ws = await settings.get();
  const isSelf = actor?.id && actor.id === v.owner_id;
  if (o?.notify_comment && !isSelf) {
    const at = comment.timestampS != null ? ` at ${Math.floor(comment.timestampS / 60)}:${String(Math.floor(comment.timestampS % 60)).padStart(2, '0')}` : '';
    await jobs.enqueue('email', {
      to: o.email,
      subject: `${comment.authorName} commented on ${v.title}`,
      text: `${comment.authorName} commented${at}:\n\n${comment.body}\n\n${link(v)}`,
      html: emailHtml(`${comment.authorName} commented${at}`, `<blockquote style="margin:0;padding-left:12px;border-left:3px solid #ddd">${esc(comment.body)}</blockquote>`, link(v), 'Reply'),
    });
  }
  if (ws.chatNotifyComment && v.visibility !== 'private') {
    await jobs.enqueue('chat', { text: `${comment.authorName} commented on "${v.title}": ${comment.body.slice(0, 200)} - ${link(v)}` });
  }
  await fanOutWebhooks('comment.created', { video: videoPayload(v), comment });
}

async function viewed(v, viewer) {
  const o = await owner(v);
  if (o?.notify_view && !v.first_view_notified) {
    await db.query('UPDATE videos SET first_view_notified = true WHERE id = $1', [v.id]);
    const who = viewer?.name || 'Someone';
    await jobs.enqueue('email', {
      to: o.email,
      subject: `${who} watched ${v.title}`,
      text: `${who} just watched "${v.title}".\n${link(v)}`,
      html: emailHtml(`${who} watched your video`, `<b>${esc(v.title)}</b> got its first view.`, link(v), 'See insights'),
    });
  }
  await fanOutWebhooks('video.viewed', { video: videoPayload(v), viewer: viewer ? { id: viewer.id, name: viewer.name } : null });
}

const videoDeleted = (v) => fanOutWebhooks('video.deleted', videoPayload(v));

module.exports = {
  sendEmail, emailHtml, emailEnabled, videoReady, commentCreated, viewed, videoDeleted, postChat,
  EVENTS: ['video.ready', 'video.viewed', 'video.deleted', 'comment.created'],
};
