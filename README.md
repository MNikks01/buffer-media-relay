# buffer-media-relay

Post images and videos to Buffer from files, without hosting them yourself. The relay uploads each file, keeps it publicly reachable until Buffer has published the post, then deletes it. It has two interfaces: a small HTTP API, and an MCP tool (`buffer_upload_and_schedule`) so an agent can post from local files.

**Target:** Buffer · Senior Backend Engineer, Platform & API
**Problem:** Buffer's [API roadmap](https://developers.buffer.com/roadmap) lists these as *Exploring*:
- "Image assets for API" (upload instead of hosting a public URL, purge after posting);
- "Copy media to Buffer storage after post creation";
- "Binary file upload (FILE_UPLOAD) support for TikTok in MCP API".

Today [Buffer has no upload endpoint](https://developers.buffer.com/guides/hosting-media.html): every asset must be a public URL you host.

## The finding to lead with

The obvious fix is to upload to S3 and pass a presigned URL to `createPost`, then expire it with a TTL. **Buffer's docs say that fails.** Buffer fetches media when the post *goes out*, which "for scheduled or queued posts can be hours or days later". Signed URLs "often work the moment you call `createPost` but expire before the post publishes, causing it to fail silently".

So a file's lifetime has to follow its post's status, not a clock. The relay polls Buffer for each post's status and deletes a file only when every post using it is done:

| Post status | File |
|---|---|
| `draft`, `needs_approval`, `scheduled`, `sending` | kept |
| `sent` | deleted (Buffer keeps its own copy of media on sent posts) |
| deleted in Buffer | deleted |
| `error` | kept 7 days (the user may retry the post), then deleted |
| never used in a post | deleted after 24h |
| anything, after 30 days | deleted (backstop) |

## How it works

```
client ──POST /v1/uploads──▶ relay ──presigned PUT──▶ client uploads file straight to S3/R2
client ──POST /v1/uploads/:id/complete──▶ relay sniffs the bytes, marks ready
client ──POST /v1/posts (Idempotency-Key)──▶ relay ──createPost(assets: public URLs)──▶ Buffer
worker ──every minute──▶ Buffer `post` status (25 per request) ──▶ delete files whose posts are done
```

MongoDB holds media records, idempotency records and tracked posts. Files live in any S3-compatible bucket (AWS S3, Cloudflare R2, RustFS).

## Run

```bash
npm ci && npm run check                        # typecheck, 79 tests, build
docker compose up -d && npm run test:integration   # real MongoDB + RustFS (S3)
cp .env.example .env                           # fill in; then:
npm run http      # HTTP API on :8787
npm run worker    # cleanup loop (run exactly one or more; they coordinate with leases)
npm run mcp       # MCP server over stdio
```

Claude Code:

```bash
claude mcp add buffer-media \
  -e BUFFER_API_KEY=... -e MONGO_URL=mongodb://127.0.0.1:27017 -e S3_BUCKET=... \
  -e PUBLIC_MEDIA_BASE_URL=https://... -e MEDIA_ROOT="$HOME/Pictures/buffer" \
  -- node "$PWD/dist/bin/mcp.js"
```

The MCP server only uploads files inside `MEDIA_ROOT`. Run `npm run worker` alongside it, or files are never cleaned up.

**Bucket:** allow anonymous `s3:GetObject` on `m/*` only. No listing, nothing else:

```json
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Principal": "*", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::BUCKET/m/*" }] }
```

On R2, enable the public `r2.dev` URL or a custom domain, and set `PUBLIC_MEDIA_BASE_URL` to it.

## API

```bash
# 1. Reserve an upload (types: image/jpeg|png|gif|webp, video/mp4|quicktime; 20 MB images, 1 GB video)
curl -X POST localhost:8787/v1/uploads -H "Authorization: Bearer $RELAY_API_KEY" \
  -H 'Content-Type: application/json' -d '{"contentType":"image/png","bytes":48213,"fileName":"launch.png"}'
# → { mediaId, upload: { method: "PUT", url, headers, expiresAt } }

# 2. PUT the file to upload.url with upload.headers, then:
curl -X POST localhost:8787/v1/uploads/$MEDIA_ID/complete -H "Authorization: Bearer $RELAY_API_KEY"
# → { id, url, contentType, kind, bytes }

# 3. Create the post
curl -X POST localhost:8787/v1/posts -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"channelId":"...","text":"Launch day","mode":"customScheduled","dueAt":"2026-11-20T09:30:00+05:30",
       "media":[{"id":"'$MEDIA_ID'","altText":"Team on stage"}]}'
# → 201 { postId, status, dueAt, media, replayed: false }
```

Errors are `{ error: { code, message, retryable } }`. The one to handle carefully is `outcome_unknown` (502): Buffer may have created the post. **Check Buffer before retrying.** A retry with the same key returns the same answer instead of posting twice.

## Trade-offs that matter

| Decision | Why | Cost |
|---|---|---|
| **File lifetime follows post status, not a TTL.** | It's the only design that survives scheduled posts (see above). | A worker has to poll Buffer, which spends shared rate limit. See the next row. |
| **Polling is cheap:** first check 2 min after `dueAt`, then 5 min, 15 min, 1h, 6h. Up to 25 posts per request via GraphQL aliases (Buffer allows 30). | The Free plan allows 150 requests per 15 min, *shared with everything else on the account*. A scheduled post costs nothing until it's due. | A file can outlive its post by up to about 6h. Storage is cheap; the rate limit isn't. |
| **Public bucket with unguessable keys** (128-bit random prefix, read-only on `m/*`, no listing), not served through the relay. | Buffer may fetch days later. A bucket or CDN is far more available than one Node process, and nothing in the request path has to stay up. | Anyone holding a URL can fetch the file until it's deleted. That's acceptable: the post makes the media public anyway. |
| **Types are detected from content, not trusted from the client.** Allowlist: JPEG, PNG, GIF, WebP, MP4, MOV. No SVG. | The bucket is public: accepting a client's `Content-Type` would let anyone host HTML or SVG (script) on our domain. The presigned URL also signs type and size. | Formats Buffer accepts but we don't (e.g. PDF documents) need an allowlist change. |
| **`Idempotency-Key` required.** Unknown outcomes are never retried. A 429 releases the key. | `createPost` has no idempotency field. A blind retry after a 502 could double-post on someone's company LinkedIn. | The client has to handle `outcome_unknown` by checking Buffer. That's one extra step instead of a silent duplicate post. |
| **The file is marked "in use" *before* calling Buffer.** | If the process dies after Buffer accepted the post, the file must not be swept as unused. It's kept until the 30-day backstop instead. | A crash at exactly that point means up to 30 days of extra storage for that file. |
| **MCP: local files must be inside `MEDIA_ROOT`** (after resolving symlinks), and must be valid media by content. | The tool turns a local file into a *public URL*. A prompt-injected agent asking for `~/.ssh/id_ed25519` is the obvious attack. | Users have to put files in one folder. |
| **REST for uploads, not GraphQL.** | Binary uploads go straight to storage; these three calls are a protocol, not a graph. | Inside Buffer, this would become `createUpload` / `completeUpload` mutations on the existing schema. |
| **30-day backstop.** | Drafts and approval-pending posts have no due date, and unknown-outcome requests can't be tracked. Something has to bound storage. | A draft left unpublished for over 30 days loses its media. That needs a product decision; it's set in `policy.ts`. |

## Verified

- `npm test`: **79/79**.
  - The deletion policy as a decision table: 12 cases, including shared files and the error grace period.
  - The Buffer client against a fake that parses the real GraphQL operations. It covers the mutation shape, 429 retries, no retry on 5xx or network errors, batching with aliases, and one deleted post nulling a batch (`post` returns `Post!`) with a one-by-one fallback.
  - The HTTP flow end to end:
    - content sniffing rejects HTML uploaded as PNG;
    - five concurrent requests with one idempotency key produce one post;
    - unknown outcome, rate limit, rejection and crashed-process paths;
    - the pre-flight check.
  - The full file lifecycle on a fake clock.
  - The MCP tool: 7 exfiltration attempts refused (absolute path, `../`, symlink, private key, text, HTML renamed to `.png`, missing file); a repeat call doesn't re-upload.
  - Repository contract tests on the in-memory implementation.
- Mutation checks: the tests catch each of these deliberate breaks:
  - removing the "in use before calling Buffer" step (5 tests fail);
  - retrying `createPost` on a 5xx (2 tests fail).
- Config validation: missing values listed, a non-https public URL refused.
- **The MongoDB repository against a real MongoDB:** all 8 contract tests pass, run on my Mac on 2026-11-18. They cover the atomic single-starter under 10 concurrent callers, lease expiry, claim/release and refs.
- `npm audit --omit=dev`: 0 vulnerabilities. Dependencies pinned, all at least 7 days old. The full audit flags `picomatch` ≤4.0.7, a ReDoS ([GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf)), through vitest and vite. It's dev-only, it's only reached with our own test globs, and no patched version exists yet. npm's suggested "fix" is a two-major vitest downgrade, so I left it.

**Not verified yet:**
- The S3 store against a real S3 server. `docker compose up -d && npm run test:integration` runs it against RustFS: presigned PUT, the signed content type, anonymous GET, no listing, delete. (The first attempt used MinIO, which [no longer publishes community images](https://itsfoss.com/news/minio-moves-away-from-open-source/).)
- Live Buffer:
  - the exact error shape when `post` is asked for a deleted post (I assumed a `NOT_FOUND` code or a "not found" message);
  - whether retrying a failed post in Buffer re-fetches the original URL (the reason for the 7-day grace period);
  - real channel behaviour per network.

## If Buffer built this natively

Add `createUpload` → presigned PUT into Buffer's own storage, and let `AssetInput` take `{ image: { uploadId } }`. Buffer already keeps media for sent posts for two years, so the upload *is* the copy. No external hosting, no status polling, no cleanup worker. This relay is the bridge until then; the trade-offs above are what the native version would remove.
