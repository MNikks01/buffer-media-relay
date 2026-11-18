import type { Readable } from 'node:stream';

/**
 * Where files live. The service depends on this interface only; S3 (or any
 * S3-compatible store: R2, MinIO) is one implementation, an in-memory map is
 * another for tests.
 */
export interface ObjectStore {
  /** A URL the client PUTs the file to directly, bound to type and size. */
  presignPut(key: string, contentType: string, bytes: number, expiresSec: number): Promise<{ url: string; headers: Record<string, string> }>;
  head(key: string): Promise<{ bytes: number } | null>;
  /** First `n` bytes, for content sniffing. */
  readHead(key: string, n: number): Promise<Uint8Array>;
  put(key: string, body: Readable | Uint8Array, contentType: string, bytes: number): Promise<void>;
  /** Idempotent: deleting a missing key succeeds. */
  delete(key: string): Promise<void>;
  /** The permanent public URL Buffer will fetch. */
  publicUrl(key: string): string;
}
