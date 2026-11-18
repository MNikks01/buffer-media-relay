#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createMcpServer } from '../mcp/server.js';
import { wire } from '../wiring.js';

let config;
try {
  config = loadConfig(process.env, { mcp: true });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const log = createLogger(config.LOG_LEVEL, { service: 'buffer-media-relay', role: 'mcp' });
const app = await wire(config, log);
const server = createMcpServer({ media: app.media, posts: app.posts, buffer: app.buffer, log });
await server.connect(new StdioServerTransport());
log({ level: 'info', event: 'started', media_root: config.MEDIA_ROOT });

// The worker deletes files; it runs as its own process (npm run worker) so a
// closed laptop lid doesn't stop cleanup. See README.
const stop = async (reason: string) => {
  await server.close().catch(() => {});
  await app.close();
  log({ level: 'info', event: 'stopped', reason });
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
process.stdin.on('end', () => void stop('stdin closed'));
