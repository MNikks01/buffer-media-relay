import { MongoServerError, type Collection, type Db } from 'mongodb';
import type { BeginResult, MediaRecord, PostRequest, Repo, TrackedPost } from './types.js';

const EPOCH = new Date(0);
const isDuplicateKey = (e: unknown) => e instanceof MongoServerError && e.code === 11000;

export async function createMongoRepo(db: Db): Promise<Repo> {
  const media: Collection<MediaRecord> = db.collection('media');
  const requests: Collection<PostRequest> = db.collection('post_requests');
  const posts: Collection<TrackedPost> = db.collection('tracked_posts');

  await Promise.all([
    media.createIndex({ state: 1, _id: 1 }),
    posts.createIndex({ nextCheckAt: 1, leaseUntil: 1 }),
  ]);

  return {
    async insertMedia(m) {
      await media.insertOne(m);
    },
    getMedia: (ids) => media.find({ _id: { $in: ids } }).toArray(),
    markMediaReady: (id, bytes) =>
      media.findOneAndUpdate({ _id: id, state: 'pending' }, { $set: { state: 'ready', bytes } }, { returnDocument: 'after' }),
    async addMediaRef(ids, requestKey) {
      await media.updateMany({ _id: { $in: ids }, 'refs.requestKey': { $ne: requestKey } }, { $push: { refs: { requestKey } } });
    },
    async setMediaRefPost(ids, requestKey, postId) {
      await media.updateMany({ _id: { $in: ids }, 'refs.requestKey': requestKey }, { $set: { 'refs.$.postId': postId } });
    },
    async removeMediaRef(ids, requestKey) {
      await media.updateMany({ _id: { $in: ids } }, { $pull: { refs: { requestKey } } });
    },
    async markMediaDeleted(id, reason, now) {
      await media.updateOne({ _id: id }, { $set: { state: 'deleted', deletedAt: now, deleteReason: reason } });
    },
    listReadyMedia: (limit, afterId) =>
      media
        .find({ state: 'ready', ...(afterId ? { _id: { $gt: afterId } } : {}) })
        .sort({ _id: 1 })
        .limit(limit)
        .toArray(),

    async beginRequest(key, requestHash, mediaIds, leaseMs, now): Promise<BeginResult> {
      try {
        await requests.insertOne({
          _id: key,
          requestHash,
          state: 'in_progress',
          leaseUntil: new Date(now.getTime() + leaseMs),
          mediaIds,
          createdAt: now,
          updatedAt: now,
        });
        return { kind: 'started' };
      } catch (e) {
        if (!isDuplicateKey(e)) throw e;
      }
      // Atomic: only one caller converts a dead in_progress request.
      await requests.updateOne(
        { _id: key, state: 'in_progress', leaseUntil: { $lte: now } },
        {
          $set: {
            state: 'outcome_unknown',
            updatedAt: now,
            error: { code: 'outcome_unknown', message: 'The relay stopped while creating this post. It may or may not exist in Buffer.' },
          },
        }
      );
      const existing = await requests.findOne({ _id: key });
      return { kind: 'existing', request: existing! };
    },
    getRequest: (key) => requests.findOne({ _id: key }),
    async finishRequest(key, patch, now) {
      await requests.updateOne({ _id: key }, { $set: { ...patch, updatedAt: now } });
    },
    async deleteRequest(key) {
      await requests.deleteOne({ _id: key });
    },

    async trackPost(p) {
      await posts.updateOne({ _id: p._id }, { $setOnInsert: p }, { upsert: true });
    },
    async claimDuePosts(now, limit, leaseMs) {
      const claimed: TrackedPost[] = [];
      while (claimed.length < limit) {
        const p = await posts.findOneAndUpdate(
          { nextCheckAt: { $ne: null, $lte: now }, leaseUntil: { $lte: now } },
          { $set: { leaseUntil: new Date(now.getTime() + leaseMs) } },
          { sort: { nextCheckAt: 1 }, returnDocument: 'after' }
        );
        if (!p) break;
        claimed.push(p);
      }
      return claimed;
    },
    async updatePost(id, patch) {
      await posts.updateOne({ _id: id }, { $set: { ...patch, leaseUntil: EPOCH } });
    },
    getPosts: (ids) => posts.find({ _id: { $in: ids } }).toArray(),
  };
}
