/* SMALL-BIZ CLOSURE — entry point for the hydration behavioural suite.
 * Re-exports the PRODUCTION hydration and error-classification paths so they
 * can be bundled exactly as Vite bundles them and EXECUTED against a
 * recording fetch stub. Nothing here is shipped to users; nothing is
 * reimplemented — the code under test is the real one.
 *
 * Why this exists: §9 says "do not rely only on source-text assertions where a
 * behavioural test is practical." A source pin proves hydrateStaffData LOOKS
 * like it fails honestly. Only running it against a 401 / 403 / 500 / garbage
 * response proves what it DOES. */
export { hydrateStaffData, RegistryError, registryErrorMessage, authedRest } from '../../src/lib/registries';
