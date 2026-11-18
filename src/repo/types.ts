import type { MediaRef, TrackedStatus } from '../policy.js';

export type MediaState = 'pending' | 'ready' | 'deleted';

export type MediaRecord = {
  _id: string;
  key: string;
  url: string;
  state: MediaState;
  contentType: string;
  kind: 'image' | 'video';
  bytes: number;
  /** Each request that used this file; postId is set once Buffer confirms. */
  refs: MediaRef[];
  createdAt: Date;
  deletedAt?: Date;
  deleteReason?: string;
};

export type RequestState = 'in_progress' | 'succeeded' | 'failed' | 'outcome_unknown';

/** One per idempotency key. */
export type PostRequest = {
  _id: string;
  requestHash: string;
  state: RequestState;
  /** In-progress requests hold a lease; an expired lease means the process died mid-call. */
  leaseUntil: Date;
  mediaIds: string[];
  response?: Record<string, unknown>;
  error?: { code: string; message: string };
  createdAt: Date;
  updatedAt: Date;
};

export type TrackedPost = {
  _id: string; // Buffer post id
  status: TrackedStatus;
  dueAt?: Date;
  mediaIds: string[];
  checks: number;
  nextCheckAt: Date | null;
  leaseUntil: Date;
  terminalAt?: Date;
};

export type BeginResult = { kind: 'started' } | { kind: 'existing'; request: PostRequest };

/**
 * Persistence, expressed as the operations the service needs rather than as
 * a generic CRUD layer. Each method is atomic in the MongoDB implementation;
 * the contract tests (test/contract) hold every implementation to the same
 * behavior.
 */
export interface Repo {
  insertMedia(m: MediaRecord): Promise<void>;
  getMedia(ids: string[]): Promise<MediaRecord[]>;
  /** pending → ready, only once. Returns null if it wasn't pending. */
  markMediaReady(id: string, bytes: number): Promise<MediaRecord | null>;
  addMediaRef(ids: string[], requestKey: string): Promise<void>;
  setMediaRefPost(ids: string[], requestKey: string, postId: string): Promise<void>;
  removeMediaRef(ids: string[], requestKey: string): Promise<void>;
  markMediaDeleted(id: string, reason: string, now: Date): Promise<void>;
  /** Ready media, oldest first, for the sweeper. */
  listReadyMedia(limit: number, afterId?: string): Promise<MediaRecord[]>;

  /**
   * Insert an in_progress request, or return the existing one. An existing
   * in_progress request whose lease expired is converted to outcome_unknown
   * first: the process that owned it died, maybe after Buffer accepted.
   */
  beginRequest(key: string, requestHash: string, mediaIds: string[], leaseMs: number, now: Date): Promise<BeginResult>;
  getRequest(key: string): Promise<PostRequest | null>;
  finishRequest(key: string, patch: Pick<PostRequest, 'state'> & Partial<Pick<PostRequest, 'response' | 'error'>>, now: Date): Promise<void>;
  /** Forget a request that provably didn't reach Buffer (e.g. rate limited), so the key can be retried. */
  deleteRequest(key: string): Promise<void>;

  trackPost(p: TrackedPost): Promise<void>;
  /** Claims up to `limit` due posts with a lease, so parallel workers don't double-check. */
  claimDuePosts(now: Date, limit: number, leaseMs: number): Promise<TrackedPost[]>;
  updatePost(id: string, patch: Partial<Pick<TrackedPost, 'status' | 'checks' | 'nextCheckAt' | 'terminalAt' | 'dueAt'>>, now: Date): Promise<void>;
  getPosts(ids: string[]): Promise<TrackedPost[]>;
}
