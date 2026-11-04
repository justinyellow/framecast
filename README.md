# Framecast

Self-hosted async video and screenshots for teams (Loom alternative). One Docker image runs as a **web** service and a **worker** service: Node 22, Postgres, S3, ffmpeg and whisper.cpp.

## Get it

Prebuilt images (linux/amd64 and linux/arm64) are published on every push to `main`:

```sh
docker pull ghcr.io/justinyellow/framecast:latest     # or :sha-<commit>, or :1.2.3 for tagged releases
```

## Run locally

```sh
git clone https://github.com/justinyellow/framecast && cd framecast
docker compose pull && docker compose up -d     # use the published image
# or: docker compose up -d --build              # build from this checkout
open http://localhost:3900        # you're signed in automatically as a local admin (DEV_AUTO_LOGIN)
open http://localhost:8126        # Mailpit: every email the app sends lands here
```

The compose file is for local testing only: it signs everyone in automatically and uses throwaway secrets. For a real deployment, use the ECS templates below (or your own compose) with real `SESSION_SECRET`, database and S3 settings, and no `DEV_AUTO_LOGIN`.

To get AI titles, summaries and chapters, export `ANTHROPIC_API_KEY` before running `docker compose up`.

## Features

**Recording and capture**
- Record screen + camera, screen only, or camera only. Mic and tab/system audio are mixed together.
- Pause and resume. The camera can pop out into Picture-in-Picture while you work in another tab.
- Pick the camera bubble's corner and size before recording, and change either afterwards (the camera is stored as a separate track).
- Screenshots: capture, paste or open an image, then mark it up with arrows, boxes, highlights, pen, text, blur and crop.
- Upload many videos or images at once, by drag-and-drop or the file picker. This covers bulk-importing Loom downloads.
- Chrome extension (`extension/`): popup plus Alt+Shift+R / Alt+Shift+S shortcuts.

**Processing (worker)**
- The browser uploads straight to S3 (multipart) while recording, so the link is ready the moment you stop.
- Output is H.264/AAC MP4 with a circular camera overlay and a thumbnail.
- Transcripts and captions come from local whisper.cpp with DTW word timings. No external service is involved.
- AI title, summary and chapters come from Claude (optional).
- All editing is non-destructive and works on the original recording:
  - Trim the start and end.
  - Edit by transcript: click words to cut them, cut filler words in one click, and shorten pauses.
  - Blur regions for the whole video or a time range.
  - Move the camera bubble.

**Sharing and viewing**
- Link access: anyone with the link, workspace members only, password, or private. Links can expire. Downloads can be turned on or off.
- Share pages show:
  - The player, with a timeline of chapters, comments and reactions.
  - Speed controls (1–2×), captions, and resume where you left off.
  - The summary and clickable chapters.
  - A searchable transcript you can click to jump.
  - Timestamped comments (anonymous viewers allowed) and emoji reactions.
  - An optional call-to-action button.
- Open Graph and oEmbed (Slack, Teams and Notion unfurl links), plus an embeddable iframe player.

**Teams and admin**
- One workspace with admin, member and viewer roles; email invites; shared folders; and a team library with search across titles, summaries and transcripts.
- SSO through OIDC (Google Workspace, Microsoft Entra ID, Okta), with optional auto-provisioning limited to your email domain.
- Insights: views, unique viewers, average % watched, a retention curve, named viewer list and CSV export.
- Notifications:
  - Email for comments, first view and processing finished.
  - Posts to a Slack or Teams channel through an incoming webhook.
  - Signed outgoing webhooks (`video.ready`, `video.viewed`, `video.deleted`, `comment.created`).
- Personal API tokens (`Authorization: Bearer fc_…`).
- Branding: workspace name, color and logo. Use your own domain through `PUBLIC_URL`.
- Retention policy (automatic deletion after N days), legal hold, per-user storage quotas, and an audit log with CSV export.

## Architecture

```
browser ──(presigned PUT, multipart)──────────────▶ S3  (videos/<id>/raw-screen, raw-cam)
browser ──▶ ALB ──▶ web (ROLE=web) ──▶ Postgres (videos, jobs queue, audit…)
                                            ▲
                    worker (ROLE=worker) ───┘  claims jobs (FOR UPDATE SKIP LOCKED)
                      download raw → ffmpeg / whisper → upload video.mp4 + thumb.jpg → S3
viewers ◀── 302 to presigned S3 URL (or CloudFront signed URL)
```

- **Storage layout:** `videos/<id>/raw-screen`, `raw-cam` (originals, kept so edits can be redone), `video.mp4`, `thumb.jpg`, `image.png`; `brand/logo-*`.
- **No video bytes go through the app.** Uploads go straight to S3. Playback and downloads get a 302 redirect to a short-lived signed URL.
- **The job queue is a Postgres table.** No SQS is needed. Both web and worker services scale horizontally.

## Configuration

| Var | Notes |
| --- | --- |
| `ROLE` | `web`, `worker` or `all` (default) |
| `PUBLIC_URL` | External base URL, e.g. `https://video.example.com` |
| `DATABASE_URL`, `DATABASE_SSL` | Postgres; `DATABASE_SSL=true` for RDS |
| `SESSION_SECRET` | Long random string |
| `S3_BUCKET`, `AWS_REGION` | On AWS, credentials come from the task role |
| `UPLOAD_MODE` | `direct` (default, needs bucket CORS) or `proxy` |
| `CLOUDFRONT_DOMAIN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY` | Optional: serve playback through CloudFront signed URLs |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_CREATE_BUCKET` | Local or non-AWS S3 only |
| `ALLOW_SIGNUP` | `true` = open sign-up. Otherwise it's invite-only after the first user |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_LABEL`, `OIDC_ALLOWED_DOMAINS`, `OIDC_AUTO_PROVISION`, `DISABLE_PASSWORD_LOGIN` | SSO. Redirect URL: `<PUBLIC_URL>/auth/sso/callback`. Admins can still use a password if SSO breaks |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Email (SES SMTP works) |
| `ANTHROPIC_API_KEY`, `AI_SUMMARIES`, `AI_MODEL` | AI summaries; defaults to `claude-opus-5-5` |
| `TRANSCRIBE`, `WHISPER_MODEL`, `WHISPER_THREADS` | Transcription. Build with `--build-arg WHISPER_MODEL=small.en` for higher accuracy |
| `PROCESS_CONCURRENCY` | Parallel jobs per worker task |

## Deploying to ECS (Fargate)

Templates are in `deploy/ecs/`.

1. **Build and push the image:** `docker build -t framecast . && docker push <ecr>/framecast`
2. **Create the S3 bucket.**
   - Block all public access and turn on default encryption.
   - Apply `s3-cors.json`, set to your domain. Direct uploads need it to read the `ETag`.
   - Apply `s3-lifecycle.json`. It aborts unfinished multipart uploads and moves media to Intelligent-Tiering.
3. **Create RDS Postgres** (16+) and put `DATABASE_URL` and `SESSION_SECRET` in Secrets Manager.
4. **Create the IAM task role** with `task-role-policy.json`.
5. **Create two services from the same image:**
   - **web** (`task-definition-web.json`): 0.5 vCPU / 1 GB behind an ALB. Health check is `/healthz`. Scale on CPU or request count.
   - **worker** (`task-definition-worker.json`): 2 vCPU / 4 GB with 60 GB ephemeral storage. No load balancer. Scale on queued jobs: `SELECT count(*) FROM jobs WHERE status='queued'`.
6. **Optional:**
   - CloudFront in front of the bucket (Origin Access Control plus a key group), then set the `CLOUDFRONT_*` variables.
   - SES for SMTP.
   - SSO app registration.

Migrations run automatically at startup, behind a Postgres advisory lock.

## Not included yet

These need a desktop app or an outside app registration:
- Drawing over other apps while recording
- Click highlighting
- Automatic zoom and cursor smoothing
- Background blur for the camera
- A native Teams messaging extension (needs an Azure Bot registration; links still unfurl in Teams through Open Graph)
- Caption translation
