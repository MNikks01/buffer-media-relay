import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { ObjectStore } from './object-store.js';

export type S3StoreOptions = {
  bucket: string;
  /** e.g. https://media.example.com or https://pub-xxxx.r2.dev — no trailing slash. */
  publicBaseUrl: string;
  client?: S3ClientConfig;
};

/**
 * Objects are immutable and their keys unguessable (128 random bits), so they
 * are cached forever. The bucket must allow anonymous GetObject on the `m/`
 * prefix and nothing else (no listing): see README.
 */
export function createS3Store(o: S3StoreOptions): ObjectStore {
  const s3 = new S3Client(o.client ?? {});
  const base = o.publicBaseUrl.replace(/\/$/, '');
  const cacheControl = 'public, max-age=31536000, immutable';

  return {
    async presignPut(key, contentType, bytes, expiresSec) {
      const cmd = new PutObjectCommand({
        Bucket: o.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: bytes,
        CacheControl: cacheControl,
      });
      // Content-Type and Content-Length are signed: a client can't upload a
      // different type or size with this URL.
      const url = await getSignedUrl(s3, cmd, { expiresIn: expiresSec, signableHeaders: new Set(['content-type', 'content-length']) });
      return { url, headers: { 'Content-Type': contentType, 'Content-Length': String(bytes), 'Cache-Control': cacheControl } };
    },

    async head(key) {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: o.bucket, Key: key }));
        return { bytes: r.ContentLength ?? 0 };
      } catch (e) {
        if ((e as { name?: string }).name === 'NotFound' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },

    async readHead(key, n) {
      const r = await s3.send(new GetObjectCommand({ Bucket: o.bucket, Key: key, Range: `bytes=0-${n - 1}` }));
      return (await r.Body?.transformToByteArray()) ?? new Uint8Array();
    },

    async put(key, body, contentType, bytes) {
      await new Upload({
        client: s3,
        params: { Bucket: o.bucket, Key: key, Body: body as Readable, ContentType: contentType, ContentLength: bytes, CacheControl: cacheControl },
      }).done();
    },

    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: key }));
    },

    publicUrl: (key) => `${base}/${key}`,
  };
}
