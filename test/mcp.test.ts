import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeEach, describe, expect, test } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';
import { createBufferClient } from '../src/buffer/client.js';
import { BYTES, makeSystem } from './helpers.js';

let root: string;
let outside: string;
let s: ReturnType<typeof makeSystem>;
let client: Client;

beforeEach(async () => {
  const base = mkdtempSync(join(tmpdir(), 'relay-'));
  root = join(base, 'media');
  outside = join(base, 'private');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'launch.png'), BYTES.png);
  writeFileSync(join(root, 'clip.mp4'), BYTES.mp4);
  writeFileSync(join(root, 'notes.txt'), 'hello');
  writeFileSync(join(root, 'fake.png'), BYTES.html);
  writeFileSync(join(outside, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----');
  writeFileSync(join(outside, 'secret.png'), BYTES.png);
  symlinkSync(join(outside, 'secret.png'), join(root, 'link.png'));

  s = makeSystem({ mediaRoot: root });
  const server = createMcpServer({ media: s.media, posts: s.posts, buffer: createBufferClient({ apiKey: 'k', fetch: s.fake.fetch }), log: () => {} });
  client = new Client({ name: 't', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
});

async function call(args: Record<string, unknown>) {
  const r = (await client.callTool({ name: 'buffer_upload_and_schedule', arguments: { channel_id: 'ch1', text: 'Launch!', mode: 'addToQueue', ...args } })) as any;
  let data: any;
  try {
    data = JSON.parse(r.content[0].text);
  } catch {
    data = r.content[0].text; // SDK input-validation errors are plain text
  }
  return { isError: !!r.isError, data, structured: r.structuredContent };
}

describe('buffer_upload_and_schedule', () => {
  test('uploads, posts, and returns structured output', async () => {
    const r = await call({ file_paths: ['launch.png', 'clip.mp4'], alt_texts: ['Team on stage'] });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({ post_id: 'post1', status: 'scheduled', deduplicated: false });
    expect(s.fake.creates()[0]!.variables.input.assets).toEqual([
      { image: { url: r.structured.media[0].url, metadata: { altText: 'Team on stage' } } },
      { video: { url: r.structured.media[1].url } },
    ]);
  });

  test('an identical repeat call returns the same post without re-uploading', async () => {
    await call({ file_paths: ['launch.png'] });
    const again = await call({ file_paths: ['launch.png'] });
    expect(again.structured).toMatchObject({ post_id: 'post1', deduplicated: true });
    expect(s.fake.creates()).toHaveLength(1);
    expect(s.store.objects.size).toBe(1);
  });

  test('same file, different text: a new post', async () => {
    await call({ file_paths: ['launch.png'] });
    await call({ file_paths: ['launch.png'], text: 'Different' });
    expect(s.fake.creates()).toHaveLength(2);
  });

  // The output is a PUBLIC url: these are the exfiltration attempts a
  // prompt-injected agent would make.
  test.each([
    ['absolute path outside the media folder', () => join(outside, 'secret.png'), 'invalid_input'],
    ['relative traversal', () => '../private/secret.png', 'invalid_input'],
    ['symlink pointing outside', () => 'link.png', 'invalid_input'],
    ['a private key, even if it were inside', () => join(outside, 'id_ed25519'), 'invalid_input'],
    ['text file inside the folder', () => 'notes.txt', 'media_rejected'],
    ['HTML renamed to .png', () => 'fake.png', 'media_rejected'],
    ['missing file', () => 'nope.png', 'not_found'],
  ])('refuses %s', async (_, path, code) => {
    const r = await call({ file_paths: [path()] });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe(code);
    expect(s.store.objects.size).toBe(0);
    expect(s.fake.creates()).toHaveLength(0);
  });

  test('due_at needs an offset', async () => {
    const r = await call({ file_paths: ['launch.png'], mode: 'customScheduled', due_at: '2026-11-20 09:00' });
    expect(r.isError).toBe(true);
    expect(s.fake.creates()).toHaveLength(0);
  });

  test('tools/list: two tools, annotated, with output schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['buffer_list_channels', 'buffer_upload_and_schedule']);
    expect(tools.every((t) => t.outputSchema && t.annotations)).toBe(true);
    expect(tools.find((t) => t.name === 'buffer_upload_and_schedule')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  test('buffer_list_channels', async () => {
    const r = (await client.callTool({ name: 'buffer_list_channels', arguments: {} })) as any;
    expect(r.structuredContent).toEqual({ channels: [{ id: 'ch1', name: 'Acme on LinkedIn', service: 'linkedin' }] });
  });
});
