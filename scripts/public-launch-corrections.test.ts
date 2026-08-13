#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseOpeningHours } from '../src/lib/openingHours.ts';
import { publicStoreStatusLabel } from '../src/lib/publishRules.ts';
import { sortMenuItems, sortStores, sortVacancies, sortNews } from '../src/lib/publicOrdering.ts';

let passed = 0;
let failed = 0;
const check = (name, condition) => {
  if (condition) { passed += 1; console.log(`✔ ${name}`); }
  else { failed += 1; console.error(`✘ ${name}`); }
};

const pages = readFileSync(new URL('../src/components/PublicPages.tsx', import.meta.url), 'utf8');
const content = readFileSync(new URL('../src/siteContent.ts', import.meta.url), 'utf8');
const cloud = readFileSync(new URL('../src/lib/cloudSync.ts', import.meta.url), 'utf8');

check('Extras category is available publicly', pages.includes("{ key: 'extras', label: 'Extras' }") && !pages.includes("if (item.category === 'extras') return false"));
check('Open status uses a truthful static label', publicStoreStatusLabel('open') === 'Open');
check('store cards have no outer click handler', !/key=\{store\.id\}\s+onClick=/.test(pages));
check('regular and large prices have explicit labels', pages.includes('Regular <span') && pages.includes('Large <span') && !pages.includes('>/ {currencySymbol}{item.priceLarge'));
check('store search includes postcode', pages.includes('[store.name, store.address, store.postcode]'));
check('decorative UK map is removed', !pages.includes('UK Service Map') && !pages.includes('<UKMapSVG'));
check('store cards provide directions', pages.includes('Get directions') && pages.includes('google.com/maps/dir/'));
check('default search wording uses UK postcode terminology', content.includes('Search by postcode, area or store name…'));
check('contact payload is trimmed before validation and hashing', pages.includes('fullName: contactForm.fullName.trim()') && pages.includes('...contactPayload'));
check('runtime hydration applies shared deterministic ordering', cloud.includes("case 'milkpop_menu_items': return sortMenuItems") && cloud.includes("case 'milkpop_news_posts': return sortNews"));

const parsedAdminFormat = parseOpeningHours('Mon–Sat 09:00–21:00 · Sun 11:00–17:00');
check('SEO parser accepts the admin placeholder format', parsedAdminFormat.length === 2 && parsedAdminFormat[0].dayOfWeek.length === 6 && parsedAdminFormat[1].opens === '11:00');
const parsedLegacyFormat = parseOpeningHours('Mon-Sat: 9:00 - 21:00 | Sun: 11:00 - 17:00');
check('SEO parser remains backward compatible', parsedLegacyFormat.length === 2 && parsedLegacyFormat[0].opens === '09:00');
check('SEO parser rejects invalid clock values', parseOpeningHours('Mon 29:00-30:00').length === 0);

const menu = sortMenuItems([
  { id: 'e', category: 'extras', name: 'Sauce' },
  { id: 's', category: 'smoothies', name: 'Berry' },
  { id: 'm2', category: 'milkshakes', name: 'Vanilla' },
  { id: 'm1', category: 'milkshakes', name: 'Chocolate' },
]);
check('menu order is category then name', menu.map((item) => item.id).join(',') === 'm1,m2,s,e');
const stores = sortStores([{ id: 'b', name: 'Zulu' }, { id: 'a', name: 'Alpha' }]);
check('store order is by name', stores.map((item) => item.id).join(',') === 'a,b');
const jobs = sortVacancies([
  { id: 'old', title: 'Team Member', createdAt: '2026-01-01' },
  { id: 'new-b', title: 'Supervisor', createdAt: '2026-02-01' },
  { id: 'new-a', title: 'Assistant', createdAt: '2026-02-01' },
]);
check('vacancy order is newest then title', jobs.map((item) => item.id).join(',') === 'new-a,new-b,old');
const news = sortNews([
  { id: 'old', title: 'Old', date: '2026-01-01' },
  { id: 'new', title: 'New', date: '2026-03-01' },
]);
check('news order is newest first', news.map((item) => item.id).join(',') === 'new,old');

console.log(`\n${failed ? '✘' : '✔'} Public launch corrections — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
