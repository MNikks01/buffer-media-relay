import { describe, expect, test } from 'vitest';
import { BYTES, DAY, HOUR, makeSystem } from './helpers.js';

const KEY = 'idem-key-0001';
const post = (mediaId: string, extra: Record<string, unknown> = {}) => ({ channelId: 'ch1', text: 'Launch day', mode: 'addToQueue', media: [{ id: mediaId, altText: 'Team photo' }], ...extra });

describe('upload', () => {
  test('init → PUT → complete gives a permanent public URL with a safe name', async () => {
    const s = makeSystem();
    const r = await s.upload(BYTES.png);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ contentType: 'image/png', kind: 'image', bytes: BYTES.png.length });
    expect(r.body.url).toMatch(/^https:\/\/media\.test\/m\/[A-Za-z0-9_-]{22}\/launch-photo\.png$/);
  });

  test('HTML uploaded as image/png is rejected and deleted from the bucket', async () => {
    const s = makeSystem();
    const r = await s.upload(BYTES.html, 'image/png');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('media_rejected');
    expect(s.store.objects.size).toBe(0);
  });

  test('size must match what was declared (and signed)', async () => {
    const s = makeSystem();
    const init = await s.http('POST', '/v1/uploads', { contentType: 'image/png', bytes: 999 });
    const key = new URL(init.body.upload.url).pathname.slice(1);
    s.store.clientPut(key, BYTES.png, 'image/png');
    expect((await s.http('POST', `/v1/uploads/${init.body.mediaId}/complete`)).body.error.code).toBe('media_rejected');
  });

  test('unsupported types and oversized files are refused before any upload URL is issued', async () => {
    const s = makeSystem();
    expect((await s.http('POST', '/v1/uploads', { contentType: 'image/svg+xml', bytes: 10 })).status).toBe(422);
    expect((await s.http('POST', '/v1/uploads', { contentType: 'image/png', bytes: 21 * 1024 ** 2 })).status).toBe(422);
  });

  test('complete before PUT says so', async () => {
    const s = makeSystem();
    const init = await s.http('POST', '/v1/uploads', { contentType: 'image/png', bytes: 19 });
    expect((await s.http('POST', `/v1/uploads/${init.body.mediaId}/complete`)).body.error.code).toBe('media_not_ready');
  });

  test('every /v1 route requires the API key', async () => {
    const s = makeSystem();
    const r = await s.http('POST', '/v1/uploads', { contentType: 'image/png', bytes: 10 }, { authorization: 'Bearer wrong' });
    expect(r.status).toBe(401);
  });
});

describe('create post', () => {
  test('sends the public URL and alt text to Buffer, pre-flight checks the URL', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const r = await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ postId: 'post1', status: 'scheduled', replayed: false, media: [{ id: m.body.id, url: m.body.url }] });
    expect(s.fake.creates()[0]!.variables.input.assets).toEqual([{ image: { url: m.body.url, metadata: { altText: 'Team photo' } } }]);
    expect(s.checkedUrls).toEqual([m.body.url]);
  });

  test('video assets go in as { video }', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.mp4, 'video/mp4');
    await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    expect(s.fake.creates()[0]!.variables.input.assets).toEqual([{ video: { url: m.body.url } }]);
  });

  test('Idempotency-Key is required', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    expect((await s.http('POST', '/v1/posts', post(m.body.id))).body.error.code).toBe('invalid_input');
  });

  test('customScheduled needs a future dueAt with an offset', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const bad = await s.http('POST', '/v1/posts', post(m.body.id, { mode: 'customScheduled', dueAt: '2026-11-17T10:00:00Z' }), { 'idempotency-key': KEY });
    expect(bad.body.error.message).toMatch(/future/);
    const good = await s.http('POST', '/v1/posts', post(m.body.id, { mode: 'customScheduled', dueAt: '2026-11-20T09:30:00+05:30' }), { 'idempotency-key': KEY });
    expect(good.status).toBe(201);
    expect(s.fake.creates()[0]!.variables.input.dueAt).toBe('2026-11-20T04:00:00.000Z');
  });
});

describe('idempotency', () => {
  test('same key + same body: one post, the retry gets the stored result', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const a = await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    const b = await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body).toMatchObject({ postId: a.body.postId, replayed: true });
    expect(s.fake.creates()).toHaveLength(1);
  });

  test('same key + different body is refused', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    const r = await s.http('POST', '/v1/posts', post(m.body.id, { text: 'Different' }), { 'idempotency-key': KEY });
    expect(r.body.error.code).toBe('idempotency_key_reused');
    expect(s.fake.creates()).toHaveLength(1);
  });

  test('concurrent requests with one key: exactly one createPost', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY })));
    expect(s.fake.creates()).toHaveLength(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status !== 201).every((r) => r.status === 200 || r.body.error?.code === 'request_in_progress')).toBe(true);
  });

  test('outcome unknown (502 from Buffer): never retried, files kept, retry gets the same answer', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    s.fake.nextCreate({ status: 502 });
    const a = await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    expect(a.status).toBe(502);
    expect(a.body.error).toMatchObject({ code: 'outcome_unknown', retryable: false });
    const b = await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    expect(b.body.error.code).toBe('outcome_unknown');
    expect(s.fake.creates()).toHaveLength(1);
    // The file may be in a live post: it survives the orphan sweep.
    s.advance(2 * DAY);
    await s.cleanup.sweepMedia();
    expect(s.store.objects.size).toBe(1);
  });

  test('rate limited after retries: nothing was created, so the key is released for a retry', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const r429 = { status: 429, headers: { 'retry-after': '1' } };
    s.fake.nextCreate(r429, r429, r429, r429);
    expect((await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY })).status).toBe(429);
    expect((await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY })).status).toBe(201);
  });

  test('Buffer rejection is stored and replayed; the file goes back to unused', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const a = await s.http('POST', '/v1/posts', post(m.body.id, { text: 'REJECT' }), { 'idempotency-key': KEY });
    expect(a.body.error.code).toBe('buffer_rejected');
    const b = await s.http('POST', '/v1/posts', post(m.body.id, { text: 'REJECT' }), { 'idempotency-key': KEY });
    expect(b.body.error.code).toBe('buffer_rejected');
    expect(s.fake.creates()).toHaveLength(1);
    expect(s.repo.dump().media[0]!.refs).toEqual([]);
  });

  test('a process that died mid-request: after the lease expires, the key reports outcome_unknown', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const hash = s.posts.requestHash(post(m.body.id) as never);
    await s.repo.beginRequest(KEY, hash, [m.body.id], 5 * 60_000, s.clock()); // simulate a crash after begin
    expect((await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY })).body.error.code).toBe('request_in_progress');
    s.advance(6 * 60_000);
    expect((await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY })).body.error.code).toBe('outcome_unknown');
    expect(s.fake.creates()).toHaveLength(0);
  });

  test('pre-flight failure (bucket not public) sends nothing and frees the key', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const { createPostsService } = await import('../src/services/posts.js');
    const { createBufferClient } = await import('../src/buffer/client.js');
    const posts = createPostsService({
      repo: s.repo,
      media: s.media,
      buffer: createBufferClient({ apiKey: 'k', fetch: s.fake.fetch }),
      now: s.clock,
      checkUrl: async () => {
        throw new Error('403 Forbidden');
      },
    });
    await expect(posts.create(post(m.body.id) as never, KEY)).rejects.toMatchObject({ code: 'media_unreachable' });
    expect(s.fake.creates()).toHaveLength(0);
    expect(await s.repo.getRequest(KEY)).toBeNull();
  });
});

describe('lifecycle: files live exactly as long as Buffer needs them', () => {
  test('kept while scheduled, deleted once Buffer reports sent', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const p = await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });

    // Before dueAt (fake queue slot: 2026-11-19T09:00Z) nothing is checked.
    s.setNow('2026-11-19T08:00:00Z');
    expect(await s.cleanup.checkPosts()).toEqual({ checked: 0, terminal: 0 });
    await s.cleanup.sweepMedia();
    expect(s.store.objects.size).toBe(1);

    // Due, still sending: checked, kept.
    s.setNow('2026-11-19T09:03:00Z');
    s.fake.publish(p.body.postId, 'sending');
    expect(await s.cleanup.checkPosts()).toEqual({ checked: 1, terminal: 0 });
    await s.cleanup.sweepMedia();
    expect(s.store.objects.size).toBe(1);

    // Published: next check sees `sent`, the sweep deletes the file.
    s.fake.publish(p.body.postId, 'sent');
    s.advance(5 * 60_000);
    expect(await s.cleanup.checkPosts()).toEqual({ checked: 1, terminal: 1 });
    expect(await s.cleanup.sweepMedia()).toMatchObject({ deleted: 1, reasons: { all_posts_done: 1 } });
    expect(s.store.objects.size).toBe(0);
    expect(s.repo.dump().media[0]).toMatchObject({ state: 'deleted', deleteReason: 'all_posts_done' });
  });

  test('a file shared by two posts waits for both', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const a = await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': 'key-a-000001' });
    const b = await s.http('POST', '/v1/posts', post(m.body.id, { channelId: 'ch2' }), { 'idempotency-key': 'key-b-000001' });
    s.setNow('2026-11-19T09:05:00Z');
    s.fake.publish(a.body.postId, 'sent');
    await s.cleanup.checkPosts();
    await s.cleanup.sweepMedia();
    expect(s.store.objects.size).toBe(1);
    s.fake.publish(b.body.postId, 'sent');
    s.advance(HOUR);
    await s.cleanup.checkPosts();
    await s.cleanup.sweepMedia();
    expect(s.store.objects.size).toBe(0);
  });

  test('failed post: kept 7 days in case the user retries it in Buffer', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const p = await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    s.setNow('2026-11-19T09:05:00Z');
    s.fake.publish(p.body.postId, 'error');
    await s.cleanup.checkPosts();
    s.advance(6 * DAY);
    await s.cleanup.sweepMedia();
    expect(s.store.objects.size).toBe(1);
    s.advance(2 * DAY);
    await s.cleanup.sweepMedia();
    expect(s.store.objects.size).toBe(0);
  });

  test('post deleted in Buffer: file deleted', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    const p = await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    s.fake.deleteInBuffer(p.body.postId);
    s.setNow('2026-11-19T09:05:00Z');
    await s.cleanup.checkPosts();
    expect((await s.cleanup.sweepMedia()).deleted).toBe(1);
  });

  test('Buffer down during a check: nothing is deleted, the check is retried later', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    await s.http('POST', '/v1/posts', post(m.body.id), { 'idempotency-key': KEY });
    s.setNow('2026-11-19T09:05:00Z');
    s.fake.nextLookups({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    expect(await s.cleanup.checkPosts()).toEqual({ checked: 0, terminal: 0 });
    await s.cleanup.sweepMedia();
    expect(s.store.objects.size).toBe(1);
    expect(s.repo.dump().posts[0]!.nextCheckAt).toEqual(new Date('2026-11-19T09:10:00Z'));
  });

  test('uploaded but never posted: deleted after 24h', async () => {
    const s = makeSystem();
    await s.upload(BYTES.png);
    s.advance(23 * HOUR);
    await s.cleanup.sweepMedia();
    expect(s.store.objects.size).toBe(1);
    s.advance(2 * HOUR);
    expect(await s.cleanup.sweepMedia()).toMatchObject({ deleted: 1, reasons: { orphan: 1 } });
  });

  test('status checks are batched: 30 due posts cost 2 requests, not 30', async () => {
    const s = makeSystem();
    const m = await s.upload(BYTES.png);
    for (let i = 0; i < 30; i++) await s.http('POST', '/v1/posts', post(m.body.id, { text: `post ${i}` }), { 'idempotency-key': `key-${String(i).padStart(8, '0')}` });
    s.setNow('2026-11-19T09:05:00Z');
    await s.cleanup.checkPosts();
    await s.cleanup.checkPosts();
    expect(s.fake.calls.filter((c) => c.op === 'getPosts')).toHaveLength(2);
  });
});
