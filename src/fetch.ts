import { ConnectionError } from './errors.js';

/** The header that makes a `POST` safe to retry: the API replays the first answer to the same key. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** How a call is retried. */
export interface RetryPolicy {
  /** Retries after the first attempt (2 by default); 0 turns them off. */
  maxRetries?: number;
  /** The first delay, doubled at each retry, with a random part; a `Retry-After` takes precedence. */
  baseDelayMs?: number;
  /** The longest delay between two attempts. */
  maxDelayMs?: number;
}

/** A rate limit, a gateway or availability error. A 500 is never retried; a 409 only for a key still in flight. */
const RETRIED_STATUSES = new Set([429, 502, 503, 504]);

/** The code of the 409 answered while the first request with the same `Idempotency-Key` is still running. */
const IDEMPOTENCY_IN_PROGRESS = 'idempotency_in_progress';

async function shouldRetry(response: Response): Promise<boolean> {
  if (RETRIED_STATUSES.has(response.status)) return true;
  if (response.status !== 409) return false;
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } };
    return body?.error?.code === IDEMPOTENCY_IN_PROGRESS;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A `fetch` that gives each `POST` an `Idempotency-Key` (kept across its retries) and retries the statuses above and
 * network errors, waiting `Retry-After` when the API sends it.
 */
export function retryingFetch(base: typeof fetch, policy: RetryPolicy = {}): (request: Request) => Promise<Response> {
  const maxRetries = policy.maxRetries ?? 2;
  const baseDelayMs = policy.baseDelayMs ?? 500;
  const maxDelayMs = policy.maxDelayMs ?? 30_000;
  return async (input: Request) => {
    let request = input;
    if (request.method === 'POST' && !request.headers.has(IDEMPOTENCY_KEY_HEADER)) {
      const headers = new Headers(request.headers);
      headers.set(IDEMPOTENCY_KEY_HEADER, crypto.randomUUID());
      request = new Request(request, { headers });
    }
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= maxRetries;
      let response: Response;
      try {
        response = await base(request.clone());
      } catch (cause) {
        if (last) throw new ConnectionError(cause);
        await sleep(backoff(attempt, baseDelayMs, maxDelayMs));
        continue;
      }
      if (last || !(await shouldRetry(response))) return response;
      const retryAfter = Number(response.headers.get('Retry-After'));
      await sleep(response.headers.has('Retry-After') && Number.isFinite(retryAfter)
        ? Math.min(retryAfter * 1000, maxDelayMs)
        : backoff(attempt, baseDelayMs, maxDelayMs));
    }
  };
}

function backoff(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attempt + Math.random() * (baseDelayMs / 2), maxDelayMs);
}
