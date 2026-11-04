// Streams a track as S3 multipart parts while recording, so the video is uploaded
// by the time the user hits stop. In "direct" mode parts go straight from the
// browser to S3 via presigned URLs; "proxy" sends them through the app.
const MIN_PART = 5 * 1024 * 1024; // S3 minimum for all but the last part
let uploadMode = null;

async function getUploadMode() {
  if (!uploadMode) uploadMode = (await fc.api('/api/config').catch(() => ({}))).uploadMode || 'proxy';
  return uploadMode;
}

class TrackUploader {
  constructor(videoId, track, onProgress) {
    this.videoId = videoId;
    this.track = track;
    this.onProgress = onProgress || (() => {});
    this.buf = [];
    this.bufSize = 0;
    this.part = 1;
    this.sent = 0;
    this.chain = Promise.resolve();
    this.error = null;
  }

  push(blob) {
    if (!blob || !blob.size) return;
    this.buf.push(blob);
    this.bufSize += blob.size;
    if (this.bufSize >= MIN_PART) this.flush();
  }

  flush() {
    if (!this.bufSize) return;
    const blob = new Blob(this.buf);
    const n = this.part++;
    this.buf = [];
    this.bufSize = 0;
    this.chain = this.chain.then(() => this.send(n, blob));
  }

  async putDirect(n, blob) {
    const base = `/api/videos/${this.videoId}/parts/${this.track}/${n}`;
    const { url } = await fc.api(`${base}/presign`, { method: 'POST' });
    const r = await fetch(url, { method: 'PUT', body: blob });
    if (!r.ok) throw new Error(`S3 upload failed (${r.status})`);
    const etag = r.headers.get('ETag');
    if (!etag) throw Object.assign(new Error('ETag not exposed by bucket CORS'), { cors: true });
    await fc.api(`${base}/done`, { json: { etag, size: blob.size } });
  }

  async putProxy(n, blob) {
    const r = await fetch(`/api/videos/${this.videoId}/parts/${this.track}/${n}`, { method: 'PUT', body: blob, credentials: 'same-origin' });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
  }

  async send(n, blob) {
    if (this.error) return;
    for (let attempt = 0; ; attempt++) {
      try {
        if ((await getUploadMode()) === 'direct') {
          try {
            await this.putDirect(n, blob);
          } catch (e) {
            // A CORS failure shows up as a TypeError; fall back to proxying for the rest of the session.
            if (!(e instanceof TypeError) && !e.cors) throw e;
            console.warn('Direct S3 upload unavailable, falling back to proxy:', e.message);
            uploadMode = 'proxy';
            await this.putProxy(n, blob);
          }
        } else {
          await this.putProxy(n, blob);
        }
        this.sent += blob.size;
        this.onProgress(this);
        return;
      } catch (e) {
        if (attempt >= 4) {
          this.error = e;
          throw e;
        }
        await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
      }
    }
  }

  async finish() {
    this.flush();
    await this.chain;
    if (this.error) throw this.error;
  }
}

async function uploadFile(file, onProgress, { folderId } = {}) {
  if (file.type.startsWith('image/')) {
    const dims = await new Promise((res) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => res({ w: 0, h: 0 });
      img.src = URL.createObjectURL(file);
    });
    const qs = new URLSearchParams({ title: file.name.replace(/\.[^.]+$/, ''), w: dims.w, h: dims.h, ...(folderId ? { folderId } : {}) });
    const r = await fetch(`/api/images?${qs}`, { method: 'POST', body: file, headers: { 'Content-Type': file.type }, credentials: 'same-origin' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Upload failed');
    onProgress?.(1);
    return data;
  }
  const v = await fc.api('/api/videos', {
    json: { title: file.name.replace(/\.[^.]+$/, ''), hasCamera: false, mimeType: file.type || 'video/mp4', folderId },
  });
  const up = new TrackUploader(v.id, 'screen', (u) => onProgress?.(u.sent / file.size));
  const PART = 8 * 1024 * 1024;
  for (let off = 0; off < file.size; off += PART) {
    up.buf = [file.slice(off, off + PART)];
    up.bufSize = Math.min(PART, file.size - off);
    up.flush();
    await up.chain;
  }
  await up.finish();
  return fc.api(`/api/videos/${v.id}/complete`, { method: 'POST' });
}

window.TrackUploader = TrackUploader;
window.uploadFile = uploadFile;
