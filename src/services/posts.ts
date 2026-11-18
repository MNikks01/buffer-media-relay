import { AppError, type ErrorCode } from '../errors.js';
import type { AssetInput, BufferClient, ShareMode } from '../buffer/client.js';
import { canonicalJson, sha256 } from '../ids.js';
import { nextCheckAt, TERMINAL } from '../policy.js';
import type { Repo } from '../repo/types.js';
import type { MediaService } from './media.js';

export type CreatePostRequest = {
  channelId: string;
  text: string;
  mode: ShareMode;
  /** Required for customScheduled; ISO 8601. */
  dueAt?: string;
  media: Array<{ id: string; altText?: string }>;
};

export type CreatePostResult = {
  postId: string;
  status: string;
  dueAt: string | null;
  media: Array<{ id: string; url: string }>;
  /** True when this is the stored result of an earlier identical request. */
  replayed: boolean;
};

export type PostsServiceDeps = {
  repo: Repo;
  media: MediaService;
  buffer: BufferClient;
  /** Pre-flight: can the public internet fetch this URL? Injected for tests. */
  checkUrl?: (url: string, contentType: string) => Promise<void>;
  now?: () => Date;
};

/**
 * Must outlast the longest createPost call (timeouts plus 429 waits), or a
 * second caller would declare a live request dead.
 */
export const REQUEST_LEASE_MS = 5 * 60_000;
const NOT_PROCESSED: ReadonlySet<ErrorCode> = new Set(['rate_limited', 'unauthorized']);

export function createPostsService({ repo, media, buffer, checkUrl = defaultCheckUrl, now = () => new Date() }: PostsServiceDeps) {
  function validate(r: CreatePostRequest) {
    if (r.media.length < 1 || r.media.length > 10) throw new AppError('invalid_input', 'Attach 1 to 10 media items.');
    if (new Set(r.media.map((m) => m.id)).size !== r.media.length) throw new AppError('invalid_input', 'Duplicate media id.');
    if (r.mode === 'customScheduled') {
      if (!r.dueAt) throw new AppError('invalid_input', 'dueAt is required for customScheduled.');
      const due = Date.parse(r.dueAt);
      if (Number.isNaN(due)) throw new AppError('invalid_input', 'dueAt must be ISO 8601.');
      if (due <= now().getTime()) throw new AppError('invalid_input', 'dueAt must be in the future.');
    } else if (r.dueAt) {
      throw new AppError('invalid_input', 'dueAt is only valid with mode customScheduled.');
    }
  }

  function replay(stored: Awaited<ReturnType<Repo['getRequest']>>, hash: string): CreatePostResult {
    const r = stored!;
    if (r.requestHash !== hash) {
      throw new AppError('idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
    }
    switch (r.state) {
      case 'in_progress':
        throw new AppError('request_in_progress', 'A request with this Idempotency-Key is still running. Retry shortly.');
      case 'succeeded':
        return { ...(r.response as Omit<CreatePostResult, 'replayed'>), replayed: true };
      case 'failed':
        throw new AppError((r.error?.code ?? 'buffer_rejected') as ErrorCode, r.error?.message ?? 'Request failed.');
      case 'outcome_unknown':
        throw new AppError('outcome_unknown', r.error?.message ?? 'The post may or may not have been created: check Buffer.');
    }
  }

  return {
    requestHash: (r: CreatePostRequest) => sha256(canonicalJson(r)),

    /** For callers that want to skip work (e.g. uploads) when a key already resolved. */
    async peek(key: string, hash: string): Promise<CreatePostResult | null> {
      const existing = await repo.getRequest(key);
      return existing ? replay(existing, hash) : null;
    },

    /**
     * `requestHash` defaults to a hash of `req`. Callers whose request
     * contains per-attempt values (the MCP tool's fresh upload IDs) pass a
     * hash of what's stable instead.
     */
    async create(req: CreatePostRequest, idempotencyKey: string, requestHash?: string): Promise<CreatePostResult> {
      if (!/^[\x21-\x7e]{8,255}$/.test(idempotencyKey)) {
        throw new AppError('invalid_input', 'Idempotency-Key must be 8–255 printable ASCII characters (a UUID works).');
      }
      validate(req);
      const hash = requestHash ?? sha256(canonicalJson(req));
      const ids = req.media.map((m) => m.id);
      const records = await media.requireReady(ids);

      const begin = await repo.beginRequest(idempotencyKey, hash, ids, REQUEST_LEASE_MS, now());
      if (begin.kind === 'existing') return replay(begin.request, hash);

      // Reference first: from here until the request resolves, the sweeper
      // treats these files as in use, even if this process dies.
      await repo.addMediaRef(ids, idempotencyKey);
      const forget = async () => {
        await repo.removeMediaRef(ids, idempotencyKey);
        await repo.deleteRequest(idempotencyKey);
      };

      try {
        await Promise.all(records.map((m) => checkUrl(m.url, m.contentType)));
      } catch (e) {
        await forget();
        throw e instanceof AppError ? e : new AppError('media_unreachable', `Media URL isn't publicly reachable: ${(e as Error).message}`);
      }

      const assets: AssetInput[] = records.map((m, i) => {
        const alt = req.media[i]!.altText;
        return m.kind === 'video' ? { video: { url: m.url } } : { image: { url: m.url, ...(alt ? { metadata: { altText: alt } } : {}) } };
      });

      let post;
      try {
        post = await buffer.createPost({ channelId: req.channelId, text: req.text, mode: req.mode, dueAt: req.dueAt ? new Date(req.dueAt).toISOString() : undefined, assets });
      } catch (e) {
        const err = e instanceof AppError ? e : new AppError('outcome_unknown', `Unexpected error creating the post: ${(e as Error).message}`);
        if (NOT_PROCESSED.has(err.code)) {
          await forget();
        } else if (err.code === 'buffer_rejected') {
          await repo.removeMediaRef(ids, idempotencyKey);
          await repo.finishRequest(idempotencyKey, { state: 'failed', error: { code: err.code, message: err.message } }, now());
        } else {
          // outcome_unknown: keep the reference (no postId) so the files
          // survive until the retention backstop. A post may exist.
          await repo.finishRequest(idempotencyKey, { state: 'outcome_unknown', error: { code: 'outcome_unknown', message: err.message } }, now());
        }
        throw err;
      }

      await repo.setMediaRefPost(ids, idempotencyKey, post.id);
      const t = now();
      const dueAt = post.dueAt ? new Date(post.dueAt) : undefined;
      await repo.trackPost({
        _id: post.id,
        status: post.status,
        dueAt,
        mediaIds: ids,
        checks: 0,
        nextCheckAt: nextCheckAt({ status: post.status, dueAt, checks: 0 }, t),
        leaseUntil: new Date(0),
        ...(TERMINAL.has(post.status) ? { terminalAt: t } : {}),
      });
      const response = {
        postId: post.id,
        status: post.status,
        dueAt: post.dueAt ?? null,
        media: records.map((m) => ({ id: m._id, url: m.url })),
      };
      await repo.finishRequest(idempotencyKey, { state: 'succeeded', response }, t);
      return { ...response, replayed: false };
    },
  };
}

export type PostsService = ReturnType<typeof createPostsService>;

/**
 * Buffer's createPost fetches the file to read its dimensions, and fails with
 * "Failed to fetch image dimensions" if it can't. Checking first turns a
 * misconfigured bucket policy into a clear error before anything is sent.
 */
async function defaultCheckUrl(url: string, contentType: string) {
  const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  if (res.status !== 200) throw new AppError('media_unreachable', `${url} returned ${res.status} to an anonymous HEAD request (Buffer needs 200, no redirect).`);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.startsWith(contentType)) throw new AppError('media_unreachable', `${url} is served as "${ct}", expected ${contentType}.`);
}
