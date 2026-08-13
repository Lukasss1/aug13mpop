// ============================================================================
//  MILK POP — safe URL boundary (WP-03, Technical Pack v1)
//
//  Owner/manager-editable link values (CMS socials, store delivery links)
//  used to flow straight into href attributes — a compromised or careless
//  admin session could publish javascript:, data: or vbscript: links to every
//  visitor. This module is the ONLY way an editable value may become an href.
//
//  Rules (P0-04):
//    • Context-specific protocols: web links are https ONLY (no http — the
//      production host enforces HTTPS/HSTS and every real social/delivery target is TLS);
//      phone links are tel:, e-mail links are mailto:.
//    • Validated at the RENDER boundary always (nothing unsafe can ship even
//      if bad data is already stored) and advisorily at CMS SAVE (the Studio
//      shows an inline error so the admin learns immediately).
//    • Validation failure renders NO anchor at all — never a dead or
//      stripped-protocol link.
//    • Protocol-relative (`//evil.example`), malformed and relative values
//      all fail closed: `new URL(value)` with no base throws for anything
//      that isn't absolute, which is exactly the behaviour we want.
// ============================================================================

/** An editable value → a safe absolute URL string, or undefined (render nothing).
 *  WP03.1 hardening: URLs carrying credentials (user:pass@host) are rejected —
 *  they are a phishing primitive and no legitimate CMS link needs them. The
 *  URL parser already normalises scheme case and strips the tab/newline
 *  characters attackers use to disguise javascript: — the unit suite
 *  (scripts/safeurl.unit.test.mjs) proves each of those behaviours. */
export function safeExternalHref(value: unknown, allowed: readonly string[] = ['https:']): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return undefined;
    return allowed.includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** A canonical SITE base URL is stricter than a general external link. It must
 * be an HTTPS origin on a public-looking hostname, with no credentials, port,
 * query, fragment or sub-path. This prevents a non-empty localhost/preview URL
 * from satisfying the production opening gate. */
export function safeCanonicalSiteHref(value: unknown): string | undefined {
  const safe = safeExternalHref(value);
  if (!safe) return undefined;
  try {
    const url = new URL(safe);
    const host = url.hostname.toLowerCase();
    if (url.port || url.search || url.hash || url.pathname !== '/') return undefined;
    if (!host.includes('.') || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return undefined;
    if (/^(?:0|10|127)\./.test(host)
        || /^169\.254\./.test(host)
        || /^192\.168\./.test(host)
        || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
        || host === '::1' || /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(host.replace(/:/g, ''))) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** An editable phone value → a tel: href, or undefined. Keeps digits, +, and
 *  common separators only — anything else is not a phone number. */
export function safeTelHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || !/^\+?[0-9\s().-]{5,25}$/.test(raw)) return undefined;
  return `tel:${raw.replace(/[^0-9+]/g, '')}`;
}

/** An editable or USER-SUBMITTED e-mail value → a mailto: href, or undefined.
 *  WP03.1: the plain email regex admits `?` and `&`, which in a mailto URL
 *  become header parameters — a submitted address like `a@b.cc?bcc=…` would
 *  inject recipients into the owner's reply. Every mailto separator is
 *  therefore rejected outright; a real address never contains them. */
export function safeMailtoHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const raw = value.trim();
  if (!raw || raw.length > 320) return undefined;
  if (/[?&=#;,%<>"'\\\s]/.test(raw)) return undefined;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw)) return undefined;
  return `mailto:${raw}`;
}

/** A privacy-policy link may be either an HTTPS absolute URL or a root-relative
 *  route on this site (for example `/privacy/`). Relative paths without a
 *  leading slash, protocol-relative URLs, backslashes and control characters
 *  fail closed. This keeps the legal-notice editor convenient without letting
 *  editable content bypass the render-time URL boundary. */
export function safePolicyHref(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/[\\\u0000-\u001F\u007F]/.test(value)) return undefined;
  const raw = value.trim();
  if (!raw) return undefined;

  const external = safeExternalHref(raw);
  if (external) return external;

  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  try {
    const base = new URL('https://milkpop.local');
    const url = new URL(raw, base);
    if (url.origin !== base.origin || url.username || url.password) return undefined;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

/** True when a non-empty editable value would be REJECTED at render — the
 *  Studio uses this to show the admin an inline validation error on save. */
export function isUnsafeExternalUrl(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && safeExternalHref(value) === undefined;
}
