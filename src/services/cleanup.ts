import { AppError } from '../errors.js';
import { STATUS_BATCH, type BufferClient } from '../buffer/client.js';
import { decideDeletion, DEFAULT_POLICY, nextCheckAt, TERMINAL, type Policy, type PostState, type TrackedStatus } from '../policy.js';
import type { Repo } from '../repo/types.js';
import type { ObjectStore } from '../storage/object-store.js';

export type CleanupDeps = {
  repo: Repo;
  store: ObjectStore;
  buffer: BufferClient;
  policy?: Policy;
  now?: () => Date;
  log?: (e: Record<string, unknown>) => void;
};

/**
 * Two passes, safe to run from several workers at once:
 * 1. checkPosts: ask Buffer for the status of posts that are due a check
 *    (claimed with a lease, batched 25 per request).
 * 2. sweepMedia: delete files whose every post is done (see policy.ts).
 */
export function createCleanupService({ repo, store, buffer, policy = DEFAULT_POLICY, now = () => new Date(), log = () => {} }: CleanupDeps) {
  return {
    async checkPosts(): Promise<{ checked: number; terminal: number }> {
      const t = now();
      const claimed = await repo.claimDuePosts(t, STATUS_BATCH, 2 * 60_000);
      if (claimed.length === 0) return { checked: 0, terminal: 0 };
      let results;
      try {
        results = await buffer.getPosts(claimed.map((p) => p._id));
      } catch (e) {
        // Back off and release the lease; never treat a failed lookup as "deleted".
        const retry = new Date(t.getTime() + 5 * 60_000);
        await Promise.all(claimed.map((p) => repo.updatePost(p._id, { nextCheckAt: retry }, t)));
        log({ level: 'error', event: 'status_check_failed', posts: claimed.length, error: e instanceof AppError ? e.code : String(e) });
        return { checked: 0, terminal: 0 };
      }
      let terminal = 0;
      for (const p of claimed) {
        const r = results.find((x) => x.id === p._id);
        if (!r) continue;
        const status: TrackedStatus = 'notFound' in r ? 'deleted' : r.status;
        const dueAt = 'notFound' in r ? p.dueAt : r.dueAt ? new Date(r.dueAt) : p.dueAt;
        const checks = p.checks + 1;
        const done = TERMINAL.has(status);
        if (done) terminal++;
        await repo.updatePost(
          p._id,
          { status, dueAt, checks, nextCheckAt: nextCheckAt({ status, dueAt, checks }, t), ...(done && !p.terminalAt ? { terminalAt: t } : {}) },
          t
        );
      }
      return { checked: claimed.length, terminal };
    },

    async sweepMedia(maxItems = 500): Promise<{ scanned: number; deleted: number; reasons: Record<string, number> }> {
      const t = now();
      let scanned = 0;
      let deleted = 0;
      const reasons: Record<string, number> = {};
      let after: string | undefined;
      while (scanned < maxItems) {
        const page = await repo.listReadyMedia(100, after);
        if (page.length === 0) break;
        after = page[page.length - 1]!._id;
        const postIds = [...new Set(page.flatMap((m) => m.refs.flatMap((r) => (r.postId ? [r.postId] : []))))];
        const posts = new Map<string, PostState>((await repo.getPosts(postIds)).map((p) => [p._id, { status: p.status, terminalAt: p.terminalAt }]));
        for (const m of page) {
          scanned++;
          const d = decideDeletion(m, posts, t, policy);
          if (!d.delete) continue;
          // Object first: if we crash between the two, the next sweep deletes
          // a missing object (a no-op) and records it. Never the reverse,
          // which would leak a public file we've stopped tracking.
          await store.delete(m.key);
          await repo.markMediaDeleted(m._id, d.reason, t);
          deleted++;
          reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
          if (d.reason === 'max_retention') log({ level: 'warn', event: 'media_deleted_by_backstop', media_id: m._id });
        }
      }
      return { scanned, deleted, reasons };
    },
  };
}

export type CleanupService = ReturnType<typeof createCleanupService>;
