import { createBufferClient } from '../src/buffer/client.js';
import { createApp } from '../src/http/app.js';
import { createCleanupService } from '../src/services/cleanup.js';
import { createMediaService } from '../src/services/media.js';
import { createPostsService } from '../src/services/posts.js';
import { createFakeBuffer } from './fakes/fake-buffer.js';
import { createMemoryRepo } from './fakes/memory-repo.js';
import { createMemoryStore } from './fakes/memory-store.js';

export const API_KEY = 'k'.repeat(40);

/** Minimal valid file headers for each type. */
export const BYTES = {
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]),
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 9, 9]),
  mp4: new Uint8Array([0, 0, 0, 0x20, ...Buffer.from('ftypisom'), 0, 0, 2, 0, 1, 2, 3, 4]),
  html: new Uint8Array(Buffer.from('<html><script>alert(1)</script></html>')),
};

/** The full service on in-memory storage and a fake Buffer, with a controllable clock. */
export function makeSystem(opts: { mediaRoot?: string } = {}) {
  let now = new Date('2026-11-18T08:00:00Z');
  const clock = () => new Date(now);
  const repo = createMemoryRepo();
  const store = createMemoryStore();
  const fake = createFakeBuffer();
  const buffer = createBufferClient({ apiKey: 'buf-key', fetch: fake.fetch, sleep: async () => {} });
  const media = createMediaService({ repo, store, mediaRoot: opts.mediaRoot, now: clock });
  const checkedUrls: string[] = [];
  const posts = createPostsService({ repo, media, buffer, now: clock, checkUrl: async (u) => void checkedUrls.push(u) });
  const cleanup = createCleanupService({ repo, store, buffer, now: clock });
  const app = createApp({ media, posts, apiKey: API_KEY, log: () => {} });

  async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
  }

  /** init → client PUT → complete. */
  async function upload(bytes: Uint8Array, contentType = 'image/png') {
    const init = await http('POST', '/v1/uploads', { contentType, bytes: bytes.length, fileName: 'Launch Photo.PNG' });
    const key = new URL(init.body.upload.url).pathname.slice(1);
    store.clientPut(key, bytes, contentType);
    return http('POST', `/v1/uploads/${init.body.mediaId}/complete`);
  }

  return {
    repo,
    store,
    fake,
    media,
    posts,
    cleanup,
    http,
    upload,
    checkedUrls,
    clock,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    setNow: (iso: string) => (now = new Date(iso)),
  };
}

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
