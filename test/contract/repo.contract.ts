import { describe, expect, test } from 'vitest';
import type { MediaRecord, Repo } from '../../src/repo/types.js';

/**
 * Behavior every Repo implementation must have. Runs against the in-memory
 * repo always, and against MongoDB when RUN_INTEGRATION=1 (docker compose).
 */
export function repoContract(name: string, make: () => Promise<Repo>) {
  const t0 = new Date('2026-11-18T08:00:00Z');
  const at = (ms: number) => new Date(t0.getTime() + ms);
  const media = (id: string): MediaRecord => ({ _id: id, key: `m/${id}/a.png`, url: `https://x/${id}`, state: 'pending', contentType: 'image/png', kind: 'image', bytes: 10, refs: [], createdAt: t0 });

  describe(`Repo contract: ${name}`, () => {
    test('markMediaReady only transitions pending, once', async () => {
      const r = await make();
      await r.insertMedia(media('m1'));
      expect(await r.markMediaReady('m1', 10)).toMatchObject({ state: 'ready' });
      expect(await r.markMediaReady('m1', 10)).toBeNull();
    });

    test('refs: add is idempotent, set post, remove', async () => {
      const r = await make();
      await r.insertMedia(media('m1'));
      await r.addMediaRef(['m1'], 'k1');
      await r.addMediaRef(['m1'], 'k1');
      await r.addMediaRef(['m1'], 'k2');
      await r.setMediaRefPost(['m1'], 'k1', 'p1');
      expect((await r.getMedia(['m1']))[0]!.refs).toEqual([{ requestKey: 'k1', postId: 'p1' }, { requestKey: 'k2' }]);
      await r.removeMediaRef(['m1'], 'k2');
      expect((await r.getMedia(['m1']))[0]!.refs).toEqual([{ requestKey: 'k1', postId: 'p1' }]);
    });

    test('listReadyMedia pages by id and skips other states', async () => {
      const r = await make();
      for (const id of ['a', 'b', 'c', 'd']) {
        await r.insertMedia(media(id));
        if (id !== 'c') await r.markMediaReady(id, 10);
      }
      await r.markMediaDeleted('d', 'test', t0);
      expect((await r.listReadyMedia(1)).map((m) => m._id)).toEqual(['a']);
      expect((await r.listReadyMedia(10, 'a')).map((m) => m._id)).toEqual(['b']);
    });

    test('beginRequest: exactly one caller starts, even concurrently', async () => {
      const r = await make();
      const results = await Promise.all(Array.from({ length: 10 }, () => r.beginRequest('key', 'h', [], 60_000, t0)));
      expect(results.filter((x) => x.kind === 'started')).toHaveLength(1);
      expect(results.filter((x) => x.kind === 'existing').every((x) => x.kind === 'existing' && x.request.state === 'in_progress')).toBe(true);
    });

    test('beginRequest: an expired in_progress lease becomes outcome_unknown', async () => {
      const r = await make();
      await r.beginRequest('key', 'h', [], 60_000, t0);
      const live = await r.beginRequest('key', 'h', [], 60_000, at(30_000));
      expect(live.kind === 'existing' && live.request.state).toBe('in_progress');
      const dead = await r.beginRequest('key', 'h', [], 60_000, at(61_000));
      expect(dead.kind === 'existing' && dead.request.state).toBe('outcome_unknown');
    });

    test('finish and delete requests', async () => {
      const r = await make();
      await r.beginRequest('key', 'h', ['m1'], 60_000, t0);
      await r.finishRequest('key', { state: 'succeeded', response: { postId: 'p1' } }, at(1000));
      expect(await r.getRequest('key')).toMatchObject({ state: 'succeeded', response: { postId: 'p1' }, mediaIds: ['m1'] });
      await r.deleteRequest('key');
      expect(await r.getRequest('key')).toBeNull();
    });

    test('claimDuePosts: only due, unleased posts; a claim blocks a second claim until released', async () => {
      const r = await make();
      const base = { status: 'scheduled' as const, mediaIds: [], checks: 0, leaseUntil: new Date(0) };
      await r.trackPost({ ...base, _id: 'due', nextCheckAt: at(-1) });
      await r.trackPost({ ...base, _id: 'later', nextCheckAt: at(60_000) });
      await r.trackPost({ ...base, _id: 'done', status: 'sent', nextCheckAt: null });
      expect((await r.claimDuePosts(t0, 10, 120_000)).map((p) => p._id)).toEqual(['due']);
      expect(await r.claimDuePosts(t0, 10, 120_000)).toEqual([]);
      await r.updatePost('due', { checks: 1, nextCheckAt: at(-1) }, t0);
      expect((await r.claimDuePosts(t0, 10, 120_000)).map((p) => p._id)).toEqual(['due']);
    });

    test('trackPost never overwrites an existing post', async () => {
      const r = await make();
      const base = { mediaIds: [], checks: 0, leaseUntil: new Date(0), nextCheckAt: null };
      await r.trackPost({ ...base, _id: 'p1', status: 'sent' });
      await r.trackPost({ ...base, _id: 'p1', status: 'scheduled' });
      expect((await r.getPosts(['p1']))[0]!.status).toBe('sent');
    });
  });
}
