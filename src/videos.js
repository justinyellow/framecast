// Shared video helpers: access rules, serialization, deletion.
const config = require('./config');
const db = require('./db');
const storage = require('./storage');
const auth = require('./auth');
const { toLines } = require('./processing/transcribe');
const { keepSegments, toOutput } = require('../public/js/timeline');

const isAdmin = (user) => user?.role === 'admin';
const isOwner = (user, v) => !!user && user.id === v.owner_id;
const canEdit = (user, v) => isOwner(user, v) || isAdmin(user);
const expired = (v) => v.expires_at && new Date(v.expires_at) < new Date();

// public: anyone with the link. workspace: any signed-in member. password: link + password.
// private: owner and admins. Expired links only work for people who can edit.
function canView(req, v) {
  if (canEdit(req.user, v)) return true;
  if (expired(v)) return false;
  if (v.visibility === 'public') return true;
  if (v.visibility === 'workspace') return !!req.user;
  if (v.visibility === 'password') return !!req.user || auth.isUnlocked(req, v.id);
  return false;
}

function viewDenial(req, v) {
  if (expired(v)) return 'expired';
  if (v.visibility === 'workspace' && !req.user) return 'login';
  if (v.visibility === 'password') return 'password';
  return 'notfound';
}

const shareUrl = (slug) => `${config.publicUrl}/v/${slug}`;

// Transcript lines, chapters and blur regions mapped onto the edited (output) timeline.
function derived(v) {
  const keeps = keepSegments(v.edits, v.source_duration_s);
  // Drop words that fall in a cut, then re-time the survivors onto the output timeline.
  const words = (v.transcript || []).map((w) => {
    const mid = (w.s + w.e) / 2;
    const s = toOutput(mid, keeps);
    if (s === null) return null;
    const span = Math.min(w.e - w.s, 2);
    return { w: w.w, s: Math.max(0, s - span / 2), e: s + span / 2 };
  }).filter(Boolean);
  return {
    keeps,
    lines: toLines(words),
    chapters: (v.chapters || []).map((c) => {
      // A chapter that starts inside a cut begins at the next kept moment.
      let s = toOutput(c.s, keeps);
      if (s === null) {
        const next = keeps.find(([a]) => a > c.s);
        s = next ? toOutput(next[0], keeps) : null;
      }
      return s === null ? null : { s, title: c.title };
    }).filter(Boolean),
  };
}

function serialize(v, user) {
  const editable = canEdit(user, v);
  const d = derived(v);
  return {
    id: v.id,
    slug: v.slug,
    kind: v.kind,
    title: v.title,
    status: v.status,
    error: editable ? v.error : null,
    ownerId: v.owner_id,
    ownerName: v.owner_name,
    folderId: v.folder_id,
    durationS: v.duration_s,
    sourceDurationS: editable ? v.source_duration_s : undefined,
    width: v.width,
    height: v.height,
    sizeBytes: Number(v.size_bytes) + Number(v.raw_bytes || 0),
    visibility: v.visibility,
    allowDownload: v.allow_download,
    expiresAt: v.expires_at,
    cta: v.cta_url ? { label: v.cta_label || 'Learn more', url: v.cta_url } : null,
    hasCamera: v.has_camera,
    cameraPosition: v.camera_position,
    cameraSize: v.camera_size,
    edits: editable ? v.edits : undefined,
    transcriptStatus: v.transcript_status,
    aiStatus: v.ai_status,
    summary: v.summary,
    chapters: d.chapters,
    hasCaptions: d.lines.length > 0,
    legalHold: editable ? v.legal_hold : undefined,
    viewCount: v.view_count,
    commentCount: v.comment_count,
    createdAt: v.created_at,
    updatedAt: v.updated_at,
    canEdit: editable,
    shareUrl: shareUrl(v.slug),
    thumbUrl: v.thumb_key ? `/v/${v.slug}/thumb.jpg?t=${new Date(v.updated_at).getTime()}` : null,
  };
}

const bySlug = (slug) => db.one(
  `SELECT v.*, u.name AS owner_name FROM videos v JOIN users u ON u.id = v.owner_id WHERE v.slug = $1 AND v.status <> 'uploading'`,
  [slug],
);
const byId = (id) => db.one(
  `SELECT v.*, u.name AS owner_name FROM videos v JOIN users u ON u.id = v.owner_id WHERE v.id = $1`, [id],
);

async function deleteVideo(v) {
  await db.query('DELETE FROM videos WHERE id = $1', [v.id]);
  if (v.screen_upload_id) await storage.abortMultipart(v.screen_key, v.screen_upload_id);
  if (v.cam_upload_id) await storage.abortMultipart(v.cam_key, v.cam_upload_id);
  await storage.remove([v.screen_key, v.cam_key, v.video_key, v.thumb_key, v.image_key, ...(v.edits?.annotations || []).map((a) => a.key), ...(v.edits?.live || []).map((a) => a.key)]).catch((e) => console.error(e));
}

module.exports = {
  isAdmin, isOwner, canEdit, canView, viewDenial, expired, serialize, derived, bySlug, byId, deleteVideo, shareUrl,
};
