/**
 * One error type for the whole service. Transport layers (HTTP, MCP) map
 * `code` to a status or a tool error; services never know which one they're
 * behind.
 */
export type ErrorCode =
  | 'invalid_input'
  | 'unauthorized'
  | 'not_found'
  | 'media_rejected' // file isn't an allowlisted image/video, or too big
  | 'media_not_ready' // upload not completed
  | 'media_unreachable' // our public URL failed the pre-flight check
  | 'idempotency_key_reused' // same key, different request body
  | 'request_in_progress' // same key, first request still running
  | 'buffer_rejected' // Buffer returned a MutationError: definitive, nothing created
  | 'outcome_unknown' // createPost may or may not have happened: verify, don't retry blindly
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'internal';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_input: 400,
  unauthorized: 401,
  not_found: 404,
  media_rejected: 422,
  media_not_ready: 409,
  media_unreachable: 502,
  idempotency_key_reused: 422,
  request_in_progress: 409,
  buffer_rejected: 422,
  outcome_unknown: 502,
  rate_limited: 429,
  upstream_unavailable: 503,
  internal: 500,
};

export const RETRYABLE: ReadonlySet<ErrorCode> = new Set(['rate_limited', 'upstream_unavailable', 'request_in_progress']);
