import fs from 'node:fs';
import path from 'node:path';

export function parseDotEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadLocalPublicPreflightEnv(root, processEnvironment = process.env) {
  const files = ['.env', '.env.production', '.env.local', '.env.production.local'];
  const fromFiles = Object.assign({}, ...files.map((file) => parseDotEnv(path.join(root, file))));

  if (String(fromFiles.MP_SIGNING_KEY ?? '').trim()) {
    throw new Error('MP_SIGNING_KEY must not be stored in a local dotenv file; keep it only in the protected GitHub production environment');
  }

  const merged = { ...fromFiles, ...processEnvironment };
  if (String(merged.MP_SIGNING_KEY ?? '').trim()) {
    throw new Error('MP_SIGNING_KEY is not accepted by local public preflight; keep it only in the protected GitHub production environment');
  }
  // These values are allocated and verified by the protected workflow. Ignore
  // any ambient shell leftovers so the local command cannot accidentally
  // masquerade as the CI release-authority check.
  delete merged.MP_RELEASE_NUMBER;
  delete merged.MP_GIT_COMMIT;
  delete merged.MP_SIGNING_KEY;

  merged.VITE_DEPLOYMENT_MODE ||= 'production';
  merged.MP_EVIDENCE_DOC ||= 'CURRENT-RELEASE-EVIDENCE.md';
  merged.MP_TRUST_POLICY ||= 'ops/milkpop-trust-policy.json';

  const sourceIdentity = String(parseDotEnv(path.join(root, '.env.example')).VITE_RELEASE_IDENTITY ?? '').trim();
  merged.MP_RELEASE_IDENTITY ||= sourceIdentity;
  merged.VITE_RELEASE_IDENTITY ||= sourceIdentity;

  const trustPath = path.resolve(root, merged.MP_TRUST_POLICY);
  if (fs.existsSync(trustPath)) {
    try {
      const trust = JSON.parse(fs.readFileSync(trustPath, 'utf8'));
      merged.MP_SITE_DOMAIN ||= String(trust.approved_site_domain ?? '').trim();
      merged.MP_SUPABASE_PROJECT_REF ||= String(trust.approved_supabase_project_ref ?? '').trim();
    } catch {
      // The strict production preflight reports malformed policy JSON clearly.
    }
  }

  if (merged.MP_SITE_DOMAIN) merged.SITE_URL ||= `https://${merged.MP_SITE_DOMAIN}`;
  if (merged.MP_SUPABASE_PROJECT_REF && !/REPLACE-WITH/i.test(merged.MP_SUPABASE_PROJECT_REF)) {
    merged.VITE_SUPABASE_URL ||= `https://${merged.MP_SUPABASE_PROJECT_REF}.supabase.co`;
  }

  return merged;
}
