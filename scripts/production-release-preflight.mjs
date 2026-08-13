#!/usr/bin/env node
/**
 * Fail-fast production release preflight.
 *
 * This runs before the expensive release seal. It validates that the release
 * is aimed at the approved production site/backend, that the external trust
 * policy is no longer a template, and that the CI private signing key matches
 * the public key pinned in that policy. It then delegates feature/CORS/
 * Turnstile coherence to validate-deployment-env.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keyFingerprint } from './lib/release-signature.mjs';
import { validateLegacyJwt, validateProjectRef, validateSiteDomain, validateSupabaseUrl } from './lib/production-inputs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const deferCiSigningKey = process.argv.includes('--defer-ci-signing-key');
const deferCiReleaseMetadata = process.argv.includes('--defer-ci-release-metadata');
const failures = [];
const checks = [];

const pass = (name, detail = '') => checks.push({ ok: true, name, detail });
const fail = (name, detail) => {
  checks.push({ ok: false, name, detail });
  failures.push(`${name}: ${detail}`);
};
const required = (name) => {
  const value = String(env[name] ?? '').trim();
  if (!value) fail(name, 'required value is missing');
  return value;
};
const insideRoot = (candidate) => {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
};

const identity = required('MP_RELEASE_IDENTITY');
if (identity) {
  /^[A-Za-z0-9._-]+$/.test(identity)
    ? pass('release identity is filesystem-safe', identity)
    : fail('release identity is filesystem-safe', identity);
}

const releaseRaw = String(env.MP_RELEASE_NUMBER ?? '').trim();
const releaseNumber = Number(releaseRaw);
if (!releaseRaw) {
  if (deferCiReleaseMetadata) pass('release number verification is deferred to the protected release workflow');
  else fail('MP_RELEASE_NUMBER', 'required value is missing');
} else {
  Number.isSafeInteger(releaseNumber) && releaseNumber > 0
    ? pass('release number is a positive safe integer', releaseRaw)
    : fail('release number is a positive safe integer', releaseRaw);
}

const commit = String(env.MP_GIT_COMMIT ?? '').trim();
if (!commit) {
  if (deferCiReleaseMetadata) pass('git commit verification is deferred to the protected release workflow');
  else fail('MP_GIT_COMMIT', 'required value is missing');
} else {
  /^[0-9a-f]{40}$/.test(commit)
    ? pass('git commit is an exact lowercase 40-character revision', commit.slice(0, 12))
    : fail('git commit is an exact lowercase 40-character revision', commit);
}

let domain = '';
const domainRaw = required('MP_SITE_DOMAIN');
if (domainRaw) {
  try { domain = validateSiteDomain(domainRaw); pass('site domain is a bare valid hostname', domain); }
  catch (error) { fail('site domain is a bare valid hostname', error.message); }
}

let projectRef = '';
const projectRefRaw = required('MP_SUPABASE_PROJECT_REF');
if (projectRefRaw) {
  try { projectRef = validateProjectRef(projectRefRaw); pass('Supabase project ref has the exact protected shape', projectRef); }
  catch (error) { fail('Supabase project ref has the exact protected shape', error.message); }
}

const supabaseUrlRaw = required('VITE_SUPABASE_URL');
if (supabaseUrlRaw && projectRef) {
  try { validateSupabaseUrl(supabaseUrlRaw, projectRef, 'VITE_SUPABASE_URL'); pass('Supabase URL matches the approved project ref', `${projectRef}.supabase.co`); }
  catch (error) { fail('Supabase URL matches the approved project ref', error.message); }
}
const anonKey = required('VITE_SUPABASE_ANON_KEY');
if (anonKey) {
  const placeholder = /(?:REPLACE(?:[_\s-]*WITH)?|CHANGE[_\s-]*ME|CHANGEME|YOUR[_\s-]+(?:KEY|VALUE))/i.test(anonKey);
  if (placeholder) {
    fail('Supabase anon key is not a template placeholder', 'template marker remains');
  } else {
    try { validateLegacyJwt(anonKey, 'VITE_SUPABASE_ANON_KEY'); pass('Supabase anon key matches this release legacy JWT contract'); }
    catch (error) { fail('Supabase anon key matches this release legacy JWT contract', error.message); }
  }
}

const siteUrlRaw = required('SITE_URL');
if (siteUrlRaw && domain) {
  try {
    const u = new URL(siteUrlRaw);
    const ok = u.protocol === 'https:' && u.hostname.toLowerCase() === domain
      && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
    ok
      ? pass('SITE_URL matches the approved HTTPS domain', u.origin)
      : fail('SITE_URL matches the approved HTTPS domain', siteUrlRaw);
  } catch {
    fail('SITE_URL matches the approved HTTPS domain', 'not a valid URL');
  }
}

const viteIdentity = required('VITE_RELEASE_IDENTITY');
if (identity && viteIdentity) {
  viteIdentity === identity
    ? pass('browser release identity matches the sealed identity')
    : fail('browser release identity matches the sealed identity', `${viteIdentity} != ${identity}`);
}
if (String(env.VITE_DEPLOYMENT_MODE ?? '').trim() !== 'production') {
  fail('deployment mode is production', String(env.VITE_DEPLOYMENT_MODE ?? '(unset)'));
} else pass('deployment mode is production');

const evidenceRaw = required('MP_EVIDENCE_DOC');
if (evidenceRaw) {
  const evidence = path.resolve(root, evidenceRaw);
  if (!insideRoot(evidence)) fail('evidence document remains inside the repository', evidenceRaw);
  else if (!fs.existsSync(evidence) || !fs.statSync(evidence).isFile()) fail('evidence document exists', evidenceRaw);
  else {
    pass('evidence document remains inside the repository', evidenceRaw);
    pass('evidence document exists', evidenceRaw);
  }
}

const trustRaw = required('MP_TRUST_POLICY');
let trust;
let trustPath;
if (trustRaw) {
  trustPath = path.resolve(root, trustRaw);
  try {
    trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
    pass('trust policy is readable JSON', path.relative(root, trustPath));
  } catch (error) {
    fail('trust policy is readable JSON', error.message);
  }
}

if (trust) {
  const serialized = JSON.stringify(trust);
  if (/REPLACE-WITH/i.test(serialized)) fail('trust policy contains no template placeholders', 'REPLACE-WITH remains');
  else pass('trust policy contains no template placeholders');

  trust.key_purpose === 'production'
    ? pass('trust key purpose is production')
    : fail('trust key purpose is production', String(trust.key_purpose));

  String(trust.approved_site_domain ?? '').toLowerCase().replace(/\.$/, '') === domain
    ? pass('trust policy approves this site domain', domain)
    : fail('trust policy approves this site domain', String(trust.approved_site_domain));

  String(trust.approved_supabase_project_ref ?? '') === projectRef
    ? pass('trust policy approves this Supabase project', projectRef)
    : fail('trust policy approves this Supabase project', String(trust.approved_supabase_project_ref));

  const minimum = trust.minimum_release_number;
  if (!Number.isSafeInteger(minimum) || minimum < 1) {
    fail('trust minimum release number is a positive integer', String(minimum));
  } else if (!releaseRaw && deferCiReleaseMetadata) {
    pass('anti-rollback release-number check is deferred to the protected release workflow', `minimum ${minimum}`);
  } else if (Number.isSafeInteger(releaseNumber) && releaseNumber >= minimum) {
    pass('release number satisfies anti-rollback policy', `${releaseNumber} >= ${minimum}`);
  } else if (Number.isSafeInteger(releaseNumber)) {
    fail('release number satisfies anti-rollback policy', `${releaseNumber} < ${minimum}`);
  }

  const pem = String(trust.ed25519_public_key_pem ?? '');
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(`expected ed25519, got ${key.asymmetricKeyType}`);
    pass('trust policy contains a valid Ed25519 public key', keyFingerprint(pem).slice(0, 16));
  } catch (error) {
    fail('trust policy contains a valid Ed25519 public key', error.message);
  }
}

const signingRaw = String(env.MP_SIGNING_KEY ?? '').trim();
if (!signingRaw) {
  if (deferCiSigningKey) {
    pass('private signing key verification is deferred to the protected release workflow');
  } else {
    fail('MP_SIGNING_KEY', 'required value is missing');
  }
} else if (trust?.ed25519_public_key_pem) {
  const signingPath = path.resolve(signingRaw);
  try {
    const privatePem = fs.readFileSync(signingPath, 'utf8');
    const privateKey = createPrivateKey(privatePem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`expected ed25519, got ${privateKey.asymmetricKeyType}`);
    const derivedPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const derived = keyFingerprint(derivedPem);
    const trusted = keyFingerprint(trust.ed25519_public_key_pem);
    if (derived !== trusted) throw new Error(`private/public key mismatch (${derived.slice(0, 16)} != ${trusted.slice(0, 16)})`);
    pass('private signing key matches the pinned public key', derived.slice(0, 16));
  } catch (error) {
    fail('private signing key matches the pinned public key', error.message);
  }
}

for (const c of checks) console.log(`[release-preflight] ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);

if (!failures.length) {
  try {
    execFileSync(process.execPath, [path.join(root, 'scripts/validate-deployment-env.mjs')], {
      cwd: root,
      env: { ...env, MP_REQUIRE_PRODUCTION_MODE: '1' },
      stdio: 'inherit',
    });
    console.log('[release-preflight] PASS  deployment environment validator');
  } catch (error) {
    failures.push(`deployment environment validator exited ${error.status ?? 1}`);
  }
}

if (failures.length) {
  console.error(`[release-preflight] ✖ ${failures.length} blocking production release problem(s).`);
  process.exit(1);
}
console.log('[release-preflight] ✔ production release inputs are coherent and externally bound.');
