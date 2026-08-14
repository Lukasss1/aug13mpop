// ============================================================================
// MILK POP — bounded request parsing shared by every Edge Function.
//
// Request.formData()/json() can consume an unbounded body before application
// validation runs. These helpers read at most maxBytes, reject malformed or
// unexpected content types, and only then parse the buffered body.
// ============================================================================

export class RequestBodyError extends Error {
  readonly code: 'invalid_body' | 'request_too_large' | 'unsupported_media_type';
  constructor(readonly status: 400 | 413 | 415, message: string, code?: RequestBodyError['code']) {
    super(message);
    this.name = 'RequestBodyError';
    this.code = code ?? (status === 413 ? 'request_too_large' : status === 415 ? 'unsupported_media_type' : 'invalid_body');
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkedDeclaredLength(req: Request, maxBytes: number): void {
  const declared = req.headers.get('content-length');
  if (!declared) return;
  const bytes = Number(declared);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RequestBodyError(400, 'Invalid request body.');
  if (bytes > maxBytes) throw new RequestBodyError(413, 'Request body is too large.');
}

export async function readBoundedBytes(req: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive integer');
  checkedDeclaredLength(req, maxBytes);
  if (!req.body) throw new RequestBodyError(400, 'Invalid request body.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('request body too large').catch(() => undefined);
        throw new RequestBodyError(413, 'Request body is too large.');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function readBoundedJson(req: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw new RequestBodyError(415, 'Expected a JSON request body.');
  const bytes = await readBoundedBytes(req, maxBytes);
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RequestBodyError(400, 'Invalid request body.'); }
  if (!isPlainObject(parsed)) throw new RequestBodyError(400, 'Invalid request body.');
  return parsed;
}

export async function readBoundedFormData(req: Request, maxBytes: number): Promise<FormData> {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) throw new RequestBodyError(415, 'Expected a multipart upload.');
  const bytes = await readBoundedBytes(req, maxBytes);
  try {
    const body = Uint8Array.from(bytes).buffer;
    const buffered = new Request('https://local.invalid/upload', {
      method: 'POST', headers: { 'content-type': contentType, 'content-length': String(bytes.byteLength) }, body,
    });
    return await buffered.formData();
  } catch { throw new RequestBodyError(400, 'Invalid upload.'); }
}

export function requestBodyResponse(error: unknown, fallback = 'Invalid request body.'): { status: number; body: Record<string, unknown> } {
  const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, fallback);
  return { status: e.status, body: { error: e.message, code: e.code } };
}
