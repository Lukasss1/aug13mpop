// ============================================================================
// MILK POP — bounded external-provider transport
//
// Edge Functions must never wait forever on third-party services. The deadline
// remains active through response-body consumption, because fetch() resolving
// only proves that headers arrived. Caller cancellation is composed rather than
// replaced, and only this helper's own deadline is reported as a timeout.
// ============================================================================

export const EXTERNAL_PROVIDER_TIMEOUT_MS = Object.freeze({
  turnstile: 8_000,
  email: 15_000,
});

export class ProviderTimeoutError extends Error {
  readonly code = 'provider_timeout';
  constructor(readonly timeoutMs: number) {
    super(`External provider did not complete within ${timeoutMs}ms.`);
    this.name = 'ProviderTimeoutError';
  }
}

export type ProviderJsonResponse<T> = {
  response: Response;
  text: string;
  data: T | null;
};

/**
 * Fetch JSON from a third-party provider under one end-to-end deadline.
 * The body is consumed here so callers cannot accidentally clear the timeout
 * after headers and then block forever while parsing.
 */
export async function fetchProviderJson<T = Record<string, unknown>>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number,
): Promise<ProviderJsonResponse<T>> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  let timedOut = false;

  const forwardParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) forwardParentAbort();
  else parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new ProviderTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const text = await response.text();
    let data: T | null = null;
    if (text) {
      try { data = JSON.parse(text) as T; }
      catch { data = null; }
    }
    return { response, text, data };
  } catch (error) {
    if (timedOut) throw new ProviderTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', forwardParentAbort);
  }
}
