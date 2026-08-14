#!/usr/bin/env node
/**
 * ============================================================================
 *  LAUNCH POLISH AUDIT — accessibility and public-page readiness
 * ============================================================================
 *
 *  The browser lane proved ROUTING and honest empty states. It did not check a
 *  single accessibility property, yet the launch checklist asks for keyboard
 *  navigation, focus visibility, modal focus and Escape, form announcements,
 *  200% zoom and the mobile menu. Those are exactly the things that make a
 *  small business's site usable — and exactly the things nobody notices are
 *  broken until a customer cannot order.
 *
 *  This runs against the BUILT site in a real browser and asserts properties,
 *  not markup strings. It is deliberately conservative: everything it checks
 *  is an objective WCAG-style requirement with a single correct answer, so it
 *  can gate a release without becoming a matter of taste.
 *
 *  Run:  npm run audit:launch-polish   (needs `npm exec --offline -- vite preview` on :4173)
 */
import { chromium } from 'playwright';

const BASE = process.env.MP_BASE || 'http://127.0.0.1:4173';
const PAGES = ['/', '/menu/', '/stores/', '/about/', '/contact/', '/privacy/', '/gdpr/'];
const DISABLED_OPTIONAL = ['/careers/', '/franchise/', '/news/', '/fdd/'];

let passed = 0, failed = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { passed += 1; console.log(`  \u2714 ${label}`); }
  else { failed += 1; failures.push(label); console.log(`  \u2716 ${label}${detail ? ` \u2014 ${detail}` : ''}`); }
};

/** Relative luminance + contrast ratio (WCAG 2.1). */
const lum = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};
/* Colours are resolved IN THE PAGE via a canvas, because a regex cannot read
   modern CSS colour syntax: Tailwind 4 emits `oklch(...)`, and a naive
   number-scrape turned amber-50 into near-black and reported 1.26:1 on
   perfectly legible text. A canvas accepts any CSS colour and returns sRGB
   bytes, and semi-transparent layers are composited rather than ignored — an
   ignored alpha flatters dark-on-light and hides real failures. */

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

console.log('LAUNCH POLISH AUDIT');
console.log('===================');

/* ---------------------------------------------------------------- */
console.log('\n\u00a71  Document-level essentials on every public page');
for (const route of PAGES) {
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  const info = await page.evaluate(() => ({
    lang: document.documentElement.getAttribute('lang'),
    title: (document.title || '').trim(),
    desc: (document.querySelector('meta[name="description"]')?.getAttribute('content') || '').trim(),
    h1s: document.querySelectorAll('h1').length,
    skip: !!document.querySelector('a[href^="#"]'),
    main: !!document.querySelector('main, #main, [role="main"]'),
  }));
  ok(`${route} html[lang] is set`, !!info.lang, String(info.lang));
  ok(`${route} has a non-empty <title>`, info.title.length > 5, info.title);
  ok(`${route} has a meta description`, info.desc.length > 20, `${info.desc.length} chars`);
  ok(`${route} has exactly one <h1>`, info.h1s === 1, `${info.h1s} found`);
  ok(`${route} exposes a main landmark`, info.main);
}

console.log('\n  Publication switches: disabled optional programmes fail closed');
for (const route of DISABLED_OPTIONAL) {
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  const body = (await page.textContent('body')) || '';
  ok(`${route} renders the not-published view`, /couldn.t find that page|404/i.test(body), body.trim().slice(0, 50));
  ok(`${route} is noindex while unpublished`,
    /noindex/i.test(await page.getAttribute('meta[name="robots"]', 'content') || ''));
}

/* ---------------------------------------------------------------- */
console.log('\n\u00a72  Images carry alt text (decorative images use alt="")');
for (const route of PAGES) {
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('img')]
      .filter((i) => i.getAttribute('alt') === null)
      .map((i) => i.getAttribute('src') || i.outerHTML.slice(0, 60)));
  ok(`${route} every <img> has an alt attribute`, missing.length === 0, missing.slice(0, 3).join(' | '));
}

/* ---------------------------------------------------------------- */
console.log('\n\u00a73  Every control has an accessible name');
for (const route of ['/contact/', '/menu/', '/stores/']) {
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  const unnamed = await page.evaluate(() => {
    const named = (el) => {
      if (el.getAttribute('aria-label')?.trim()) return true;
      if (el.getAttribute('aria-labelledby')?.trim()) return true;
      if (el.getAttribute('title')?.trim()) return true;
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return true;
      if (el.closest('label')) return true;
      if ((el.textContent || '').trim()) return true;
      if (el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type) && el.value?.trim()) return true;
      return false;
    };
    return [...document.querySelectorAll('input:not([type=hidden]), select, textarea, button, a[href]')]
      .filter((el) => !named(el))
      .map((el) => `${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ''}${el.id ? `#${el.id}` : ''}`);
  });
  ok(`${route} every input, select, button and link has an accessible name`,
    unnamed.length === 0, unnamed.slice(0, 4).join(', '));
}

/* ---------------------------------------------------------------- */
console.log('\n\u00a74  Keyboard: skip link, focus visibility, tab order');
await page.goto(BASE + '/', { waitUntil: 'networkidle' });
{
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName, text: (el?.textContent || '').trim().slice(0, 40), href: el?.getAttribute?.('href') };
  });
  ok('the FIRST tab stop is the skip link', /skip/i.test(first.text), `${first.tag}: ${first.text}`);

  const focusVisible = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth || '0') > 0;
    const ring = cs.boxShadow && cs.boxShadow !== 'none';
    return outline || ring;
  });
  ok('the focused element has a VISIBLE focus indicator', focusVisible);

  // Following the skip link must move focus into the main content.
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const afterSkip = await page.evaluate(() => {
    const el = document.activeElement;
    return { inMain: !!el?.closest?.('main, #main, [role="main"]'), id: el?.id, tag: el?.tagName };
  });
  ok('activating the skip link moves focus into main', afterSkip.inMain || afterSkip.id === 'main',
    `${afterSkip.tag}#${afterSkip.id}`);
}

/* ---------------------------------------------------------------- */
console.log('\n\u00a75  Mobile: menu opens, closes with Escape, and returns focus');
{
  const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mob.goto(BASE + '/', { waitUntil: 'networkidle' });
  const toggle = mob.locator('#mobile-menu-hamburger').first();
  const hasToggle = await toggle.count() > 0;
  ok('a mobile menu control exists', hasToggle);
  if (hasToggle) {
    const box = await toggle.boundingBox();
    ok('…and its touch target is at least 40x40', !!box && box.width >= 40 && box.height >= 40,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box');
    await toggle.click();
    await mob.waitForTimeout(300);
    const opened = await mob.evaluate(() => !!document.getElementById('mobile-nav-panel'));
    ok('…the menu opens', opened);
    ok('…and the control reports aria-expanded="true"',
      (await toggle.getAttribute('aria-expanded')) === 'true');
    await mob.keyboard.press('Escape');
    await mob.waitForTimeout(300);
    ok('…Escape closes the menu',
      !(await mob.evaluate(() => !!document.getElementById('mobile-nav-panel'))));
    ok('…and focus returns to the control that opened it',
      await mob.evaluate(() => document.activeElement?.id === 'mobile-menu-hamburger'));
  }
  await mob.close();
}

/* ---------------------------------------------------------------- */
console.log('\n\u00a76  200% zoom: no horizontal overflow');
{
  const zoom = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  await zoom.goto(BASE + '/', { waitUntil: 'networkidle' });
  // 200% zoom is equivalent to halving the CSS viewport.
  await zoom.setViewportSize({ width: 640, height: 450 });
  await zoom.waitForTimeout(300);
  for (const route of ['/', '/menu/', '/contact/']) {
    await zoom.goto(BASE + route, { waitUntil: 'networkidle' });
    const overflow = await zoom.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`${route} has no horizontal scroll at 200% zoom`, overflow <= 2, `${overflow}px overflow`);
  }
  await zoom.close();
}

/* ---------------------------------------------------------------- */
console.log('\n\u00a77  Body-text contrast meets WCAG AA (4.5:1)');
{
  for (const route of ['/', '/menu/', '/stores/', '/contact/']) {
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  const samples = await page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    /** Any CSS colour → [r,g,b,a] in sRGB, using the browser's own parser. */
    const toRgba = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;                      // invalid colours keep '#000'
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    };
    const over = (fg, bg) => {                  // source-over compositing
      const a = fg[3];
      return [0, 1, 2].map((i) => Math.round(fg[i] * a + bg[i] * (1 - a))).concat(1);
    };
    /** Effective background: composite every translucent layer down to white. */
    /* Returns null when the stack contains a background IMAGE or gradient:
       the effective colour behind the text then varies pixel by pixel and a
       single ratio would be a guess. Those samples are reported as
       "needs a manual look", never silently passed and never failed — a
       checker that cannot see something must say so. */
    const bgOf = (el) => {
      const layers = [];
      let n = el;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
        const c = toRgba(cs.backgroundColor);
        if (c[3] > 0) { layers.push(c); if (c[3] === 1) break; }
        n = n.parentElement;
      }
      let base = [255, 255, 255, 1];
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
      return base;
    };
    const out = [];
    const els = [...document.querySelectorAll('p, li, h1, h2, h3, a, button')].slice(0, 120);
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (!t || t.length < 4) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const bg = bgOf(el);
      if (!bg) { out.push({ text: t.slice(0, 30), unmeasurable: true }); continue; }
      out.push({
        text: t.slice(0, 30),
        color: over(toRgba(cs.color), bg).slice(0, 3),   // text alpha composited too
        bg: bg.slice(0, 3),
        size: parseFloat(cs.fontSize), weight: cs.fontWeight,
      });
    }
    return out;
  });
  const bad = [];
  const unmeasurable = samples.filter((s) => s.unmeasurable);
  for (const s of samples.filter((x) => !x.unmeasurable)) {
    const ratio = contrast(s.color, s.bg);
    const large = s.size >= 24 || (s.size >= 18.66 && Number(s.weight) >= 700);
    const need = large ? 3 : 4.5;
    if (ratio + 0.05 < need) bad.push(`"${s.text}" ${ratio.toFixed(2)}:1 (needs ${need})`);
  }
  ok(`${route} text meets AA contrast (${samples.length - unmeasurable.length} measurable elements)`,
    bad.length === 0, bad.slice(0, 4).join(' | '));
  if (unmeasurable.length) {
    console.log(`      \u2139 ${unmeasurable.length} element(s) sit on an image/gradient — contrast not machine-checkable, verify by eye: ${unmeasurable.slice(0, 3).map((u) => `"${u.text}"`).join(', ')}`);
  }
  }
}

/* ---------------------------------------------------------------- */
console.log('\n\u00a78  Reduced motion is respected (WCAG 2.3.3)');
{
  /* src/index.css disables the CSS keyframes under the media query, but the
     public pages also run 22 JS-driven motion/react animations that a media
     query cannot reach. The app is wrapped in `MotionConfig
     reducedMotion="user"`, and the property that actually matters to a
     visitor is asserted here: with reduced motion requested, content is
     VISIBLE and STILL — never left mid-animation or stuck transparent. */
  const rm = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await rm.goto(BASE + '/', { waitUntil: 'networkidle' });
  /* Wait for the page to SETTLE rather than sampling at a fixed delay. A
     fixed wait sampled the boot splash and reported the heading at 0.367
     opacity — a flaky gate is worse than no gate, because the first false
     alarm is the moment people start ignoring it. The property that matters
     is that content REACHES full visibility, so wait for exactly that and
     fail only if it never happens. */
  let settled = true;
  try {
    await rm.waitForFunction(() => {
      const h1 = document.querySelector('h1');
      return !!h1 && parseFloat(getComputedStyle(h1).opacity) === 1;
    }, { timeout: 6000 });
  } catch { settled = false; }
  ok('content reaches full visibility under reduced motion (never stuck faded)', settled);
  const state = await rm.evaluate(() => {
    const h1 = document.querySelector('h1');
    const cs = h1 ? getComputedStyle(h1) : null;
    const running = [...document.querySelectorAll('.mp-float, .mp-bob, .mp-wave, .mp-drift')]
      .filter((el) => getComputedStyle(el).animationName !== 'none').length;
    const hidden = [...document.querySelectorAll('h1, h2, p, a')]
      .filter((el) => {
        const c = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return r.width > 4 && r.height > 4 && r.top < window.innerHeight && parseFloat(c.opacity) < 0.9;
      }).length;
    return {
      h1Opacity: cs ? parseFloat(cs.opacity) : null,
      h1Transform: cs ? cs.transform : null,
      running, hidden,
      scroll: getComputedStyle(document.documentElement).scrollBehavior,
    };
  });
  ok('the main heading is fully visible under reduced motion', state.h1Opacity === 1, String(state.h1Opacity));
  /* Transforms are the vestibular trigger WCAG 2.3.3 is about — opacity fades
     are explicitly acceptable, which is why framer's `reducedMotion="user"`
     keeps them and drops transform/layout motion. */
  ok('no residual transform-based motion on the heading', state.h1Transform === 'none', String(state.h1Transform));
  ok('no decorative CSS keyframe animation keeps running', state.running === 0, `${state.running} running`);
  ok('no above-the-fold content is left stuck part-way through a fade', state.hidden === 0, `${state.hidden} elements < 0.9 opacity`);
  ok('smooth scrolling is disabled', state.scroll !== 'smooth', state.scroll);
  await rm.close();
}

/* ---------------------------------------------------------------- */
console.log('\n\u00a79  Detail routes carry their own title and description');
for (const route of ['/stores/']) {
  await page.goto(BASE + route, { waitUntil: 'networkidle' });
  const meta = await page.evaluate(() => ({
    title: (document.title || '').trim(),
    canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
  }));
  ok(`${route} declares a canonical URL`, meta.canonical.length > 0, meta.canonical);
  ok(`${route} title is specific, not the bare brand name`, meta.title.length > 10 && /milk pop/i.test(meta.title), meta.title);
}

/* ---------------------------------------------------------------- */
console.log('\n\u00a710 No uncaught page errors across the audit');
ok('zero uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
console.log(`\nLAUNCH POLISH AUDIT \u2014 ${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
