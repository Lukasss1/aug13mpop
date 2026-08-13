/**
 * publish-rules.test.ts — behavioural tests for the shared publication rules
 * that Admin and the public site both use (src/lib/publishRules.ts).
 *
 * Covers the exact scenarios the false-data audit asked for:
 *   • incomplete new store rejected
 *   • incomplete edited store rejected (any status)
 *   • open store losing required info is no longer "complete" (→ downgraded)
 *   • store without a real name is not online-eligible
 *   • closed store is labelled "Closed", not "Coming Soon"
 *   • vacancy containing "N/A" (or blanks) is rejected
 *
 * Run: npm run test:publish-rules
 */
import {
  isReal,
  hasRealStoreIdentity,
  isCompletePublicStore,
  isPublishableVacancy,
  publicStoreStatusLabel,
} from '../src/lib/publishRules';

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`\u2714 ${name}`); }
  else { failed++; console.error(`\u2716 ${name}`); }
};

const store = (o: Partial<Record<string, string>> = {}) => ({
  name: 'Milk Pop Central', address: '1 High St', postcode: 'B1 1AA',
  openingHours: 'Mon–Sat 09:00–21:00', status: 'coming_soon', ...o,
});
const vac = (o: Partial<Record<string, string>> = {}) => ({
  title: 'Barista', location: 'Birmingham', salary: '£12/hr',
  roleDescription: 'Make great shakes', type: 'Part-time', ...o,
});

// isReal: the placeholder guard
check('isReal("") is false', isReal('') === false);
check('isReal("   ") is false', isReal('   ') === false);
check('isReal("N/A") is false', isReal('N/A') === false);
check('isReal("n/a") is false', isReal('n/a') === false);
check('isReal(undefined) is false', isReal(undefined) === false);
check('isReal("Solihull") is true', isReal('Solihull') === true);

// 1 & 2: incomplete store identity rejected (create AND edit use this)
check('complete store has real identity', hasRealStoreIdentity(store()) === true);
check('blank name rejected', hasRealStoreIdentity(store({ name: '' })) === false);
check('N/A address rejected', hasRealStoreIdentity(store({ address: 'N/A' })) === false);
check('blank postcode rejected', hasRealStoreIdentity(store({ postcode: '' })) === false);

// 3: open store losing hours is no longer complete (→ downgrade to coming_soon)
check('complete store is online-eligible', isCompletePublicStore(store()) === true);
check('store with blank hours is NOT online-eligible', isCompletePublicStore(store({ openingHours: '' })) === false);
check('store with N/A hours is NOT online-eligible', isCompletePublicStore(store({ openingHours: 'N/A' })) === false);

// 4: store without a real name cannot be set online
check('store with blank name is NOT online-eligible', isCompletePublicStore(store({ name: '' })) === false);
check('store with N/A name is NOT online-eligible', isCompletePublicStore(store({ name: 'N/A' })) === false);

// 5: accurate public status labelling
check('open → "Open"', publicStoreStatusLabel('open') === 'Open');
check('coming_soon → "Coming Soon"', publicStoreStatusLabel('coming_soon') === 'Coming Soon');
check('closed → "Closed" (not Coming Soon)', publicStoreStatusLabel('closed') === 'Closed');

// 6: vacancy completeness rejects blanks and "N/A"
check('complete vacancy is publishable', isPublishableVacancy(vac()) === true);
check('vacancy with N/A location rejected', isPublishableVacancy(vac({ location: 'N/A' })) === false);
check('vacancy with blank salary rejected', isPublishableVacancy(vac({ salary: '' })) === false);
check('vacancy with N/A role rejected', isPublishableVacancy(vac({ roleDescription: 'N/A' })) === false);
check('vacancy with invalid type rejected', isPublishableVacancy(vac({ type: 'Casual' })) === false);

console.log(`\n${failed ? '\u2716' : '\u2714'} publish-rules: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
