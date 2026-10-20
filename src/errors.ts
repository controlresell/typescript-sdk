/** An error answered by the API, read from its envelope `{"error": {code, message, params, requestId}}`. */
export class ControlResellError extends Error {
  /**
   * @param status The HTTP status.
   * @param code The error's code (`item_not_found`, `rate_limited`…): an open string, match the ones you handle.
   * @param params The error's parameters.
   * @param requestId The identifier to give the support.
   */
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly params: Record<string, string>,
    readonly requestId: string | undefined,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 400: the request is malformed. */
export class BadRequestError extends ControlResellError {}
/** 401: no credential, or an unknown, revoked or expired one. */
export class AuthenticationError extends ControlResellError {}
/** 402: the seller's plan does not include this. */
export class PaymentRequiredError extends ControlResellError {}
/** 403: the API key does not grant the scope the route requires. */
export class PermissionDeniedError extends ControlResellError {}
/** 404: no such resource for this seller. */
export class NotFoundError extends ControlResellError {}
/** 409: an `Idempotency-Key` used with another request, or still in flight. */
export class ConflictError extends ControlResellError {}
/** 422: the request is well formed but refused. */
export class UnprocessableEntityError extends ControlResellError {}
/** 429: the rate limit of the API key is reached. */
export class RateLimitError extends ControlResellError {
  /** The `Retry-After` the API answered, in seconds, when it did. */
  retryAfter: number | undefined;
}
/** 5xx: an error of the API; retry later. */
export class ServerError extends ControlResellError {}

/** The API could not be reached (network, DNS, TLS), after the retries. */
export class ConnectionError extends Error {
  constructor(readonly cause: unknown) {
    super(`Could not reach the ControlResell API: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ConnectionError';
  }
}

/** The typed error of [response], its body [body] being the API's envelope (or anything else). */
export function errorOf(response: Response, body: unknown): ControlResellError {
  const envelope = (body as { error?: { code?: unknown; message?: unknown; params?: unknown; requestId?: unknown } } | undefined)?.error;
  const status = response.status;
  const code = typeof envelope?.code === 'string' ? envelope.code : `http_${status}`;
  const message = typeof envelope?.message === 'string' ? envelope.message : `HTTP ${status}`;
  const params = (envelope?.params && typeof envelope.params === 'object' ? envelope.params : {}) as Record<string, string>;
  const requestId = typeof envelope?.requestId === 'string' ? envelope.requestId : undefined;
  const args = [message, status, code, params, requestId] as const;
  switch (status) {
    case 400: return new BadRequestError(...args);
    case 401: return new AuthenticationError(...args);
    case 402: return new PaymentRequiredError(...args);
    case 403: return new PermissionDeniedError(...args);
    case 404: return new NotFoundError(...args);
    case 409: return new ConflictError(...args);
    case 422: return new UnprocessableEntityError(...args);
    case 429: {
      const error = new RateLimitError(...args);
      const retryAfter = Number(response.headers.get('Retry-After'));
      error.retryAfter = Number.isFinite(retryAfter) && response.headers.has('Retry-After') ? retryAfter : undefined;
      return error;
    }
    default: return status >= 500 ? new ServerError(...args) : new ControlResellError(...args);
  }
}
