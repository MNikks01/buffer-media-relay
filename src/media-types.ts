/**
 * What the relay accepts, identified by content, not by name or declared type.
 *
 * Objects are served from a public URL. Trusting a client's Content-Type
 * would let anyone host HTML or SVG (script) under our domain. So every
 * file's first bytes are checked against these signatures, and the object is
 * stored with the type we detected.
 */
export type MediaKind = 'image' | 'video';
export type MediaType = {
  mime: string;
  kind: MediaKind;
  ext: string;
};

export const MEDIA_TYPES: readonly MediaType[] = [
  { mime: 'image/jpeg', kind: 'image', ext: 'jpg' },
  { mime: 'image/png', kind: 'image', ext: 'png' },
  { mime: 'image/gif', kind: 'image', ext: 'gif' },
  { mime: 'image/webp', kind: 'image', ext: 'webp' },
  { mime: 'video/mp4', kind: 'video', ext: 'mp4' },
  { mime: 'video/quicktime', kind: 'video', ext: 'mov' },
];

export const byMime = (mime: string) => MEDIA_TYPES.find((t) => t.mime === mime);

const ascii = (b: Uint8Array, start: number, s: string) =>
  b.length >= start + s.length && [...s].every((c, i) => b[start + i] === c.charCodeAt(0));

/** Needs the first 16 bytes. Returns undefined for anything not allowlisted. */
export function sniff(head: Uint8Array): MediaType | undefined {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return byMime('image/jpeg');
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => head[i] === v)) {
    return byMime('image/png');
  }
  if (ascii(head, 0, 'GIF87a') || ascii(head, 0, 'GIF89a')) return byMime('image/gif');
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return byMime('image/webp');
  // ISO base media: box size, then 'ftyp', then the major brand.
  if (ascii(head, 4, 'ftyp')) {
    return ascii(head, 8, 'qt  ') ? byMime('video/quicktime') : byMime('video/mp4');
  }
  return undefined;
}

export const SNIFF_BYTES = 16;
