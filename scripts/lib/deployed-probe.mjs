/** Pure helpers for the live deployed acceptance probe. */

export function expectedMigrationLedger(manifest) {
  const order = Array.isArray(manifest?._migration_order) ? manifest._migration_order : [];
  const hashes = manifest?.migrations && typeof manifest.migrations === 'object'
    ? manifest.migrations
    : {};
  const files = order.filter((file) => /^supabase\/migration_[^/]+\.sql$/.test(String(file)));
  if (!files.length) throw new Error('release manifest contains no ordered migration files');
  if (Number(manifest.migration_count) !== files.length) {
    throw new Error(`manifest migration_count=${manifest.migration_count} but ordered migration files=${files.length}`);
  }
  return files.map((filename, ordinal) => {
    const checksum = hashes[filename];
    if (!/^[a-f0-9]{64}$/i.test(String(checksum || ''))) {
      throw new Error(`manifest checksum missing/invalid for ${filename}`);
    }
    return { filename, checksum: String(checksum).toLowerCase(), ordinal };
  });
}

export function parseLedgerRows(lines) {
  return lines.map((line) => {
    const parts = String(line).split('\t');
    if (parts.length !== 3) throw new Error(`invalid ledger row: ${line}`);
    const [filename, checksum, ordinalText] = parts;
    const ordinal = Number(ordinalText);
    if (!filename || !/^[a-f0-9]{64}$/i.test(checksum) || !Number.isInteger(ordinal) || ordinal < 0) {
      throw new Error(`invalid ledger row: ${line}`);
    }
    return { filename, checksum: checksum.toLowerCase(), ordinal };
  });
}

export function compareExactMigrationLedger(expected, deployed) {
  const issues = [];
  const expectedByFile = new Map(expected.map((row) => [row.filename, row]));
  const deployedByFile = new Map();

  for (const row of deployed) {
    if (deployedByFile.has(row.filename)) issues.push(`duplicate deployed row: ${row.filename}`);
    deployedByFile.set(row.filename, row);
  }

  for (const row of expected) {
    const actual = deployedByFile.get(row.filename);
    if (!actual) {
      issues.push(`missing: ${row.filename}`);
      continue;
    }
    if (actual.checksum !== row.checksum) {
      issues.push(`checksum mismatch: ${row.filename}`);
    }
    if (actual.ordinal !== row.ordinal) {
      issues.push(`ordinal mismatch: ${row.filename} expected ${row.ordinal} got ${actual.ordinal}`);
    }
  }

  for (const row of deployed) {
    if (!expectedByFile.has(row.filename)) issues.push(`unexpected: ${row.filename}`);
  }

  if (deployed.length !== expected.length) {
    issues.push(`row count mismatch: expected ${expected.length}, got ${deployed.length}`);
  }

  return { ok: issues.length === 0, issues };
}

export async function obtainProbeAccessToken({ apiUrl, anonKey, explicitJwt, email, password, fetchImpl = fetch }) {
  if (explicitJwt) return { token: explicitJwt, source: 'explicit-jwt' };
  if (!email || !password) {
    throw new Error('set MP_PROBE_EMAIL and MP_PROBE_PASSWORD (or MP_PROBE_JWT) for a real low-role account');
  }
  const res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* handled below */ }
  if (!res.ok || !body?.access_token) {
    throw new Error(`probe user sign-in failed: HTTP ${res.status}${text ? ` ${text.slice(0, 180)}` : ''}`);
  }
  return { token: body.access_token, source: 'password-sign-in' };
}
