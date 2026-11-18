import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { AppError } from '../errors.js';
import { randomId, safeFileName } from '../ids.js';
import { byMime, SNIFF_BYTES, sniff, type MediaType } from '../media-types.js';
import type { MediaRecord, Repo } from '../repo/types.js';
import type { ObjectStore } from '../storage/object-store.js';

export type MediaLimits = { imageBytes: number; videoBytes: number };
export const DEFAULT_LIMITS: MediaLimits = { imageBytes: 20 * 1024 ** 2, videoBytes: 1024 ** 3 };

export type MediaServiceDeps = {
  repo: Repo;
  store: ObjectStore;
  limits?: MediaLimits;
  /** MCP only: local files must be inside this directory. */
  mediaRoot?: string;
  now?: () => Date;
};

export type PublicMedia = { id: string; url: string; contentType: string; kind: 'image' | 'video'; bytes: number };

const toPublic = (m: MediaRecord): PublicMedia => ({ id: m._id, url: m.url, contentType: m.contentType, kind: m.kind, bytes: m.bytes });

export function createMediaService({ repo, store, limits = DEFAULT_LIMITS, mediaRoot, now = () => new Date() }: MediaServiceDeps) {
  function checkSize(type: MediaType, bytes: number) {
    const max = type.kind === 'image' ? limits.imageBytes : limits.videoBytes;
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > max) {
      throw new AppError('media_rejected', `${type.kind} must be 1 byte to ${max} bytes; got ${bytes}.`);
    }
  }

  function newRecord(type: MediaType, bytes: number, fileName: string | undefined, state: MediaRecord['state']): MediaRecord {
    const key = `m/${randomId()}/${safeFileName(fileName, type.ext)}`;
    return { _id: randomId(), key, url: store.publicUrl(key), state, contentType: type.mime, kind: type.kind, bytes, refs: [], createdAt: now() };
  }

  return {
    /** Step 1 of the API flow: reserve an ID and return a presigned PUT. */
    async initUpload(input: { contentType: string; bytes: number; fileName?: string }) {
      const type = byMime(input.contentType);
      if (!type) throw new AppError('media_rejected', `Unsupported type ${input.contentType}. Allowed: image/jpeg, png, gif, webp; video/mp4, quicktime.`);
      checkSize(type, input.bytes);
      const rec = newRecord(type, input.bytes, input.fileName, 'pending');
      await repo.insertMedia(rec);
      const expiresSec = 600;
      const put = await store.presignPut(rec.key, type.mime, input.bytes, expiresSec);
      return { mediaId: rec._id, upload: { method: 'PUT' as const, url: put.url, headers: put.headers, expiresAt: new Date(now().getTime() + expiresSec * 1000).toISOString() } };
    },

    /**
     * Step 2: verify what actually landed in the bucket. A presigned URL binds
     * type and size, but not content: the bytes are sniffed here, and a
     * mismatch deletes the object before anything can link to it.
     */
    async completeUpload(id: string): Promise<PublicMedia> {
      const [rec] = await repo.getMedia([id]);
      if (!rec || rec.state === 'deleted') throw new AppError('not_found', `No upload ${id}.`);
      if (rec.state === 'ready') return toPublic(rec);
      const head = await store.head(rec.key);
      if (!head) throw new AppError('media_not_ready', 'Nothing uploaded yet: PUT the file to the upload URL first.');
      const detected = sniff(await store.readHead(rec.key, SNIFF_BYTES));
      if (!detected || detected.mime !== rec.contentType || head.bytes !== rec.bytes) {
        await store.delete(rec.key);
        await repo.markMediaDeleted(rec._id, 'rejected_content', now());
        throw new AppError('media_rejected', `Uploaded file doesn't match the declared ${rec.contentType} (${head.bytes} bytes); it was deleted.`);
      }
      const ready = await repo.markMediaReady(id, head.bytes);
      return toPublic(ready ?? (await repo.getMedia([id]))[0]!);
    },

    /**
     * MCP flow: the agent names a local file. Agents can be prompt-injected,
     * and the result is a *public* URL, so this is an exfiltration path
     * unless constrained: the path must resolve (symlinks included) inside
     * MEDIA_ROOT, and the content must sniff as an allowed image/video.
     */
    async resolveLocalFile(path: string): Promise<{ path: string; type: MediaType; bytes: number; sha256: string }> {
      if (!mediaRoot) throw new AppError('invalid_input', 'Local uploads are disabled: set MEDIA_ROOT.');
      const root = await realpath(mediaRoot);
      let real: string;
      try {
        real = await realpath(isAbsolute(path) ? path : resolve(root, path));
      } catch {
        throw new AppError('not_found', `File not found: ${path}`);
      }
      const rel = relative(root, real);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new AppError('invalid_input', `Files must be inside MEDIA_ROOT (${root}).`);
      }
      const st = await stat(real);
      if (!st.isFile()) throw new AppError('invalid_input', `${path} is not a file.`);
      const fh = await open(real, 'r');
      const head = new Uint8Array(SNIFF_BYTES);
      try {
        await fh.read(head, 0, SNIFF_BYTES, 0);
      } finally {
        await fh.close();
      }
      const type = sniff(head);
      if (!type) throw new AppError('media_rejected', `${path} is not a supported image or video.`);
      checkSize(type, st.size);
      return { path: real, type, bytes: st.size, sha256: await hashFile(real) };
    },

    async uploadLocalFile(f: { path: string; type: MediaType; bytes: number }): Promise<PublicMedia> {
      const rec = newRecord(f.type, f.bytes, f.path.split('/').pop(), 'pending');
      await repo.insertMedia(rec);
      await store.put(rec.key, createReadStream(f.path), f.type.mime, f.bytes);
      const ready = await repo.markMediaReady(rec._id, f.bytes);
      return toPublic(ready!);
    },

    /** Media that can go into a post right now. */
    async requireReady(ids: string[]): Promise<MediaRecord[]> {
      const found = await repo.getMedia(ids);
      return ids.map((id) => {
        const m = found.find((x) => x._id === id);
        if (!m || m.state === 'deleted') throw new AppError('not_found', `No media ${id}.`);
        if (m.state !== 'ready') throw new AppError('media_not_ready', `Media ${id} isn't complete: call complete after uploading.`);
        return m;
      });
    },
  };
}

export type MediaService = ReturnType<typeof createMediaService>;

async function hashFile(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

