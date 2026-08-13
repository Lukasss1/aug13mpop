import { createPrivateKey } from 'node:crypto';
import { parseAndValidateSupabaseDbUrl } from './supabase-db-target.mjs';

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BASE32 = /^[A-Z2-7]+=*$/i;
const JWT = /^[^.\s]+\.[^.\s]+\.[^.\s]+$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const RELEASE_SECRET_NAMES = Object.freeze([
  'MP_SIGNING_KEY_TEXT',
  'SUPABASE_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_DB_URL',
  'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'PROBE_USER_EMAIL', 'PROBE_USER_PASSWORD',
  'PRODUCTION_OWNER_EMAIL', 'PRODUCTION_OWNER_PASSWORD', 'PRODUCTION_OWNER_TOTP_SECRET',
  'NETLIFY_AUTH_TOKEN', 'NETLIFY_SITE_ID',
]);

export const RELEASE_VAR_NAMES = Object.freeze([
  'MP_SITE_DOMAIN', 'MP_SUPABASE_PROJECT_REF', 'TURNSTILE_SERVER_ENABLED',
  'TURNSTILE_SECRET_SET', 'FORM_ALLOWED_ORIGINS_SET', 'CV_ALLOWED_ORIGINS_SET',
  'EMAIL_ALLOWED_ORIGINS_SET', 'NOTIFICATION_RECIPIENT_SET', 'VITE_MEDIA_V2',
  'MEDIA_BACKEND_READY', 'MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER',
]);

export const COMMISSIONING_RECOVERY_SECRET_NAMES = Object.freeze([
  'SUPABASE_URL', 'SUPABASE_DB_URL',
]);

export const COMMISSIONING_BASE_SECRET_NAMES = Object.freeze([
  'SUPABASE_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_DB_URL',
  'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
]);

export const COMMISSIONING_ACCEPTANCE_SECRET_NAMES = Object.freeze([
  'PROBE_USER_EMAIL', 'PROBE_USER_PASSWORD',
  'PRODUCTION_OWNER_EMAIL', 'PRODUCTION_OWNER_PASSWORD', 'PRODUCTION_OWNER_TOTP_SECRET',
]);

export function clean(value) { return String(value ?? '').trim(); }

export function requireValues(env, names, label = 'production inputs') {
  const missing = names.filter((name) => !clean(env[name]));
  if (missing.length) throw new Error(`${label} missing: ${missing.join(', ')}`);
}

export function validateProjectRef(value) {
  const ref = clean(value);
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error('MP_SUPABASE_PROJECT_REF must be an exact 20-character lowercase project ref');
  return ref;
}

export function validateSiteDomain(value) {
  const domain = clean(value).toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(domain)) throw new Error('MP_SITE_DOMAIN must be a bare valid hostname');
  return domain;
}

export function validateSupabaseUrl(value, ref, label = 'SUPABASE_URL') {
  let u;
  try { u = new URL(clean(value)); } catch { throw new Error(`${label} is not a valid URL`); }
  if (u.protocol !== 'https:' || u.hostname !== `${ref}.supabase.co` || !['', '/'].includes(u.pathname) || u.search || u.hash) {
    throw new Error(`${label} does not match the protected Supabase project ref`);
  }
  return u.toString();
}

export function validateLegacyJwt(value, label) {
  const token = clean(value);
  if (token.startsWith('sb_') || !JWT.test(token)) {
    throw new Error(`${label} must be the legacy JWT-shaped key for this release`);
  }
  return token;
}

export function validateSupabaseDbUrl(value, ref) {
  return parseAndValidateSupabaseDbUrl(clean(value), ref);
}

export function validateTotpSecret(value, label = 'production owner TOTP secret') {
  const normalized = clean(value).replace(/\s+/g, '').replace(/-+/g, '');
  if (normalized.length < 16 || !BASE32.test(normalized)) throw new Error(`${label} must be Base32-shaped and at least 16 characters`);
  return normalized.toUpperCase();
}

export function validateEmail(value, label) {
  const email = clean(value);
  if (!EMAIL.test(email)) throw new Error(`${label} must be an email address`);
  return email;
}

export function validateExplicitBoolean(value, label) {
  const v = clean(value);
  if (v !== 'true' && v !== 'false') throw new Error(`${label} must be explicitly true or false`);
  return v === 'true';
}

export function validateEd25519PrivateKeyPem(value, label = 'MP_SIGNING_KEY_TEXT') {
  const pem = String(value ?? '').trim();
  let key;
  try { key = createPrivateKey(pem); } catch { throw new Error(`${label} must be a readable PEM private key`); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${label} must be an Ed25519 private key`);
  return true;
}

export function validateRecoverySupabaseInputs(env) {
  const ref = validateProjectRef(env.MP_SUPABASE_PROJECT_REF);
  validateSupabaseUrl(env.SUPABASE_URL, ref);
  validateSupabaseDbUrl(env.SUPABASE_DB_URL, ref);
  return ref;
}

export function validateSharedSupabaseInputs(env) {
  const ref = validateProjectRef(env.MP_SUPABASE_PROJECT_REF);
  validateSupabaseUrl(env.SUPABASE_URL, ref);
  validateSupabaseDbUrl(env.SUPABASE_DB_URL, ref);
  validateLegacyJwt(env.SUPABASE_ANON_KEY, 'SUPABASE_ANON_KEY');
  validateLegacyJwt(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
  return ref;
}


export function validateLiveAcceptanceReadiness(env) {
  const domain = validateSiteDomain(env.MP_SITE_DOMAIN);
  const turnstileEnabled = validateExplicitBoolean(env.TURNSTILE_SERVER_ENABLED, 'TURNSTILE_SERVER_ENABLED');
  const turnstileSecretSet = validateExplicitBoolean(env.TURNSTILE_SECRET_SET, 'TURNSTILE_SECRET_SET');
  const formOriginsSet = validateExplicitBoolean(env.FORM_ALLOWED_ORIGINS_SET, 'FORM_ALLOWED_ORIGINS_SET');
  const cvOriginsSet = validateExplicitBoolean(env.CV_ALLOWED_ORIGINS_SET, 'CV_ALLOWED_ORIGINS_SET');
  const emailOriginsSet = validateExplicitBoolean(env.EMAIL_ALLOWED_ORIGINS_SET, 'EMAIL_ALLOWED_ORIGINS_SET');
  const notificationRecipientSet = validateExplicitBoolean(env.NOTIFICATION_RECIPIENT_SET, 'NOTIFICATION_RECIPIENT_SET');
  const mediaV2 = validateExplicitBoolean(env.VITE_MEDIA_V2, 'VITE_MEDIA_V2');
  const mediaBackendReady = validateExplicitBoolean(env.MEDIA_BACKEND_READY, 'MEDIA_BACKEND_READY');
  const siteKey = clean(env.VITE_TURNSTILE_SITE_KEY);

  if (!formOriginsSet || !cvOriginsSet || !emailOriginsSet) {
    throw new Error('FORM_ALLOWED_ORIGINS_SET, CV_ALLOWED_ORIGINS_SET and EMAIL_ALLOWED_ORIGINS_SET must all be true before live acceptance');
  }
  if (!notificationRecipientSet) {
    throw new Error('NOTIFICATION_RECIPIENT_SET must be true before live acceptance');
  }
  if (turnstileEnabled !== turnstileSecretSet) {
    throw new Error('TURNSTILE_SERVER_ENABLED and TURNSTILE_SECRET_SET must agree');
  }
  if (turnstileEnabled !== (siteKey.length > 0)) {
    throw new Error('VITE_TURNSTILE_SITE_KEY presence must match TURNSTILE_SERVER_ENABLED');
  }
  if (mediaV2 && !mediaBackendReady) {
    throw new Error('MEDIA_BACKEND_READY must be true before VITE_MEDIA_V2 can be enabled');
  }
  return { domain, turnstileEnabled, mediaV2 };
}

export function validateReleaseInputs(env) {
  requireValues(env, [...RELEASE_SECRET_NAMES, ...RELEASE_VAR_NAMES], 'PRODUCTION RELEASE INPUTS FAIL —');
  validateSharedSupabaseInputs(env);
  validateSiteDomain(env.MP_SITE_DOMAIN);
  validateEd25519PrivateKeyPem(env.MP_SIGNING_KEY_TEXT);
  validateEmail(env.PROBE_USER_EMAIL, 'PROBE_USER_EMAIL');
  validateEmail(env.PRODUCTION_OWNER_EMAIL, 'PRODUCTION_OWNER_EMAIL');
  validateTotpSecret(env.PRODUCTION_OWNER_TOTP_SECRET, 'PRODUCTION_OWNER_TOTP_SECRET');
  validateLiveAcceptanceReadiness(env);
  validateExplicitBoolean(env.MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER, 'MP_ALLOW_FIRST_DEPLOY_WITHOUT_MARKER');
  return { secretCount: RELEASE_SECRET_NAMES.length, varCount: RELEASE_VAR_NAMES.length };
}

export function validateCommissioningInputs(env, mode) {
  const m = clean(mode);
  const modes = new Set(['verify-only', 'recover-known-partial', 'fresh', 'resume', 'adopt', 'upgrade']);
  if (!modes.has(m)) throw new Error(`unsupported commissioning mode: ${m || '(unset)'}`);
  const recoveryOnly = m === 'recover-known-partial';
  const identitiesRequired = !['recover-known-partial', 'fresh', 'resume'].includes(m);
  const required = recoveryOnly
    ? [...COMMISSIONING_RECOVERY_SECRET_NAMES]
    : identitiesRequired
      ? [...COMMISSIONING_BASE_SECRET_NAMES, ...COMMISSIONING_ACCEPTANCE_SECRET_NAMES]
      : [...COMMISSIONING_BASE_SECRET_NAMES];
  requireValues(env, [...required, 'MP_SUPABASE_PROJECT_REF'], 'PRODUCTION COMMISSION INPUTS FAIL —');
  if (recoveryOnly) validateRecoverySupabaseInputs(env);
  else validateSharedSupabaseInputs(env);
  if (identitiesRequired) {
    validateEmail(env.PROBE_USER_EMAIL, 'PROBE_USER_EMAIL');
    validateEmail(env.PRODUCTION_OWNER_EMAIL, 'PRODUCTION_OWNER_EMAIL');
    validateTotpSecret(env.PRODUCTION_OWNER_TOTP_SECRET, 'PRODUCTION_OWNER_TOTP_SECRET');
    validateLiveAcceptanceReadiness(env);
  }
  return { requiredCount: required.length, identitiesRequired };
}
