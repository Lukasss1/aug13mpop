import { strict as assert } from 'node:assert';
import { fetchWithTimeout, RequestTimeoutError } from '../src/lib/requestTimeout';

const originalFetch = globalThis.fetch;

async function run(): Promise<void> {
  try {
    globalThis.fetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
    const immediate = await fetchWithTimeout('https://example.test/ok', {}, 50);
    assert.equal(immediate.status, 200, 'an immediate response must pass through');

    let abortsAfterCompleteBody = 0;
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => { abortsAfterCompleteBody += 1; }, { once: true });
      return Promise.resolve(new Response('complete', { status: 200 }));
    }) as typeof fetch;
    const complete = await fetchWithTimeout('https://example.test/complete-body', {}, 25);
    assert.equal(await complete.text(), 'complete', 'a complete response body must pass through');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(abortsAfterCompleteBody, 0, 'successful body consumption must clear the deadline');

    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as typeof fetch;
    const started = Date.now();
    await assert.rejects(
      fetchWithTimeout('https://example.test/stall', {}, 25),
      (error: unknown) => error instanceof RequestTimeoutError && error.timeoutMs === 25,
      'a stalled request must reject with the typed timeout error',
    );
    assert.ok(Date.now() - started < 1_000, 'the timeout must settle promptly');

    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    const headersOnly = await fetchWithTimeout('https://example.test/stalled-body', {}, 25);
    await assert.rejects(
      headersOnly.text(),
      (error: unknown) => error instanceof RequestTimeoutError && error.timeoutMs === 25,
      'the deadline must remain active while the response body is consumed',
    );

    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as typeof fetch;
    const parent = new AbortController();
    const parentRequest = fetchWithTimeout('https://example.test/parent-abort', { signal: parent.signal }, 500);
    parent.abort('caller cancelled');
    await assert.rejects(
      parentRequest,
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
      'a caller abort must remain an AbortError rather than being mislabeled as a timeout',
    );

    console.log('REQUEST TIMEOUT BEHAVIOUR — 5/5 passed');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await run();
