/* Entry point for the client wire-contract test: re-exports the PRODUCTION
 * singleton write paths so they can be bundled and executed against a
 * recording fetch stub. Nothing here is shipped to users. */
export { saveWebsiteStudio } from '../../src/lib/registries';
export { saveLaunchSettings } from '../../src/lib/launchSettings';
