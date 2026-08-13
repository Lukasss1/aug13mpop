/**
 * Collision-resistant client identifiers for draft/admin-created rows.
 *
 * These IDs are not authentication secrets; the database remains authoritative.
 * The helper avoids Date.now()-only identifiers, which can collide across tabs or
 * two actions in the same millisecond. Prefixes are retained for operational
 * readability and compatibility with the existing text primary keys.
 */
let fallbackCounter = 0;

function fallbackToken(): string {
  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER;
  const randomPart = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36);
  return `${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${randomPart}`;
}

export function createClientId(prefix: string): string {
  if (!/^[a-z][a-z0-9]*$/i.test(prefix)) {
    throw new Error('Client ID prefix must contain only letters and numbers and start with a letter.');
  }

  const cryptoApi = typeof globalThis.crypto === 'object' ? globalThis.crypto : undefined;
  let token: string;
  if (typeof cryptoApi?.randomUUID === 'function') {
    token = cryptoApi.randomUUID();
  } else if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    token = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  } else {
    token = fallbackToken();
  }
  return `${prefix}_${token}`;
}
