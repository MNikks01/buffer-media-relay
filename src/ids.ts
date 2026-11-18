import { createHash, randomBytes } from 'node:crypto';

/** 128 bits, URL-safe. Used where an ID must be unguessable. */
export const randomId = () => randomBytes(16).toString('base64url');

export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** Key-order-independent JSON, so the same request always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

/** Keeps a readable, safe file name for the public URL: [a-z0-9._-], max 64. */
export function safeFileName(name: string | undefined, ext: string): string {
  const base = (name ?? 'media')
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]*$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 56);
  return `${base || 'media'}.${ext}`;
}
