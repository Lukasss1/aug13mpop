// ============================================================================
//  MILK POP — canonical public-form payload hash (Patch Spec §6.1/§6.2)
//
//  CLIENT-LOCAL canonicalisation: this hash decides when the stable
//  submission-attempt key must ROTATE (payload changed) and nothing else.
//  The SERVER computes its own request_hash from the allow-listed normalised
//  row — the two never need to be byte-equal, so UI-side field names can stay
//  ergonomic. What matters here is determinism: same user-visible payload →
//  same hash → same attempt key → a retry resolves to the original row.
// ============================================================================

/** Deterministic JSON: objects get sorted keys at every depth. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
}

/** Normalise the way the server will: trim every string, lowercase email. */
export function normalisePayload<T extends Record<string, unknown>>(payload: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = typeof v === 'string' ? (k === 'email' ? v.trim().toLowerCase() : v.trim()) : v;
  }
  return out;
}

/** SHA-256 hex of the canonical normalised payload. */
export async function canonicalPublicFormHash(payload: Record<string, unknown>): Promise<string> {
  const text = canonicalStringify(normalisePayload(payload));
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
