#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { loadConfig } from '../config.js';
import { createApp } from '../http/app.js';
import { createLogger } from '../logger.js';
import { wire } from '../wiring.js';

const config = loadConfig(process.env, { http: true });
const log = createLogger(config.LOG_LEVEL, { service: 'buffer-media-relay', role: 'http' });
const app = await wire(config, log);

const server = serve({ fetch: createApp({ media: app.media, posts: app.posts, apiKey: config.RELAY_API_KEY!, log }).fetch, port: config.PORT }, (info) =>
  log({ level: 'info', event: 'started', port: info.port })
);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // Stop accepting, let in-flight requests (possibly mid-createPost) finish.
    server.close(async () => {
      await app.close();
      log({ level: 'info', event: 'stopped', reason: sig });
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 30_000).unref();
  });
}
