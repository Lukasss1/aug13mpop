#!/usr/bin/env node
/** Shared semantic gate for protected production backend commissioning inputs. */
import { validateCommissioningInputs } from './lib/production-inputs.mjs';
const mode = process.argv[2] || process.env.MODE || '';
try {
  const result = validateCommissioningInputs(process.env, mode);
  console.log(`PRODUCTION COMMISSION INPUTS PASS — mode=${mode}; ${result.requiredCount} protected secrets present and target-bound; identities_required=${result.identitiesRequired}`);
} catch (error) {
  console.error(`PRODUCTION COMMISSION INPUTS FAIL — ${error.message}`);
  process.exit(1);
}
