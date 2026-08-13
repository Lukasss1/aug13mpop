/**
 * Bounded browser fetch helper.
 *
 * A stalled connection must not leave a save button, upload, sign-in or till
 * action pending forever. The caller still owns the user-facing error wording;
 * this helper only turns an indefinite network wait into a normal rejected
 * promise after a conservative, operation-specific deadline.
 */
export const REQUEST_TIMEOUT_MS = Object.freeze({
  auth: 15_000,
  read: 20_000,
  action: 30_000,
  pos: 30_000,
  upload: 90_000,
});

export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Fetch with a deadline while preserving a caller-provided AbortSignal.
 *
 * The timeout is deliberately opt-out for invalid/non-positive values, which
 * keeps the helper safe in tests and old browsers. A parent abort remains a
 * normal AbortError; only this helper's own deadline becomes
 * RequestTimeoutError.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS.read,
): Promise<Response> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof AbortController === 'undefined') {
    return fetch(input, init);
  }

  const controller = new AbortController();
  const parentSignal = init.signal;
  const forwardParentAbort = (): void => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted) {
    forwardParentAbort();
  } else {
    parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });
  }

  let timedOut = false;
  let cleanedUp = false;
  let timer: ReturnType<typeof globalThis.setTimeout>;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', forwardParentAbort);
  };
  timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
    cleanup();
  }, timeoutMs);

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (response.body === null) {
      cleanup();
      return response;
    }

    // `fetch()` resolves when headers arrive, not when the body has finished.
    // Keep the same deadline alive while callers consume json/text/blob/etc.
    // The proxy preserves Response identity/properties while binding native
    // methods to the real Response object (required by Web API brand checks).
    const bodyReaders = new Set<PropertyKey>(['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text']);
    return new Proxy(response, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (bodyReaders.has(property)) {
          return async (...args: unknown[]) => {
            try {
              return await Reflect.apply(value, target, args);
            } catch (error) {
              if (timedOut) throw new RequestTimeoutError(timeoutMs);
              throw error;
            } finally {
              cleanup();
            }
          };
        }
        return value.bind(target);
      },
    }) as Response;
  } catch (error) {
    cleanup();
    if (timedOut) throw new RequestTimeoutError(timeoutMs);
    throw error;
  }
}

/** Named operation classes keep call sites readable and make timeout choices
 * reviewable without repeating numeric literals across the app. */
export const timedFetch = Object.freeze({
  auth: (input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithTimeout(input, init, REQUEST_TIMEOUT_MS.auth),
  read: (input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithTimeout(input, init, REQUEST_TIMEOUT_MS.read),
  action: (input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithTimeout(input, init, REQUEST_TIMEOUT_MS.action),
  pos: (input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithTimeout(input, init, REQUEST_TIMEOUT_MS.pos),
  upload: (input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithTimeout(input, init, REQUEST_TIMEOUT_MS.upload),
});
