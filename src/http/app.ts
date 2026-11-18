import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { AppError, HTTP_STATUS, RETRYABLE } from '../errors.js';
import type { Logger } from '../logger.js';
import type { MediaService } from '../services/media.js';
import type { PostsService } from '../services/posts.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const initBody = z.object({
  contentType: z.string().max(100),
  bytes: z.number().int().positive(),
  fileName: z.string().max(200).optional(),
});

const postBody = z.object({
  channelId: id,
  text: z.string().max(10_000),
  mode: z.enum(['addToQueue', 'customScheduled', 'shareNext', 'shareNow']),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  media: z.array(z.object({ id, altText: z.string().min(1).max(1000).optional() })).min(1).max(10),
});

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * REST, not GraphQL: uploads are binary and go straight to object storage,
 * and the three calls here are a protocol (init → PUT → complete → post), not
 * a graph. A Buffer-hosted version would add `createUpload` /
 * `completeUpload` mutations to the existing schema instead.
 */
export function createApp(deps: { media: MediaService; posts: PostsService; apiKey: string; log: Logger }) {
  const app = new Hono();
  const expected = digest(deps.apiKey);

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('/v1/*', bodyLimit({ maxSize: 64 * 1024 }), async (c, next) => {
    const h = c.req.header('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    // Compare digests: constant time, and no length leak.
    if (!timingSafeEqual(digest(token), expected)) throw new AppError('unauthorized', 'Missing or invalid API key.');
    await next();
  });

  const parse = async <T extends z.ZodType>(schema: T, req: Request): Promise<z.infer<T>> => {
    const raw = await req.json().catch(() => {
      throw new AppError('invalid_input', 'Body must be JSON.');
    });
    const r = schema.safeParse(raw);
    if (!r.success) throw new AppError('invalid_input', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    return r.data;
  };

  app.post('/v1/uploads', async (c) => c.json(await deps.media.initUpload(await parse(initBody, c.req.raw)), 201));

  app.post('/v1/uploads/:id/complete', async (c) => {
    const mediaId = id.safeParse(c.req.param('id'));
    if (!mediaId.success) throw new AppError('not_found', 'No such upload.');
    return c.json(await deps.media.completeUpload(mediaId.data));
  });

  app.post('/v1/posts', async (c) => {
    const key = c.req.header('idempotency-key');
    if (!key) throw new AppError('invalid_input', 'Idempotency-Key header is required: createPost has no server-side dedupe.');
    const result = await deps.posts.create(await parse(postBody, c.req.raw), key);
    return c.json(result, result.replayed ? 200 : 201);
  });

  app.onError((e, c) => {
    if (e instanceof AppError) {
      if (e.code === 'rate_limited' && e.details?.retryAfterMs) c.header('Retry-After', String(Math.ceil(Number(e.details.retryAfterMs) / 1000)));
      return c.json({ error: { code: e.code, message: e.message, retryable: RETRYABLE.has(e.code) } }, HTTP_STATUS[e.code] as 400);
    }
    deps.log({ level: 'error', event: 'unhandled', path: c.req.path, detail: String((e as Error)?.stack ?? e) });
    return c.json({ error: { code: 'internal', message: 'Internal error.', retryable: false } }, 500);
  });

  return app;
}
