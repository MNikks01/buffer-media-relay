#!/usr/bin/env node
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { every, wire } from '../wiring.js';

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, { service: 'buffer-media-relay', role: 'worker' });
const app = await wire(config, log);

const loop = every(config.WORKER_INTERVAL_MS, async () => {
  try {
    const checked = await app.cleanup.checkPosts();
    const swept = await app.cleanup.sweepMedia();
    if (checked.checked || swept.deleted) log({ level: 'info', event: 'worker_run', ...checked, ...swept });
  } catch (e) {
    log({ level: 'error', event: 'worker_run_failed', detail: String((e as Error)?.stack ?? e) });
  }
});
log({ level: 'info', event: 'started', interval_ms: config.WORKER_INTERVAL_MS });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await loop.stop(); // finish the current run: never stop between a delete and its record
    await app.close();
    log({ level: 'info', event: 'stopped', reason: sig });
    process.exit(0);
  });
}
