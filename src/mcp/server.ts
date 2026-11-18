import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BufferClient } from '../buffer/client.js';
import { AppError, RETRYABLE } from '../errors.js';
import { canonicalJson, sha256 } from '../ids.js';
import type { Logger } from '../logger.js';
import type { MediaService } from '../services/media.js';
import type { CreatePostResult, PostsService } from '../services/posts.js';

const isoWithOffset = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, 'ISO 8601 with a timezone offset, e.g. 2026-11-20T09:00:00+05:30');

const uploadInput = {
  file_paths: z
    .array(z.string().min(1).max(1024))
    .min(1)
    .max(10)
    .describe('Local image/video files, in post order. Must be inside the configured media folder.'),
  channel_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe('Buffer channel ID (from buffer_list_channels), not a name.'),
  text: z.string().min(1).max(10_000).describe('Post text.'),
  mode: z
    .enum(['addToQueue', 'customScheduled', 'shareNext', 'shareNow'])
    .describe('addToQueue: next free slot. customScheduled: at due_at. shareNext: top of queue. shareNow: immediately.'),
  due_at: isoWithOffset.optional().describe("Only for customScheduled. Resolve relative times in the user's timezone."),
  alt_texts: z.array(z.string().min(1).max(1000)).max(10).optional().describe('Alt text per image, same order as file_paths.'),
};

const uploadOutput = {
  post_id: z.string(),
  status: z.string(),
  due_at: z.string().nullable(),
  media: z.array(z.object({ id: z.string(), url: z.string() })),
  deduplicated: z.boolean().describe('True if an identical call already created this post; nothing new was created.'),
};

const ok = (out: Record<string, unknown>): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
const fail = (e: unknown, log: Logger, tool: string): CallToolResult => {
  const err = e instanceof AppError ? e : new AppError('internal', 'Internal error. See server logs.');
  if (!(e instanceof AppError)) log({ level: 'error', event: 'tool_internal_error', tool, detail: String((e as Error)?.stack ?? e) });
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: err.code, message: err.message, retryable: RETRYABLE.has(err.code) } }) }] };
};

export function createMcpServer(deps: { media: MediaService; posts: PostsService; buffer: BufferClient; log: Logger }) {
  const server = new McpServer({ name: 'buffer-media-relay', version: '0.1.0' });

  server.registerTool(
    'buffer_upload_and_schedule',
    {
      title: 'Upload media and create a Buffer post',
      description:
        "Create a Buffer post with images or a video from the user's computer. Buffer's API only accepts public URLs, so this uploads " +
        'the files, keeps them online until the post is published, then deletes them. ' +
        'Side effect: creates a real post on the channel (shareNow publishes immediately). Not for text-only posts.',
      inputSchema: uploadInput,
      outputSchema: uploadOutput,
      annotations: { title: 'Upload media and create a Buffer post', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      const started = Date.now();
      try {
        if (a.alt_texts && a.alt_texts.length > a.file_paths.length) throw new AppError('invalid_input', 'More alt texts than files.');
        // Resolve and hash files before uploading anything: an identical
        // repeat call (agents retry) is answered from the stored result
        // without re-uploading.
        const files = await Promise.all(a.file_paths.map((p) => deps.media.resolveLocalFile(p)));
        const key =
          'mcp:' +
          sha256(canonicalJson({ c: a.channel_id, t: a.text, m: a.mode, d: a.due_at ?? null, f: files.map((f) => f.sha256), alt: a.alt_texts ?? [] }));
        const fingerprint = sha256(key);
        let result: CreatePostResult | null = await deps.posts.peek(key, fingerprint);
        if (!result) {
          const uploaded = [];
          for (const f of files) uploaded.push(await deps.media.uploadLocalFile(f));
          // The MCP key covers file contents, not upload IDs (new on each
          // upload), so the request hash is fixed to the key itself.
          result = await deps.posts.create(
            {
              channelId: a.channel_id,
              text: a.text,
              mode: a.mode,
              dueAt: a.due_at,
              media: uploaded.map((m, i) => ({ id: m.id, ...(a.alt_texts?.[i] && m.kind === 'image' ? { altText: a.alt_texts[i] } : {}) })),
            },
            key,
            fingerprint
          );
        }
        deps.log({ level: 'info', event: 'tool_call', tool: 'buffer_upload_and_schedule', outcome: 'ok', deduplicated: result.replayed, duration_ms: Date.now() - started });
        return ok({ post_id: result.postId, status: result.status, due_at: result.dueAt, media: result.media, deduplicated: result.replayed });
      } catch (e) {
        deps.log({ level: 'error', event: 'tool_call', tool: 'buffer_upload_and_schedule', outcome: 'error', error_code: e instanceof AppError ? e.code : 'internal', duration_ms: Date.now() - started });
        return fail(e, deps.log, 'buffer_upload_and_schedule');
      }
    }
  );

  server.registerTool(
    'buffer_list_channels',
    {
      title: 'List Buffer channels',
      description: 'List connected Buffer channels (id, name, network). Read-only. Use it to find the channel_id for buffer_upload_and_schedule.',
      inputSchema: {},
      outputSchema: { channels: z.array(z.object({ id: z.string(), name: z.string(), service: z.string() })) },
      annotations: { title: 'List Buffer channels', readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok({ channels: await deps.buffer.listChannels() });
      } catch (e) {
        return fail(e, deps.log, 'buffer_list_channels');
      }
    }
  );

  return server;
}
