// Shared JWT claim decoding. This only decodes already-present claims; callers
// must verify the access token through Supabase Auth before authorising.
export type JwtClaims = Record<string, unknown> & { sub?: unknown; aal?: unknown; exp?: unknown };
function decodeBase64Url(segment: string): Uint8Array {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('invalid_jwt_segment');
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function decodeJwtClaims(token: string): JwtClaims | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(parts[1])));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JwtClaims : null;
  } catch { return null; }
}
export function jwtHasAal2(token: string): boolean { return String(decodeJwtClaims(token)?.aal || 'aal1') === 'aal2'; }
