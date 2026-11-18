import { AppError } from '../errors.js';
import type { PostStatus } from '../policy.js';

/**
 * Buffer GraphQL API (https://api.buffer.com).
 *
 * Retry rules, same as any write without idempotency keys:
 * - 429: retried (Buffer: "Rejected requests do not consume quota"), honoring
 *   Retry-After.
 * - Network errors and 5xx: retried for queries only. For createPost the
 *   outcome is unknown, so it surfaces as `outcome_unknown`, never a blind
 *   retry that could double-post.
 * - A `MutationError` in the result union is definitive: nothing was created.
 */

export type ShareMode = 'addToQueue' | 'customScheduled' | 'shareNext' | 'shareNow';
export type AssetInput =
  | { image: { url: string; metadata?: { altText: string } } }
  | { video: { url: string } };

export type CreatePostInput = {
  channelId: string;
  text: string;
  mode: ShareMode;
  dueAt?: string;
  assets: AssetInput[];
};

export type BufferPost = { id: string; status: PostStatus; dueAt?: string | null; sentAt?: string | null };
export type PostLookup = BufferPost | { id: string; notFound: true };

export type BufferClientOptions = {
  apiKey: string;
  endpoint?: string;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  onRateLimit?: (remaining: number | undefined, policy: string | null) => void;
};

type GqlError = { message: string; path?: (string | number)[]; extensions?: { code?: string } };
type GqlResponse<T> = { data?: T | null; errors?: GqlError[] };

const POST_FIELDS = 'id status dueAt sentAt';
/** Buffer allows 30 aliases per query; leave headroom. */
export const STATUS_BATCH = 25;

const sleepReal = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createBufferClient(o: BufferClientOptions) {
  const endpoint = o.endpoint ?? 'https://api.buffer.com';
  const maxRetries = o.maxRetries ?? 3;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? sleepReal;

  async function gql<T>(query: string, variables: Record<string, unknown>, isMutation: boolean): Promise<GqlResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${o.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        if (!isMutation && attempt < maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw isMutation
          ? new AppError('outcome_unknown', `No response from Buffer (${(e as Error).message}). The post may or may not have been created: check Buffer before retrying.`)
          : new AppError('upstream_unavailable', `Buffer unreachable: ${(e as Error).message}`);
      }

      const limit = res.headers.get('ratelimit');
      if (limit) o.onRateLimit?.(minRemaining(limit), res.headers.get('ratelimit-policy'));

      if (res.status === 429) {
        await res.body?.cancel();
        const wait = Math.min(60_000, Number(res.headers.get('retry-after') ?? 1) * 1000);
        if (attempt < maxRetries) {
          await sleep(wait);
          continue;
        }
        throw new AppError('rate_limited', 'Buffer rate limit reached.', { retryAfterMs: wait });
      }
      if (res.status === 401) {
        await res.body?.cancel();
        throw new AppError('unauthorized', 'Buffer rejected the API key (401). Create a new key in Buffer → Settings → API.');
      }
      if (res.status >= 500) {
        await res.body?.cancel();
        if (!isMutation && attempt < maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw isMutation
          ? new AppError('outcome_unknown', `Buffer returned ${res.status}. The post may or may not have been created: check Buffer before retrying.`)
          : new AppError('upstream_unavailable', `Buffer returned ${res.status}.`);
      }
      const body = (await res.json().catch(() => ({}))) as GqlResponse<T>;
      if (!res.ok && !body.errors) {
        throw new AppError('buffer_rejected', `Buffer returned ${res.status}.`);
      }
      return body;
    }
  }

  return {
    async createPost(input: CreatePostInput): Promise<BufferPost> {
      const query = `mutation CreatePost($input: CreatePostInput!) {
        createPost(input: $input) {
          __typename
          ... on PostActionSuccess { post { ${POST_FIELDS} } }
          ... on MutationError { message }
        }
      }`;
      const vars = {
        input: {
          channelId: input.channelId,
          text: input.text,
          schedulingType: 'automatic',
          mode: input.mode,
          assets: input.assets,
          ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        },
      };
      const r = await gql<{ createPost: { __typename: string; post?: BufferPost; message?: string } }>(query, vars, true);
      const out = r.data?.createPost;
      if (out?.__typename === 'PostActionSuccess' && out.post) return out.post;
      if (out?.message) throw new AppError('buffer_rejected', `Buffer rejected the post: ${out.message}`);
      // Top-level GraphQL errors (validation) mean the mutation didn't execute.
      const msg = r.errors?.map((e) => e.message).join('; ') || 'unexpected response';
      throw new AppError('buffer_rejected', `Buffer rejected the request: ${msg}`);
    },

    /**
     * Status of up to STATUS_BATCH posts in one request, using aliases.
     * `post` returns Post! (non-null): one deleted post nulls the whole
     * `data`, so on that failure each post is fetched on its own.
     */
    async getPosts(ids: string[]): Promise<PostLookup[]> {
      if (ids.length === 0) return [];
      if (ids.length > STATUS_BATCH) throw new Error(`getPosts: max ${STATUS_BATCH} ids`);
      const query = `query Posts(${ids.map((_, i) => `$id${i}: PostId!`).join(', ')}) {
        ${ids.map((_, i) => `p${i}: post(input: { id: $id${i} }) { ${POST_FIELDS} }`).join('\n')}
      }`;
      const vars = Object.fromEntries(ids.map((id, i) => [`id${i}`, id]));
      const r = await gql<Record<string, BufferPost | null>>(query, vars, false);
      if (r.data) {
        return ids.map((id, i) => r.data![`p${i}`] ?? lookupError(id, r.errors, `p${i}`));
      }
      if (ids.length === 1) return [lookupError(ids[0]!, r.errors, 'p0')];
      const each = [];
      for (const id of ids) each.push(...(await this.getPosts([id])));
      return each;
    },

    async listChannels(): Promise<Array<{ id: string; name: string; service: string }>> {
      const acc = await gql<{ account: { organizations: Array<{ id: string }> } }>(
        'query { account { organizations { id } } }',
        {},
        false
      );
      throwIfNoData(acc);
      const out = [];
      for (const org of acc.data!.account.organizations) {
        const r = await gql<{ channels: Array<{ id: string; name: string; service: string }> }>(
          'query Channels($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name service } }',
          { org: org.id },
          false
        );
        throwIfNoData(r);
        out.push(...r.data!.channels);
      }
      return out;
    },
  };
}

export type BufferClient = ReturnType<typeof createBufferClient>;

function lookupError(id: string, errors: GqlError[] | undefined, alias: string): PostLookup {
  const e = errors?.find((x) => x.path?.[0] === alias) ?? errors?.[0];
  if (e && (e.extensions?.code === 'NOT_FOUND' || /not found/i.test(e.message))) return { id, notFound: true };
  throw new AppError('upstream_unavailable', `Buffer post lookup failed: ${e?.message ?? 'no data'}`);
}

function throwIfNoData(r: GqlResponse<unknown>) {
  if (!r.data) throw new AppError('upstream_unavailable', `Buffer query failed: ${r.errors?.map((e) => e.message).join('; ')}`);
}

/** RateLimit: "15m";r=149;t=900, "24h";r=599;t=86400 → smallest r. */
function minRemaining(header: string): number | undefined {
  const rs = [...header.matchAll(/r=(\d+)/g)].map((m) => Number(m[1]));
  return rs.length ? Math.min(...rs) : undefined;
}
