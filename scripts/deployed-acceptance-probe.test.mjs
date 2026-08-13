#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  expectedMigrationLedger,
  parseLedgerRows,
  compareExactMigrationLedger,
  obtainProbeAccessToken,
} from './lib/deployed-probe.mjs';

let pass = 0;
const test = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
};

const manifest = {
  migration_count: 2,
  _migration_order: ['supabase/schema.FRESH-INSTALL-ONLY.sql', 'supabase/seed.sql', 'supabase/migration_a.sql', 'supabase/migration_b.sql'],
  migrations: {
    'supabase/schema.FRESH-INSTALL-ONLY.sql': 'f'.repeat(64),
    'supabase/seed.sql': 'e'.repeat(64),
    'supabase/migration_a.sql': 'a'.repeat(64),
    'supabase/migration_b.sql': 'b'.repeat(64),
  },
};

await test('manifest extracts only ordered migrations', () => {
  assert.deepEqual(expectedMigrationLedger(manifest), [
    { filename: 'supabase/migration_a.sql', checksum: 'a'.repeat(64), ordinal: 0 },
    { filename: 'supabase/migration_b.sql', checksum: 'b'.repeat(64), ordinal: 1 },
  ]);
});
await test('manifest count mismatch fails closed', () => {
  assert.throws(() => expectedMigrationLedger({ ...manifest, migration_count: 3 }), /migration_count/);
});
await test('ledger rows parse with ordinal', () => {
  assert.equal(parseLedgerRows([`supabase/migration_a.sql\t${'a'.repeat(64)}\t0`])[0].ordinal, 0);
});
await test('exact matching ledger passes', () => {
  const expected = expectedMigrationLedger(manifest);
  assert.equal(compareExactMigrationLedger(expected, structuredClone(expected)).ok, true);
});
for (const [name, mutate, pattern] of [
  ['missing migration fails', (rows) => rows.slice(0, 1), /missing|row count/],
  ['extra migration fails', (rows) => [...rows, { filename: 'supabase/migration_x.sql', checksum: 'c'.repeat(64), ordinal: 2 }], /unexpected|row count/],
  ['checksum mismatch fails', (rows) => rows.map((r, i) => i ? { ...r, checksum: 'c'.repeat(64) } : r), /checksum mismatch/],
  ['ordinal mismatch fails', (rows) => rows.map((r, i) => i ? { ...r, ordinal: 7 } : r), /ordinal mismatch/],
]) {
  await test(name, () => {
    const expected = expectedMigrationLedger(manifest);
    const result = compareExactMigrationLedger(expected, mutate(structuredClone(expected)));
    assert.equal(result.ok, false);
    assert.match(result.issues.join(' | '), pattern);
  });
}
await test('explicit JWT is accepted without sign-in', async () => {
  const got = await obtainProbeAccessToken({ apiUrl: 'https://x.test', anonKey: 'anon', explicitJwt: 'jwt', fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.deepEqual(got, { token: 'jwt', source: 'explicit-jwt' });
});
await test('password sign-in returns access token', async () => {
  const got = await obtainProbeAccessToken({
    apiUrl: 'https://x.test', anonKey: 'anon', email: 'staff@example.test', password: 'pw',
    fetchImpl: async (url, init) => {
      assert.match(url, /auth\/v1\/token\?grant_type=password$/);
      assert.equal(JSON.parse(init.body).email, 'staff@example.test');
      return new Response(JSON.stringify({ access_token: 'live-token' }), { status: 200 });
    },
  });
  assert.equal(got.token, 'live-token');
});
await test('missing probe credentials fails closed', async () => {
  await assert.rejects(() => obtainProbeAccessToken({ apiUrl: 'https://x.test', anonKey: 'anon' }), /MP_PROBE_EMAIL/);
});
await test('failed sign-in fails closed', async () => {
  await assert.rejects(() => obtainProbeAccessToken({
    apiUrl: 'https://x.test', anonKey: 'anon', email: 'x', password: 'bad',
    fetchImpl: async () => new Response('{"error":"bad"}', { status: 400 }),
  }), /sign-in failed/);
});


await test('live probe keeps the DB URL out of the psql argv', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('scripts/deployed-acceptance-probe.mjs', 'utf8');
  assert.doesNotMatch(source, /execFileSync\('psql',[\s\S]{0,180}DB_URL/);
  assert.match(source, /PGPASSFILE/);
  assert.match(source, /mode: 0o600/);
});

if (!process.exitCode) console.log(`DEPLOYED PROBE CONTRACT — ${pass}/${pass} passed`);
