/* r48-contrast.test.mjs — R4.8 Workstream K: token-level WCAG contrast MATH.
 * Computes real luminance ratios for the shipped colour pairs — not vibes.
 * (Full-page axe runs remain a CI/browser gate and are recorded as such.) */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log('✔', n); };
const bad = (n, d) => { failed++; console.log('✘', n, d || ''); };
const check = (n, c, d) => (c ? ok(n) : bad(n, d));
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x); return (h + 0.05) / (l + 0.05); };
const r1 = ratio('#FFFFFF', '#A46832');
check(`white on darkened caramel #A46832 ≥ 4.5 (got ${r1.toFixed(2)})`, r1 >= 4.5);
const r2 = ratio('#8F5322', '#EBDECE');
check(`brand-dark #8F5322 on cream chip #EBDECE ≥ 4.5 (got ${r2.toFixed(2)})`, r2 >= 4.5);
const r3 = ratio('#8F5322', '#FFFFFF');
check(`brand-dark #8F5322 on white ≥ 4.5 (got ${r3.toFixed(2)})`, r3 >= 4.5);
const r4 = ratio('#A46832', '#FFFFFF');
check(`darkened caramel on white ≥ 4.5 for normal text (got ${r4.toFixed(2)})`, r4 >= 4.5);
const r5 = ratio('#2E2A26', '#FFF8EF');
check(`ink on cream page ≥ 7 (got ${r5.toFixed(2)})`, r5 >= 7);
const walk = (d, out = []) => { for (const e of readdirSync(d)) { const f = path.join(d, e); const st = statSync(f);
  if (st.isDirectory()) walk(f, out); else if (/\.(tsx|ts|css)$/.test(e)) out.push(f); } return out; };
const oldToken = [], op85 = [];
for (const f of walk('src')) { const t = readFileSync(f, 'utf8');
  if (t.includes('#BD783A')) oldToken.push(f);
  if (t.includes('text-white/85')) op85.push(f);
}
check('the failing caramel #BD783A is gone from src (KNOWN-ISSUES option 1 applied)', oldToken.length === 0, oldToken.join(', '));
check('no text-white/85 opacity blends remain in src', op85.length === 0, op85.join(', '));
const idx = readFileSync('index.html', 'utf8');
check('theme-color follows the darkened token', idx.includes('#A46832'));
const css = readFileSync('src/index.css', 'utf8');
check('reduced-motion is respected in the stylesheet', /prefers-reduced-motion/.test(css));
check('footer links carry a 44px minimum target', /\.mp-footer-link \{\s*min-height: 44px/.test(css));
const footer = readFileSync('src/components/Footer.tsx', 'utf8');
check('footer social icons are ≥44px targets', /min-h-11 min-w-11/.test(footer));
const pp = readFileSync('src/components/PublicPages.tsx', 'utf8');
check('stores empty state offers in-main actions', /Get in touch/.test(pp) && /Follow our news/.test(pp));
check('careers empty state offers in-main actions', /Ask about future roles/.test(pp));
console.log(`\nR48-CONTRAST — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
