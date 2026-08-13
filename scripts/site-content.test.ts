/**
 * Logic tests for the Website Studio content model (src/siteContent.ts).
 * Run with:  npm exec --offline -- tsx scripts/site-content.test.ts   (or `npm run test:content`)
 *
 * Covers the three behaviours the live site depends on:
 *   1. Fresh install  -> exact launch defaults.
 *   2. Partial save   -> deep-merge over defaults (new fields never blank),
 *                        arrays taken wholesale, wrong-typed scalars rejected.
 *   3. Legacy upgrade -> old cms_pages edits (hero copy, about images, SEO)
 *                        imported once when nothing is saved under the new key.
 */
import { DEFAULT_SITE_CONTENT, hydrateSiteContent } from '../src/siteContent';

let failures = 0;
const check = (name: string, cond: boolean) => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL'} ${name}`);
  if (!cond) failures++;
};

/* Minimal localStorage stub so hydrateSiteContent's legacy-import branch can
   run under Node exactly as it does in the browser. */
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};

console.log('\n1. Fresh install → launch defaults');
{
  store.clear();
  const c = hydrateSiteContent(null);
  check('hero headline is the launch copy', c.home.heroHeadline === 'Sip • Smile •\nEnjoy');
  check('three promise cards seeded', c.home.promiseCards.length === 3);
  check('legal privacy body present', c.legal.privacy.body.includes('handles personal information submitted through this website'));
  check('result is a deep copy, not the shared default object', c.home !== DEFAULT_SITE_CONTENT.home);
}

console.log('\n2. Partial save → deep-merge over defaults');
{
  store.clear();
  const saved = {
    home: { heroHeadline: 'Custom headline', promiseCards: [{ title: 'Only one', text: 'card' }] },
    nav: { menu: 'Drinks' },
    seo: { home: { title: 'Custom tab title' } },
    aboutPage: { craftHeading: 12345 }, // wrong type → must fall back
  };
  const c = hydrateSiteContent(saved);
  check('saved scalar wins', c.home.heroHeadline === 'Custom headline');
  check('untouched sibling keeps default', c.home.heroSubheadline === DEFAULT_SITE_CONTENT.home.heroSubheadline);
  check('arrays are taken wholesale (1 card)', c.home.promiseCards.length === 1 && c.home.promiseCards[0].title === 'Only one');
  check('nested nav merge', c.nav.menu === 'Drinks' && c.nav.home === 'Home');
  check('nested seo merge keeps default description', c.seo.home.title === 'Custom tab title' && c.seo.home.description === DEFAULT_SITE_CONTENT.seo.home.description);
  check('wrong-typed scalar rejected', c.aboutPage.craftHeading === DEFAULT_SITE_CONTENT.aboutPage.craftHeading);
  check('sections absent from the save keep full defaults', c.careersPage.perks.length === 4);
}

console.log('\n3. Legacy cms_pages upgrade path');
{
  store.clear();
  store.set('milkpop_cms_pages', JSON.stringify([
    { id: 'cms_home', heroHeadline: 'Old CMS headline', heroSubheadline: 'Old sub', ctaText: 'Old CTA', seoTitle: 'Old SEO', seoDescription: 'Old desc' },
    { id: 'cms_about', aboutImage1: 'https://img/one.jpg', aboutImage2: 'https://img/two.jpg' },
  ]));
  const c = hydrateSiteContent(null);
  check('legacy hero headline imported', c.home.heroHeadline === 'Old CMS headline');
  check('legacy hero sub imported', c.home.heroSubheadline === 'Old sub');
  check('legacy CTA imported', c.home.heroPrimaryCta === 'Old CTA');
  check('legacy SEO imported', c.seo.home.title === 'Old SEO' && c.seo.home.description === 'Old desc');
  check('legacy about images imported', c.aboutPage.craftImage === 'https://img/one.jpg' && c.aboutPage.cultureImage === 'https://img/two.jpg');

  // Once anything is saved under the NEW key, legacy import must stop.
  const c2 = hydrateSiteContent({ home: { heroHeadline: 'Studio edit' } });
  check('saved content beats legacy import', c2.home.heroHeadline === 'Studio edit');
  check('non-imported fields fall back to defaults, not legacy', c2.home.heroPrimaryCta === DEFAULT_SITE_CONTENT.home.heroPrimaryCta);

  // Corrupt legacy JSON must never crash boot.
  store.set('milkpop_cms_pages', '{not json');
  const c3 = hydrateSiteContent(null);
  check('corrupt legacy data is ignored safely', c3.home.heroHeadline === DEFAULT_SITE_CONTENT.home.heroHeadline);
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All site-content checks passed.');
