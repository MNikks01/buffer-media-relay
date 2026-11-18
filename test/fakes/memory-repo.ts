import type { BeginResult, MediaRecord, PostRequest, Repo, TrackedPost } from '../../src/repo/types.js';

const EPOCH = new Date(0);
const clone = <T>(v: T): T => structuredClone(v);

/** Same semantics as the MongoDB repo; the contract tests check both. */
export function createMemoryRepo(): Repo & { dump(): { media: MediaRecord[]; requests: PostRequest[]; posts: TrackedPost[] } } {
  const media = new Map<string, MediaRecord>();
  const requests = new Map<string, PostRequest>();
  const posts = new Map<string, TrackedPost>();

  return {
    dump: () => ({ media: [...media.values()].map(clone), requests: [...requests.values()].map(clone), posts: [...posts.values()].map(clone) }),

    async insertMedia(m) {
      if (media.has(m._id)) throw new Error('duplicate key');
      media.set(m._id, clone(m));
    },
    getMedia: async (ids) => ids.flatMap((id) => (media.has(id) ? [clone(media.get(id)!)] : [])),
    async markMediaReady(id, bytes) {
      const m = media.get(id);
      if (!m || m.state !== 'pending') return null;
      Object.assign(m, { state: 'ready', bytes });
      return clone(m);
    },
    async addMediaRef(ids, requestKey) {
      for (const id of ids) {
        const m = media.get(id);
        if (m && !m.refs.some((r) => r.requestKey === requestKey)) m.refs.push({ requestKey });
      }
    },
    async setMediaRefPost(ids, requestKey, postId) {
      for (const id of ids) {
        const ref = media.get(id)?.refs.find((r) => r.requestKey === requestKey);
        if (ref) ref.postId = postId;
      }
    },
    async removeMediaRef(ids, requestKey) {
      for (const id of ids) {
        const m = media.get(id);
        if (m) m.refs = m.refs.filter((r) => r.requestKey !== requestKey);
      }
    },
    async markMediaDeleted(id, reason, now) {
      const m = media.get(id);
      if (m) Object.assign(m, { state: 'deleted', deletedAt: now, deleteReason: reason });
    },
    listReadyMedia: async (limit, afterId) =>
      [...media.values()]
        .filter((m) => m.state === 'ready' && (!afterId || m._id > afterId))
        .sort((a, b) => (a._id < b._id ? -1 : 1))
        .slice(0, limit)
        .map(clone),

    async beginRequest(key, requestHash, mediaIds, leaseMs, now): Promise<BeginResult> {
      const existing = requests.get(key);
      if (!existing) {
        requests.set(key, { _id: key, requestHash, state: 'in_progress', leaseUntil: new Date(now.getTime() + leaseMs), mediaIds, createdAt: now, updatedAt: now });
        return { kind: 'started' };
      }
      if (existing.state === 'in_progress' && existing.leaseUntil.getTime() <= now.getTime()) {
        Object.assign(existing, {
          state: 'outcome_unknown',
          updatedAt: now,
          error: { code: 'outcome_unknown', message: 'The relay stopped while creating this post. It may or may not exist in Buffer.' },
        });
      }
      return { kind: 'existing', request: clone(existing) };
    },
    getRequest: async (key) => (requests.has(key) ? clone(requests.get(key)!) : null),
    async finishRequest(key, patch, now) {
      const r = requests.get(key);
      if (r) Object.assign(r, patch, { updatedAt: now });
    },
    async deleteRequest(key) {
      requests.delete(key);
    },

    async trackPost(p) {
      if (!posts.has(p._id)) posts.set(p._id, clone(p));
    },
    async claimDuePosts(now, limit, leaseMs) {
      const due = [...posts.values()]
        .filter((p) => p.nextCheckAt && p.nextCheckAt <= now && p.leaseUntil <= now)
        .sort((a, b) => a.nextCheckAt!.getTime() - b.nextCheckAt!.getTime())
        .slice(0, limit);
      for (const p of due) p.leaseUntil = new Date(now.getTime() + leaseMs);
      return due.map(clone);
    },
    async updatePost(id, patch) {
      const p = posts.get(id);
      if (p) Object.assign(p, patch, { leaseUntil: EPOCH });
    },
    getPosts: async (ids) => ids.flatMap((id) => (posts.has(id) ? [clone(posts.get(id)!)] : [])),
  };
}
