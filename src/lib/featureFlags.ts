// ============================================================================
//  MILK POP — feature flags (Patch Spec §19)
//
//  Build-time flags (VITE_*) gate the parts of the patch whose live gates
//  have not yet passed. Flags default to the SAFE state when unset.
//  Deviation recorded in the phase report: PUBLIC_FORMS_V2 is not flagged —
//  the WP02.1 server contract is backward compatible (keyless/hashless
//  clients keep working), so rollback is an ordinary redeploy and a client
//  flag would only double the code paths.
// ============================================================================

/** Media pipeline v2 (upload → pending → attach). OFF = image uploads are
 *  disabled with an honest message; existing images keep rendering. Never
 *  falls back to Base64. */
export const MEDIA_V2 = String(import.meta.env.VITE_MEDIA_V2 || '').trim() === 'true';

/** Careers CV upload UI. OPT-01: defaults OFF — set VITE_CAREERS_CV_UPLOAD=true
 *  only after the live Careers+CV staging E2E gate passes (the env validator
 *  additionally requires the CAREERS_CV_E2E_PASSED=true marker in production).
 *  OFF hides only the CV field; the careers application form itself keeps
 *  working end-to-end without an attachment. */
export const CAREERS_CV_UPLOAD = String(import.meta.env.VITE_CAREERS_CV_UPLOAD || '').trim() === 'true';

/** Legacy browser→cloud data import (one-time migration utility, C1.3). OFF by
 *  default — this is a MIGRATION tool, not a continuing business feature. Even
 *  when ON it only becomes visible, and only to an OWNER, when legacy
 *  localStorage data is actually detected (see launchFeatures.isAdminSectionVisible).
 *  Set VITE_LEGACY_IMPORT=true only while performing a migration, then unset it. */
export const LEGACY_IMPORT = String(import.meta.env.VITE_LEGACY_IMPORT || '').trim() === 'true';

/** Verified, monitored fallback contact address shown to a customer ONLY after a
 *  genuine contact-form submission failure (C1.3, finding #6). Blank by default —
 *  the site never invents an inbox. When set in production the deployment
 *  validator requires it to be a syntactically valid address. Never rendered
 *  unless a real submission has failed. */
export const CONFIRMED_CONTACT_EMAIL = String(import.meta.env.VITE_CONFIRMED_CONTACT_EMAIL || '').trim();
