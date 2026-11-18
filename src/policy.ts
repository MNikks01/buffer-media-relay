/**
 * When to check a post again, and when a file may be deleted.
 * Pure functions: the whole retention policy is testable without I/O.
 *
 * The rule Buffer's docs force: "Buffer fetches the media when the post goes
 * out, which for scheduled or queued posts can be hours or days later." So a
 * file must outlive its post's publication, not a fixed TTL. Buffer keeps its
 * own copy of media on sent and failed posts, so `sent` is the safe point.
 */

export type PostStatus = 'draft' | 'needs_approval' | 'scheduled' | 'sending' | 'sent' | 'error';
/** Ours: Buffer no longer returns the post (deleted by the user). */
export type TrackedStatus = PostStatus | 'deleted';

export const TERMINAL: ReadonlySet<TrackedStatus> = new Set(['sent', 'error', 'deleted']);

export type Policy = {
  /** Uploaded but never used in a post. */
  orphanTtlMs: number;
  /** After `error`, the user may retry the post in Buffer: keep files a while. */
  errorGraceMs: number;
  /** Backstop for drafts, approvals and unknown outcomes. */
  maxRetentionMs: number;
};

export const DEFAULT_POLICY: Policy = {
  orphanTtlMs: 24 * 3600_000,
  errorGraceMs: 7 * 24 * 3600_000,
  maxRetentionMs: 30 * 24 * 3600_000,
};

const MIN = 60_000;
const BACKOFF = [5 * MIN, 15 * MIN, 60 * MIN, 6 * 60 * MIN];

/**
 * Polls cost rate limit (Free plan: 150 requests per 15 minutes, shared with
 * everything else on the account), so check just after a post is due, then
 * back off. Never before dueAt: nothing changes until then.
 */
export function nextCheckAt(
  p: { status: TrackedStatus; dueAt?: Date; checks: number },
  now: Date
): Date | null {
  if (TERMINAL.has(p.status)) return null;
  if (p.dueAt && p.dueAt.getTime() > now.getTime()) return new Date(p.dueAt.getTime() + 2 * MIN);
  if (!p.dueAt && (p.status === 'draft' || p.status === 'needs_approval')) {
    return new Date(now.getTime() + 6 * 60 * MIN);
  }
  // `checks` already counts the check that just happened.
  const step = BACKOFF[Math.min(Math.max(p.checks - 1, 0), BACKOFF.length - 1)]!;
  return new Date(now.getTime() + step);
}

export type MediaRef = { requestKey: string; postId?: string };
export type PostState = { status: TrackedStatus; terminalAt?: Date };

export type Decision = { delete: false; reason: string } | { delete: true; reason: string };

export function decideDeletion(
  media: { createdAt: Date; refs: MediaRef[] },
  posts: ReadonlyMap<string, PostState>,
  now: Date,
  policy: Policy = DEFAULT_POLICY
): Decision {
  const age = now.getTime() - media.createdAt.getTime();
  if (age > policy.maxRetentionMs) return { delete: true, reason: 'max_retention' };
  if (media.refs.length === 0) {
    return age > policy.orphanTtlMs ? { delete: true, reason: 'orphan' } : { delete: false, reason: 'unused_recent' };
  }
  for (const ref of media.refs) {
    // A request that crashed or got an ambiguous answer: the post may exist
    // and we can't track it. Keep the file until the backstop.
    if (!ref.postId) return { delete: false, reason: 'unresolved_request' };
    const post = posts.get(ref.postId);
    if (!post || !TERMINAL.has(post.status)) return { delete: false, reason: 'post_pending' };
    if (post.status === 'error') {
      const since = post.terminalAt ? now.getTime() - post.terminalAt.getTime() : 0;
      if (since < policy.errorGraceMs) return { delete: false, reason: 'error_grace' };
    }
  }
  return { delete: true, reason: 'all_posts_done' };
}
