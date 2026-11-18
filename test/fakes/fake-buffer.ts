import type { PostStatus } from '../../src/policy.js';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'network_error';

/**
 * Fake Buffer GraphQL API as an injectable fetch. Understands the four
 * operations the client sends (createPost, aliased post lookups, account,
 * channels) and keeps a post table the test can mutate ("Buffer published
 * it"). `nextCreate` scripts failures for the next createPost calls.
 */
export function createFakeBuffer() {
  const posts = new Map<string, { id: string; status: PostStatus; dueAt: string | null; sentAt: string | null; input: any }>();
  const calls: Array<{ op: string; variables: any }> = [];
  const createScript: Reply[] = [];
  let lookupScript: Reply[] = [];
  let seq = 0;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    const op = query.includes('createPost') ? 'createPost' : query.includes('post(input') ? 'getPosts' : query.includes('account') ? 'account' : 'channels';
    calls.push({ op, variables });

    const scripted = op === 'createPost' ? createScript.shift() : op === 'getPosts' ? lookupScript.shift() : undefined;
    if (scripted === 'network_error') throw new TypeError('fetch failed');
    if (scripted) return json(scripted.status, scripted.body ?? {}, scripted.headers);

    if (op === 'createPost') {
      const input = variables.input;
      if (input.text === 'REJECT') return json(200, { data: { createPost: { __typename: 'MutationError', message: 'Text is invalid' } } });
      const id = `post${++seq}`;
      const status: PostStatus = input.mode === 'shareNow' ? 'sending' : 'scheduled';
      const dueAt = input.dueAt ?? (input.mode === 'shareNow' ? null : new Date(Date.UTC(2026, 10, 19, 9)).toISOString());
      posts.set(id, { id, status, dueAt, sentAt: null, input });
      return json(200, { data: { createPost: { __typename: 'PostActionSuccess', post: { id, status, dueAt, sentAt: null } } } }, { ratelimit: '"15m";r=149;t=900' });
    }
    if (op === 'getPosts') {
      const data: Record<string, unknown> = {};
      const errors: unknown[] = [];
      for (const [k, id] of Object.entries(variables as Record<string, string>)) {
        const alias = `p${k.slice(2)}`;
        const p = posts.get(id);
        if (p) data[alias] = { id: p.id, status: p.status, dueAt: p.dueAt, sentAt: p.sentAt };
        else errors.push({ message: 'Post not found', path: [alias], extensions: { code: 'NOT_FOUND' } });
      }
      // Post! is non-null: one missing post nulls the whole data object.
      return json(200, errors.length ? { data: null, errors } : { data });
    }
    if (op === 'account') return json(200, { data: { account: { organizations: [{ id: 'org1' }] } } });
    return json(200, { data: { channels: [{ id: 'ch1', name: 'Acme on LinkedIn', service: 'linkedin' }] } });
  }) as unknown as typeof fetch;

  return {
    fetch: fetchImpl,
    posts,
    calls,
    creates: () => calls.filter((c) => c.op === 'createPost'),
    nextCreate: (...r: Reply[]) => createScript.push(...r),
    nextLookups: (...r: Reply[]) => (lookupScript = r),
    publish(id: string, status: PostStatus = 'sent') {
      const p = posts.get(id)!;
      p.status = status;
      if (status === 'sent') p.sentAt = new Date().toISOString();
    },
    deleteInBuffer: (id: string) => posts.delete(id),
  };
}

export type FakeBuffer = ReturnType<typeof createFakeBuffer>;
