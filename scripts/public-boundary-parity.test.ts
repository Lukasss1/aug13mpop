#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SELECTS } from './load-public-content';
import {
  isCareerVacancy,
  isDeal,
  isMenuItem,
  isNewsPost,
  isStoreLocation,
  validateBuildPublicContent,
} from '../src/lib/publicDataValidation';
import {
  projectPublicDeals,
  projectPublicVacancies,
} from '../src/lib/publicProjection';
import { buildPublicContentSnapshot, canonicalContentHash, publicLegalName, snapshotCounts, socialProfiles } from '../src/lib/publicContentSnapshot';
import { hydrateSiteContent } from '../src/siteContent';
import { INITIAL_SETTINGS } from '../src/data';
import type { CareerVacancy, Deal, MenuItem, NewsPost, StoreLocation } from '../src/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (name: string, condition: boolean, detail = '') => {
  if (condition) { passed += 1; console.log(`✔ ${name}`); }
  else { failed += 1; console.error(`✘ ${name}${detail ? `\n  ${detail}` : ''}`); }
};

const projectedVacancy = {
  id: 'vacancy-public', title: 'Team member', location: 'Solihull', department: 'Store', salary: '£12 per hour',
  type: 'Part-time', roleDescription: 'Serve customers and prepare drinks.', requirements: [], responsibilities: [],
} as CareerVacancy;
const draftVacancy = { ...projectedVacancy, id: 'vacancy-draft', status: 'draft' } as CareerVacancy;
const publicDeal = {
  id: 'deal-public', name: 'Opening offer', type: 'percent', description: '', category: '', badge: '',
} as Deal;
const inactiveDeal = { ...publicDeal, id: 'deal-private', active: false } as Deal;

const vacancies = projectPublicVacancies([projectedVacancy, draftVacancy]);
const deals = projectPublicDeals([publicDeal, inactiveDeal]);
check('projected vacancy with omitted status is retained', vacancies.length === 1 && vacancies[0]?.id === 'vacancy-public');
check('projected vacancy is normalised to published', vacancies[0]?.status === 'published');
check('explicit draft vacancy is removed', !vacancies.some((row) => row.id === 'vacancy-draft'));
check('projected deal with omitted active flag is retained', deals.length === 1 && deals[0]?.id === 'deal-public');
check('projected deal is normalised to active', deals[0]?.active === true);
check('explicit inactive deal is removed', !deals.some((row) => row.id === 'deal-private'));

check('vacancy validator accepts projection-omitted status', isCareerVacancy(projectedVacancy));
check('vacancy validator rejects explicit draft', !isCareerVacancy(draftVacancy));
check('deal validator accepts projection-omitted active flag', isDeal(publicDeal));
check('deal validator rejects explicit inactive row', !isDeal(inactiveDeal));

const menuBase = { id: 'menu-public', name: 'Shake', category: 'milkshakes', price: 5 } as MenuItem;
const storeBase = {
  id: 'store-public', name: 'Milk Pop', address: 'Touchwood', postcode: 'B91', status: 'coming_soon',
} as StoreLocation;
const newsBase = { id: 'news-public', title: 'Opening update', content: 'Soon', status: 'published' } as NewsPost;
check('menu validator accepts projected row with omitted available flag', isMenuItem(menuBase));
check('menu validator rejects explicit unavailable row', !isMenuItem({ ...menuBase, available: false }));
check('store validator accepts projected row with omitted setup status', isStoreLocation(storeBase));
check('store validator accepts a genuine DRAFT row because POS setup is not a public-listing gate', isStoreLocation({ ...storeBase, setupStatus: 'DRAFT' }));
check('store validator rejects an unknown setup state', !isStoreLocation({ ...storeBase, setupStatus: 'BROKEN' as never }));
check('news validator accepts published row', isNewsPost(newsBase));
check('news validator rejects draft row', !isNewsPost({ ...newsBase, status: 'draft' }));

const snapshot = buildPublicContentSnapshot({
  siteSettings: INITIAL_SETTINGS,
  siteContent: hydrateSiteContent(null),
  menuItems: [menuBase, { ...menuBase, id: 'menu-private', available: false }],
  stores: [storeBase, { ...storeBase, id: 'store-coming-soon', setupStatus: 'DRAFT' }, { ...storeBase, id: 'store-placeholder', name: 'TBC', address: '-', postcode: 'N/A' }],
  vacancies: [projectedVacancy, draftVacancy],
  newsPosts: [newsBase, { ...newsBase, id: 'news-private', status: 'draft' }],
});
check('snapshot excludes unavailable menu products', snapshot.menuItems.map((row) => row.id).join(',') === 'menu-public');
check('snapshot includes genuine coming-soon stores but excludes placeholder identities', snapshot.stores.map((row) => row.id).join(',') === 'store-coming-soon,store-public');
check('snapshot excludes draft vacancies', snapshot.vacancies.map((row) => row.id).join(',') === 'vacancy-public');
check('snapshot excludes draft news', snapshot.newsPosts.map((row) => row.id).join(',') === 'news-public');

const baseHash = canonicalContentHash(snapshot);
const withPhone = structuredClone(snapshot);
withPhone.siteSettings.phone = '+44 121 000 0000';
check('public contact changes alter the canonical build hash', canonicalContentHash(withPhone) !== baseHash);
const withHeroCopy = structuredClone(snapshot);
withHeroCopy.siteContent.home.heroHeadline = 'A newly confirmed opening headline';
check('website copy changes alter the canonical build hash', canonicalContentHash(withHeroCopy) !== baseHash);
const withMenuImage = structuredClone(snapshot);
withMenuImage.menuItems[0]!.image = '/brand/mascot_wave.webp';
check('customer-visible menu media changes alter the canonical build hash', canonicalContentHash(withMenuImage) !== baseHash);
const withPrivateMenuField = structuredClone(snapshot) as typeof snapshot & { menuItems: Array<MenuItem & { taxCode?: string }> };
withPrivateMenuField.menuItems[0]!.taxCode = 'private-admin-only';
check('private menu fields do not alter the public build hash', canonicalContentHash(withPrivateMenuField) === baseHash);
check('unsafe social URLs never enter structured data or the build hash',
  socialProfiles({ ...INITIAL_SETTINGS, instagramUrl: 'javascript:alert(1)', facebookUrl: 'https://facebook.example/milkpop' }).length === 1);
check('brand label alone is not published as a registered legal name',
  publicLegalName({ ...INITIAL_SETTINGS, brandName: 'Milk Pop', legalName: 'MILK POP' }) === '');
check('a distinct confirmed legal name remains publishable',
  publicLegalName({ ...INITIAL_SETTINGS, brandName: 'Milk Pop', legalName: 'Milk Pop Foods Limited' }) === 'Milk Pop Foods Limited');

const validBuildSnapshot = {
  snapshot,
  metadata: {
    source: 'supabase',
    generatedAt: '2026-08-02T00:00:00.000Z',
    contentHash: baseHash,
    counts: snapshotCounts(snapshot),
    latestUpdatedAt: {},
  },
};
check('runtime accepts a Supabase build snapshot whose hash and counts match',
  validateBuildPublicContent(validBuildSnapshot).ok);
const tamperedBuildSnapshot = structuredClone(validBuildSnapshot);
tamperedBuildSnapshot.snapshot.siteSettings.phone = '+44 121 999 9999';
check('runtime rejects a build snapshot whose content was changed after hashing',
  !validateBuildPublicContent(tamperedBuildSnapshot).ok);
const miscountedBuildSnapshot = structuredClone(validBuildSnapshot);
miscountedBuildSnapshot.metadata.counts.menuItems += 1;
check('runtime rejects a build snapshot whose recorded counts do not match',
  !validateBuildPublicContent(miscountedBuildSnapshot).ok);
const unhashedBuildSnapshot = structuredClone(validBuildSnapshot) as typeof validBuildSnapshot & { metadata: { contentHash: string } };
unhashedBuildSnapshot.metadata.contentHash = 'not-a-content-hash';
check('runtime rejects a build snapshot without a valid canonical hash',
  !validateBuildPublicContent(unhashedBuildSnapshot).ok);

const expectedConfigurationColumns = [
  'id','legal_name','company_number','hq_address','email','gdpr_email','phone','website_url','brand_name',
  'instagram_handle','instagram_url','facebook_url','twitter_url','footer_tagline','allergen_notice',
  'announcement_enabled','announcement_text','currency_symbol','default_opening_hours','updated_at',
  'show_careers','show_franchise','show_news',
];
const selectedConfigurationColumns = SELECTS.public_site_configuration.split(',').map((value) => value.trim());
check('SEO loader requests every public configuration column',
  JSON.stringify(selectedConfigurationColumns) === JSON.stringify(expectedConfigurationColumns),
  selectedConfigurationColumns.join(','));

const contract = JSON.parse(readFileSync(path.join(ROOT, 'scripts/contracts/public-contract.json'), 'utf8'));
const configurationContract = contract.relations.find((entry: { relation?: string }) => entry.relation === 'public_site_configuration');
check('public configuration contract requires exact loader/view parity', configurationContract?.loader_columns_must_match_view === true);
for (const relation of ['cms_pages_public', 'media_assets_public']) {
  const entry = contract.relations.find((item: { relation?: string }) => item.relation === relation);
  check(`${relation} is declared authenticated-only`, entry?.status === 'built');
}
const settingsTableContract = contract.relations.find((item: { relation?: string }) => item.relation === 'site_settings');
check('site_settings base table is declared authenticated-only', settingsTableContract?.status === 'built');
check('anonymous SELECT ceiling reflects the narrowed surface', contract.anon_select_grant_ceiling === 10);

const anonContract = JSON.parse(readFileSync(path.join(ROOT, 'scripts/contracts/anon-surface.json'), 'utf8'));
check('anonymous allow-list contains only the canonical settings view',
  anonContract.anon_select_allowed.some((entry: { relation?: string }) => entry.relation === 'public_site_configuration')
  && !anonContract.anon_select_allowed.some((entry: { relation?: string }) => entry.relation === 'site_settings'));
check('site_settings is protected by the anonymous never-list', anonContract.must_never_be_anon_selectable.includes('site_settings'));

const boundaryMigration = readFileSync(path.join(ROOT, 'supabase/migration_t13310_public_boundary_cleanup.sql'), 'utf8');
check('append-only migration revokes the obsolete settings-table grant',
  /revoke select on table public\.site_settings from anon/i.test(boundaryMigration));
check('migration proves the canonical configuration remains readable',
  /public_site_configuration[\s\S]*canonical public configuration is dark/i.test(boundaryMigration));

console.log(`\n${failed ? '✘' : '✔'} public boundary parity — ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
