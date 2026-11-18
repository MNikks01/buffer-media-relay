/**
 * Real MongoDB and S3 (RustFS). Skipped unless RUN_INTEGRATION=1:
 *
 *   docker compose up -d
 *   npm run test:integration
 */
import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, DeletePublicAccessBlockCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import { MongoClient } from 'mongodb';
import { afterAll, describe, expect, test } from 'vitest';
import { createMongoRepo } from '../../src/repo/mongo.js';
import { createMediaService } from '../../src/services/media.js';
import { createS3Store } from '../../src/storage/s3-store.js';
import { BYTES } from '../helpers.js';
import { createMemoryRepo } from '../fakes/memory-repo.js';
import { repoContract } from './repo.contract.js';

const RUN = process.env.RUN_INTEGRATION === '1';
const MONGO_URL = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const S3 = { region: 'us-east-1', endpoint: S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? 'rustfsadmin', secretAccessKey: process.env.S3_SECRET_KEY ?? 'rustfsadmin' } };

describe.skipIf(!RUN)('integration', () => {
  const mongo = new MongoClient(MONGO_URL);
  afterAll(() => mongo.close());

  repoContract('MongoDB', async () => {
    await mongo.connect();
    return createMongoRepo(mongo.db(`relay_test_${randomUUID().slice(0, 8)}`));
  });

  test('S3 (RustFS): presigned PUT, sniff on complete, anonymous public GET, delete', async () => {
    const bucket = `relay-${randomUUID().slice(0, 8)}`;
    const s3 = new S3Client(S3);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    // Some S3 servers block public policies by default; this one is meant to be public.
    await s3.send(new DeletePublicAccessBlockCommand({ Bucket: bucket })).catch(() => {});
    // Public read on m/* only: no listing.
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/m/*`] }] }),
      })
    );
    const store = createS3Store({ bucket, publicBaseUrl: `${S3_ENDPOINT}/${bucket}`, client: S3 });
    const media = createMediaService({ repo: createMemoryRepo(), store });

    const init = await media.initUpload({ contentType: 'image/png', bytes: BYTES.png.length, fileName: 'a.png' });
    const put = await fetch(init.upload.url, { method: 'PUT', headers: init.upload.headers, body: BYTES.png });
    expect(put.status).toBe(200);
    const ready = await media.completeUpload(init.mediaId);

    const pub = await fetch(ready.url, { method: 'HEAD', redirect: 'manual' });
    expect(pub.status).toBe(200);
    expect(pub.headers.get('content-type')).toBe('image/png');
    expect(pub.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${S3_ENDPOINT}/${bucket}/`)).status).toBe(403); // no listing

    // The signature binds Content-Type: uploading HTML with the same URL fails.
    const init2 = await media.initUpload({ contentType: 'image/png', bytes: BYTES.html.length });
    const bad = await fetch(init2.upload.url, { method: 'PUT', headers: { ...init2.upload.headers, 'Content-Type': 'text/html' }, body: BYTES.html });
    expect(bad.status).toBe(403);

    await store.delete(new URL(ready.url).pathname.split(`/${bucket}/`)[1]!);
    expect((await fetch(ready.url, { method: 'HEAD' })).status).toBe(404);
  });
});
