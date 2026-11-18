import type { Readable } from 'node:stream';
import type { ObjectStore } from '../../src/storage/object-store.js';

export function createMemoryStore(base = 'https://media.test') {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const store: ObjectStore & { objects: typeof objects; clientPut(key: string, body: Uint8Array, contentType: string): void } = {
    objects,
    /** Simulates the client uploading to the presigned URL. */
    clientPut(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
    async presignPut(key, contentType, bytes) {
      return { url: `https://s3.test/${key}?signed=1`, headers: { 'Content-Type': contentType, 'Content-Length': String(bytes) } };
    },
    head: async (key) => (objects.has(key) ? { bytes: objects.get(key)!.body.length } : null),
    readHead: async (key, n) => objects.get(key)?.body.slice(0, n) ?? new Uint8Array(),
    async put(key, body, contentType) {
      let bytes: Uint8Array;
      if (body instanceof Uint8Array) bytes = body;
      else {
        const chunks: Buffer[] = [];
        for await (const c of body as Readable) chunks.push(Buffer.from(c));
        bytes = Buffer.concat(chunks);
      }
      objects.set(key, { body: bytes, contentType });
    },
    async delete(key) {
      objects.delete(key);
    },
    publicUrl: (key) => `${base}/${key}`,
  };
  return store;
}
