import { describe, expect, test } from 'vitest';
import { createBufferClient, STATUS_BATCH } from '../src/buffer/client.js';
import { createFakeBuffer } from './fakes/fake-buffer.js';

const make = () => {
  const fake = createFakeBuffer();
  const waits: number[] = [];
  const remaining: Array<number | undefined> = [];
  const client = createBufferClient({ apiKey: 'k', fetch: fake.fetch, sleep: async (ms) => void waits.push(ms), onRateLimit: (r) => remaining.push(r) });
  return { fake, client, waits, remaining };
};
const input = { channelId: 'ch1', text: 'hi', mode: 'addToQueue' as const, assets: [{ image: { url: 'https://m.test/a.png' } }] };

describe('createPost', () => {
  test('sends the documented mutation shape', async () => {
    const { fake, client, remaining } = make();
    const post = await client.createPost({ ...input, assets: [{ image: { url: 'https://m.test/a.png', metadata: { altText: 'A cat' } } }] });
    expect(post).toMatchObject({ id: 'post1', status: 'scheduled' });
    expect(fake.creates()[0]!.variables.input).toEqual({
      channelId: 'ch1',
      text: 'hi',
      schedulingType: 'automatic',
      mode: 'addToQueue',
      assets: [{ image: { url: 'https://m.test/a.png', metadata: { altText: 'A cat' } } }],
    });
    expect(remaining).toEqual([149]);
  });

  test('MutationError is a definitive rejection', async () => {
    const { client } = make();
    await expect(client.createPost({ ...input, text: 'REJECT' })).rejects.toMatchObject({ code: 'buffer_rejected', message: expect.stringContaining('Text is invalid') });
  });

  test('429 is retried with Retry-After (not processed, no quota used)', async () => {
    const { fake, client, waits } = make();
    fake.nextCreate({ status: 429, headers: { 'retry-after': '7' }, body: { errors: [{ message: 'Too many', extensions: { code: 'RATE_LIMIT_EXCEEDED' } }] } });
    await expect(client.createPost(input)).resolves.toMatchObject({ id: 'post1' });
    expect(waits).toEqual([7000]);
    expect(fake.creates()).toHaveLength(2);
  });

  test.each([
    ['5xx', { status: 502 }],
    ['network error', 'network_error' as const],
  ])('%s on createPost is outcome_unknown and NOT retried', async (_, reply) => {
    const { fake, client } = make();
    fake.nextCreate(reply as never);
    await expect(client.createPost(input)).rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(fake.creates()).toHaveLength(1);
  });

  test('401 explains where to fix it', async () => {
    const { fake, client } = make();
    fake.nextCreate({ status: 401 });
    await expect(client.createPost(input)).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('Settings → API') });
  });
});

describe('getPosts', () => {
  test('one aliased request for a batch', async () => {
    const { fake, client } = make();
    for (let i = 0; i < 3; i++) await client.createPost(input);
    fake.publish('post2');
    const r = await client.getPosts(['post1', 'post2', 'post3']);
    expect(r.map((p) => ('status' in p ? p.status : 'missing'))).toEqual(['scheduled', 'sent', 'scheduled']);
    expect(fake.calls.filter((c) => c.op === 'getPosts')).toHaveLength(1);
  });

  test('a deleted post nulls the batch (Post! is non-null): falls back to one-by-one', async () => {
    const { fake, client } = make();
    await client.createPost(input);
    await client.createPost(input);
    fake.deleteInBuffer('post1');
    const r = await client.getPosts(['post1', 'post2']);
    expect(r).toEqual([{ id: 'post1', notFound: true }, expect.objectContaining({ id: 'post2', status: 'scheduled' })]);
  });

  test('a failed lookup is an error, never "not found"', async () => {
    const { fake, client } = make();
    fake.nextLookups({ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
    await expect(client.getPosts(['post1'])).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  test(`refuses more than ${STATUS_BATCH} ids (Buffer caps aliases at 30)`, async () => {
    const { client } = make();
    await expect(client.getPosts(Array.from({ length: STATUS_BATCH + 1 }, (_, i) => `p${i}`))).rejects.toThrow();
  });
});
