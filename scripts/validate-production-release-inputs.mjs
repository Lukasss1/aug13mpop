#!/usr/bin/env node
/** Fail before any production release mutation when protected inputs are absent or incoherent. */
import { validateReleaseInputs } from './lib/production-inputs.mjs';

try {
  const { secretCount, varCount } = validateReleaseInputs(process.env);
  console.log(`PRODUCTION RELEASE INPUTS PASS — ${secretCount} protected secrets and ${varCount} protected variables are present, typed and target-bound (values not printed)`);
} catch (error) {
  console.error(`PRODUCTION RELEASE INPUTS FAIL — ${error.message}`);
  process.exit(1);
}
