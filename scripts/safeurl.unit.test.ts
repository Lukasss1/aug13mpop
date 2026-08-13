/**
 * Executable tests for the URL safety boundary and canonical public-form hash.
 * Run: npm exec --offline -- tsx scripts/safeurl.unit.test.ts
 */
import {
  safeCanonicalSiteHref,
  safeExternalHref,
  safeMailtoHref,
  safePolicyHref,
  safeTelHref,
  isUnsafeExternalUrl,
} from '../src/lib/safeUrl';
import { canonicalStringify, canonicalPublicFormHash } from '../src/lib/publicSubmissionHash';

let passed = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail = '') => {
  if (condition) { passed += 1; console.log(`✔ ${name}`); }
  else { failed += 1; console.error(`✖ ${name}${detail ? `\n    ${detail}` : ''}`); }
};

/* HTTPS-only external links. */
check('plain https accepted', safeExternalHref('https://instagram.com/milkpop') === 'https://instagram.com/milkpop');
check('surrounding whitespace tolerated', safeExternalHref('  https://example.com/a  ') === 'https://example.com/a');
check('http rejected', safeExternalHref('http://example.com') === undefined);
check('javascript rejected', safeExternalHref('javascript:alert(1)') === undefined);
check('mixed-case script scheme rejected', safeExternalHref('JaVaScRiPt:alert(1)') === undefined);
check('tab-split script scheme rejected', safeExternalHref('java\tscript:alert(1)') === undefined);
check('newline-split script scheme rejected', safeExternalHref('java\nscript:alert(1)') === undefined);
check('data scheme rejected', safeExternalHref('data:text/html,<script>1</script>') === undefined);
check('protocol-relative URL rejected', safeExternalHref('//evil.example/x') === undefined);
check('relative path rejected as an external URL', safeExternalHref('/local/path') === undefined);
check('credentials rejected', safeExternalHref('https://user:pass@example.com/') === undefined);
check('uppercase HTTPS accepted after normalisation', safeExternalHref('HTTPS://example.com/x') === 'https://example.com/x');

/* Save-time warning. */
check('empty optional external URL is not flagged', isUnsafeExternalUrl('') === false);
check('valid HTTPS URL is not flagged', isUnsafeExternalUrl('https://x.com') === false);
check('script URL is flagged', isUnsafeExternalUrl('javascript:1') === true);

/* Telephone links. */
check('UK number accepted and normalised', safeTelHref('+44 (0)121 555-0199') === 'tel:+4401215550199');
check('letters rejected from telephone', safeTelHref('CALL-ME-NOW') === undefined);
check('short telephone rejected', safeTelHref('123') === undefined);
check('script-like telephone rejected', safeTelHref('+44;alert(1)') === undefined);

/* E-mail links. */
check('plain address accepted', safeMailtoHref('jobs@milkpop.uk') === 'mailto:jobs@milkpop.uk');
check('bcc injection rejected', safeMailtoHref('a@b.cc?bcc=victim@x.com') === undefined);
check('parameter injection rejected', safeMailtoHref('a@b.cc&cc=x@y.zz') === undefined);
check('encoded injection rejected', safeMailtoHref('a%3Fbcc%3Dv@b.cc') === undefined);
check('angle brackets rejected', safeMailtoHref('"x"<a@b.cc>') === undefined);
check('whitespace rejected', safeMailtoHref('a @b.cc') === undefined);
check('missing top-level domain rejected', safeMailtoHref('a@b') === undefined);

/* Privacy-policy links may be same-site root paths or HTTPS. */
check('policy route accepted', safePolicyHref('/privacy/') === '/privacy/');
check('policy route preserves query and hash', safePolicyHref('/privacy/?v=2#rights') === '/privacy/?v=2#rights');
check('HTTPS policy URL accepted', safePolicyHref('https://example.com/privacy') === 'https://example.com/privacy');
check('relative policy path rejected', safePolicyHref('privacy/') === undefined);
check('protocol-relative policy URL rejected', safePolicyHref('//evil.example/privacy') === undefined);
check('HTTP policy URL rejected', safePolicyHref('http://example.com/privacy') === undefined);
check('script policy URL rejected', safePolicyHref('javascript:alert(1)') === undefined);
check('backslash policy path rejected', safePolicyHref('/privacy\\evil') === undefined);
check('control-character policy path rejected', safePolicyHref('/privacy/\nscript') === undefined);

/* Canonical form hashing. */
check('key order does not change canonical form',
  canonicalStringify({ b: 1, a: 'x' }) === canonicalStringify({ a: 'x', b: 1 }));
const h1 = await canonicalPublicFormHash({ email: ' A@B.CC ', name: ' Molen ' });
const h2 = await canonicalPublicFormHash({ name: 'Molen', email: 'a@b.cc' });
const h3 = await canonicalPublicFormHash({ name: 'Molen', email: 'a@b.cc', extra: 'now different' });
check('normalisation produces the same hash', h1 === h2, `${h1} != ${h2}`);
check('changed payload changes the hash', h1 !== h3);
check('hash is 64 lowercase hexadecimal characters', /^[0-9a-f]{64}$/.test(h1));


check('canonical site URL accepts a public HTTPS root', safeCanonicalSiteHref('https://milkpop.uk/') === 'https://milkpop.uk/');
check('canonical site URL rejects localhost', safeCanonicalSiteHref('https://localhost/') === undefined);
check('canonical site URL rejects private IPv4', safeCanonicalSiteHref('https://192.168.1.5/') === undefined);
check('canonical site URL rejects ports and subpaths', safeCanonicalSiteHref('https://milkpop.uk:8443/') === undefined && safeCanonicalSiteHref('https://milkpop.uk/admin/') === undefined);
check('canonical site URL rejects query and fragment', safeCanonicalSiteHref('https://milkpop.uk/?preview=1') === undefined && safeCanonicalSiteHref('https://milkpop.uk/#home') === undefined);
console.log(`\nSAFEURL/HASH UNIT — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
