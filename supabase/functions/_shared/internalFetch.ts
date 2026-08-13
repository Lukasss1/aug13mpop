// Bounded transport for Supabase-internal Auth, REST and Storage calls.
// Edge Functions should fail explicitly instead of waiting for the platform's
// outer execution timeout, which leaves staff unsure whether an action ran.
export const INTERNAL_FETCH_TIMEOUT_MS = 10_000;

export async function fetchInternal(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = INTERNAL_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  const forwardParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) forwardParentAbort();
  else parentSignal?.addEventListener('abort', forwardParentAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', forwardParentAbort);
  }
}
