import { MongoClient } from 'mongodb';
import { createBufferClient } from './buffer/client.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { createMongoRepo } from './repo/mongo.js';
import { createCleanupService } from './services/cleanup.js';
import { createMediaService } from './services/media.js';
import { createPostsService } from './services/posts.js';
import { createS3Store } from './storage/s3-store.js';

/** Builds every service from config. Entry points pick what they expose. */
export async function wire(config: Config, log: Logger) {
  const mongo = new MongoClient(config.MONGO_URL, { serverSelectionTimeoutMS: 10_000 });
  await mongo.connect();
  const repo = await createMongoRepo(mongo.db(config.MONGO_DB));
  const store = createS3Store({
    bucket: config.S3_BUCKET,
    publicBaseUrl: config.PUBLIC_MEDIA_BASE_URL,
    client: {
      region: config.S3_REGION,
      ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
      forcePathStyle: config.S3_FORCE_PATH_STYLE === 'true',
    },
  });
  const buffer = createBufferClient({
    apiKey: config.BUFFER_API_KEY,
    onRateLimit: (remaining) => {
      if (remaining !== undefined && remaining < 20) log({ level: 'warn', event: 'buffer_rate_limit_low', remaining });
    },
  });
  const media = createMediaService({ repo, store, mediaRoot: config.MEDIA_ROOT });
  const posts = createPostsService({ repo, media, buffer });
  const cleanup = createCleanupService({ repo, store, buffer, log: (e) => log({ level: 'info', event: 'cleanup', ...e }) });
  return { repo, store, buffer, media, posts, cleanup, close: () => mongo.close() };
}

/** Runs `fn` every `ms`, never overlapping; resolves `stop()` after the current run. */
export function every(ms: number, fn: () => Promise<void>) {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = () => {
    running = fn().finally(() => {
      running = undefined;
      if (!stopped) timer = setTimeout(tick, ms);
    });
  };
  tick();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
