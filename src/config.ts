import { z } from 'zod';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const httpsOrLocal = (u: string) => u.startsWith('https://') || LOOPBACK.has(new URL(u).hostname);

const schema = z.object({
  BUFFER_API_KEY: z.string().trim().min(1, 'is required'),
  MONGO_URL: z.string().trim().regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// URL'),
  MONGO_DB: z.string().default('buffer_media_relay'),
  S3_BUCKET: z.string().trim().min(1, 'is required'),
  S3_REGION: z.string().default('auto'),
  /** For R2/RustFS; omit for AWS. */
  S3_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  /** Where the bucket's `m/` objects are publicly served. Buffer requires https. */
  PUBLIC_MEDIA_BASE_URL: z.url().refine(httpsOrLocal, 'must be https (Buffer fetches over https)'),
  /** HTTP API only. */
  RELAY_API_KEY: z.string().min(32, 'must be at least 32 characters').optional(),
  PORT: z.coerce.number().int().default(8787),
  /** MCP only: local files the agent may upload must be under this directory. */
  MEDIA_ROOT: z.string().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'error', 'silent']).default('info'),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
});

export type Config = z.infer<typeof schema>;

/** Every problem listed by name; values (keys, URLs with credentials) never echoed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, need: { http?: boolean; mcp?: boolean } = {}): Config {
  const r = schema.safeParse(env);
  const problems = r.success ? [] : r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  if (r.success && need.http && !r.data.RELAY_API_KEY) problems.push('  RELAY_API_KEY: is required for the HTTP API');
  if (r.success && need.mcp && !r.data.MEDIA_ROOT) problems.push('  MEDIA_ROOT: is required for the MCP server');
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.join('\n')}\nSee .env.example.`);
  return r.data!;
}
