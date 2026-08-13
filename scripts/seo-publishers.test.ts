/**
 * seo-publishers.test.ts — OPT-02-C1.2 acceptance items (10)(11).
 *
 * Two parts:
 *  1. The pure after-publish decision (src/lib/seoRebuild.ts → afterPublishRebuild):
 *       • a CONFIRMED public-content write requests a rebuild;
 *       • a FAILED write never requests a rebuild (nothing changed live);
 *       • a no-op (changed:false) never requests a rebuild;
 *       • the rebuild result is passed straight back so the UI can show it.
 *  2. A static wiring assertion over src/App.tsx: exactly the six public-content
 *     domains (menu, stores, vacancies, news, site-content, site-settings) drive
 *     an SEO rebuild — private/internal registries (deals, KB articles, media,
 *     checklists, …) deliberately do NOT.
 *
 * Run: npm run test:seo-publishers
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterPublishRebuild, SEO_REBUILD_AREAS } from '../src/lib/seoRebuild';
import type { SeoRebuildArea, SeoRebuildResult } from '../src/lib/seoRebuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'src', 'App.tsx');

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`\u2714 ${name}`); }
  else { failed++; console.error(`\u2716 ${name}`); }
};

/** A spy for the rebuild request; records the areas it was asked to rebuild. */
function spy(result: SeoRebuildResult = { ok: true, queued: true }) {
  const calls: SeoRebuildArea[] = [];
  const fn = async (area: SeoRebuildArea): Promise<SeoRebuildResult> => { calls.push(area); return result; };
  return { fn, calls };
}

async function run() {
  /* --- part 1: afterPublishRebuild ------------------------------------- */

  // Confirmed write for every area → requests a rebuild for that area.
  for (const area of SEO_REBUILD_AREAS) {
    const s = spy();
    const out = await afterPublishRebuild(area, true, s.fn);
    check(`confirmed "${area}" write requests a rebuild`,
      out.requested === true && s.calls.length === 1 && s.calls[0] === area);
  }

  // Failed write → never rebuilds.
  {
    const s = spy();
    const out = await afterPublishRebuild('menu', false, s.fn);
    check('failed write does NOT request a rebuild',
      out.requested === false && out.reason === 'write-failed' && s.calls.length === 0);
  }

  // No-op (changed:false) → never rebuilds.
  {
    const s = spy();
    const out = await afterPublishRebuild('stores', true, s.fn, { changed: false });
    check('no-op write (changed:false) does NOT request a rebuild',
      out.requested === false && out.reason === 'no-op' && s.calls.length === 0);
  }

  // Explicit changed:true → rebuilds.
  {
    const s = spy();
    const out = await afterPublishRebuild('site-content', true, s.fn, { changed: true });
    check('changed:true write requests a rebuild', out.requested === true && s.calls.length === 1);
  }

  // The rebuild result is returned verbatim (so the UI can render failures).
  {
    const failResult: SeoRebuildResult = { ok: false, code: 'failed', message: 'boom' };
    const s = spy(failResult);
    const out = await afterPublishRebuild('news', true, s.fn);
    check('rebuild failure is returned, not thrown',
      out.requested === true && out.requested && (out as { result: SeoRebuildResult }).result.ok === false);
  }

  /* --- part 2: static wiring assertion over App.tsx -------------------- */
  const src = readFileSync(APP, 'utf8');

  // Areas passed to withSeoRebuild(...) — the collection publishers.
  const wrapped = new Set<string>();
  const re = /withSeoRebuild\(\s*['"]([a-z-]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) wrapped.add(m[1]);

  check('exactly the 4 SEO collection publishers are wrapped (menu, stores, vacancies, news)',
    wrapped.size === 4 && ['menu', 'stores', 'vacancies', 'news'].every((a) => wrapped.has(a)));

  // The two singleton content saves drive a rebuild too.
  check('site content save requests a rebuild', /runSeoRebuildAfterPublish\(\s*['"]site-content['"]/.test(src));
  check('site settings save requests a rebuild', /runSeoRebuildAfterPublish\(\s*['"]site-settings['"]/.test(src));

  // Private/internal registries must NOT be wrapped. Assert their publisher
  // definitions carry no withSeoRebuild wrapper.
  const NON_SEO = ['publishArticles', 'publishDeals', 'publishMediaItems', 'publishChecklistTemplates'];
  for (const name of NON_SEO) {
    const line = src.split('\n').find((l) => l.includes(`const ${name} =`)) || '';
    check(`${name} is NOT wrapped for SEO rebuild`, line.length > 0 && !line.includes('withSeoRebuild'));
  }

  // Sanity: none of the non-SEO domains are even valid rebuild areas.
  check('"deals" is not a rebuild area', !(SEO_REBUILD_AREAS as readonly string[]).includes('deals'));
  check('"articles"/"kb" is not a rebuild area',
    !(SEO_REBUILD_AREAS as readonly string[]).includes('articles') &&
    !(SEO_REBUILD_AREAS as readonly string[]).includes('kb'));

  console.log(`\n${failed ? '\u2716' : '\u2714'} seo-publishers: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((e) => { console.error('seo-publishers.test crashed:', e); process.exit(1); });
