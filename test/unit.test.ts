import { describe, expect, test } from 'vitest';
import { safeFileName } from '../src/ids.js';
import { sniff } from '../src/media-types.js';
import { decideDeletion, DEFAULT_POLICY, nextCheckAt, type PostState } from '../src/policy.js';
import { BYTES, DAY, HOUR } from './helpers.js';

describe('sniff', () => {
  test('identifies allowlisted types by content', () => {
    expect(sniff(BYTES.png)?.mime).toBe('image/png');
    expect(sniff(BYTES.jpeg)?.mime).toBe('image/jpeg');
    expect(sniff(BYTES.mp4)?.mime).toBe('video/mp4');
    expect(sniff(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBPVP8 ')]))?.mime).toBe('image/webp');
    expect(sniff(new Uint8Array(Buffer.from('GIF89a......')))?.mime).toBe('image/gif');
    expect(sniff(new Uint8Array([0, 0, 0, 0x14, ...Buffer.from('ftypqt  '), 0, 0]))?.mime).toBe('video/quicktime');
  });

  test.each([
    ['html', BYTES.html],
    ['svg (scriptable)', new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))],
    ['pdf', new Uint8Array(Buffer.from('%PDF-1.7\n...'))],
    ['ssh key', new Uint8Array(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----'))],
    ['empty', new Uint8Array()],
  ])('rejects %s', (_, bytes) => {
    expect(sniff(bytes)).toBeUndefined();
  });
});

test('safeFileName keeps URLs readable and safe', () => {
  expect(safeFileName('Launch Photo (final).PNG', 'png')).toBe('launch-photo-final.png');
  expect(safeFileName('../../etc/passwd', 'jpg')).toBe('passwd.jpg');
  expect(safeFileName('C:\\Users\\me\\pic.jpeg', 'jpg')).toBe('pic.jpg');
  expect(safeFileName(undefined, 'mp4')).toBe('media.mp4');
  expect(safeFileName('?%#', 'gif')).toBe('media.gif');
});

describe('nextCheckAt', () => {
  const now = new Date('2026-11-18T08:00:00Z');
  test('waits until just after dueAt: nothing changes before then', () => {
    expect(nextCheckAt({ status: 'scheduled', dueAt: new Date('2026-11-20T10:00:00Z'), checks: 0 }, now)).toEqual(new Date('2026-11-20T10:02:00Z'));
  });
  test('backs off once overdue, capped at 6h', () => {
    const due = new Date('2026-11-18T07:00:00Z');
    const after = (checks: number) => (nextCheckAt({ status: 'sending', dueAt: due, checks }, now)!.getTime() - now.getTime()) / 60_000;
    expect([0, 1, 2, 3, 4, 9].map(after)).toEqual([5, 5, 15, 60, 360, 360]);
  });
  test('terminal posts are never checked again', () => {
    for (const status of ['sent', 'error', 'deleted'] as const) expect(nextCheckAt({ status, checks: 0 }, now)).toBeNull();
  });
  test('drafts without a date are checked rarely', () => {
    expect(nextCheckAt({ status: 'draft', checks: 0 }, now)!.getTime() - now.getTime()).toBe(6 * HOUR);
  });
});

describe('decideDeletion', () => {
  const now = new Date('2026-11-18T08:00:00Z');
  const created = (agoMs: number) => new Date(now.getTime() - agoMs);
  const posts = (entries: Record<string, PostState>) => new Map(Object.entries(entries));

  test.each([
    ['unused, recent', { createdAt: created(HOUR), refs: [] }, {}, false, 'unused_recent'],
    ['unused for a day: orphan', { createdAt: created(DAY + 1), refs: [] }, {}, true, 'orphan'],
    ['request never resolved', { createdAt: created(10 * DAY), refs: [{ requestKey: 'k' }] }, {}, false, 'unresolved_request'],
    ['post scheduled', { createdAt: created(HOUR), refs: [{ requestKey: 'k', postId: 'p' }] }, { p: { status: 'scheduled' } }, false, 'post_pending'],
    ['post sending', { createdAt: created(HOUR), refs: [{ requestKey: 'k', postId: 'p' }] }, { p: { status: 'sending' } }, false, 'post_pending'],
    ['post sent', { createdAt: created(HOUR), refs: [{ requestKey: 'k', postId: 'p' }] }, { p: { status: 'sent' } }, true, 'all_posts_done'],
    ['post deleted in Buffer', { createdAt: created(HOUR), refs: [{ requestKey: 'k', postId: 'p' }] }, { p: { status: 'deleted' } }, true, 'all_posts_done'],
    ['post failed recently: user may retry', { createdAt: created(DAY), refs: [{ requestKey: 'k', postId: 'p' }] }, { p: { status: 'error', terminalAt: created(DAY) } }, false, 'error_grace'],
    ['post failed 8 days ago', { createdAt: created(9 * DAY), refs: [{ requestKey: 'k', postId: 'p' }] }, { p: { status: 'error', terminalAt: created(8 * DAY) } }, true, 'all_posts_done'],
    ['shared file: one post sent, one pending', { createdAt: created(HOUR), refs: [{ requestKey: 'a', postId: 'p1' }, { requestKey: 'b', postId: 'p2' }] }, { p1: { status: 'sent' }, p2: { status: 'scheduled' } }, false, 'post_pending'],
    ['shared file: both sent', { createdAt: created(HOUR), refs: [{ requestKey: 'a', postId: 'p1' }, { requestKey: 'b', postId: 'p2' }] }, { p1: { status: 'sent' }, p2: { status: 'sent' } }, true, 'all_posts_done'],
    ['backstop beats everything', { createdAt: created(31 * DAY), refs: [{ requestKey: 'k' }] }, {}, true, 'max_retention'],
  ] as const)('%s', (_, media, p, del, reason) => {
    expect(decideDeletion(media as never, posts(p as never), now, DEFAULT_POLICY)).toEqual({ delete: del, reason });
  });
});
