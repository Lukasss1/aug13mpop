#!/usr/bin/env node
/**
 * pos-contract.test.mjs — STATIC checks on the POS wire contract and the two
 * POS Edge Functions (Gate 5). Offline, zero-dependency, same style as
 * security-regression.test.mjs. The LIVE proof is scripts/pos-live-smoke.sh
 * against a local Postgres.
 *
 * Run: node scripts/pos-contract.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

let passed = 0, failed = 0;
const ok = (n) => { passed++; console.log(`\u2714 ${n}`); };
const fail = (n, d) => { failed++; console.error(`\u2716 ${n}\n    ${d}`); };
const check = (n, cond, d = '') => (cond ? ok(n) : fail(n, d));
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const sha = (s) => createHash('sha256').update(s).digest('hex');

const LIB = 'src/lib/posContract.ts';
const SHARED = 'supabase/functions/_shared/posContract.ts';
const PAIR = 'supabase/functions/pos-pair/index.ts';
const INGEST = 'supabase/functions/pos-ingest/index.ts';
for (const f of [LIB, SHARED, PAIR, INGEST]) {
  check(`${f} exists`, existsSync(f), 'file missing');
}
const lib = read(LIB), shared = read(SHARED), pair = read(PAIR), ingest = read(INGEST);

/* 1. D-11: the Deno copy of the contract is byte-identical to src/lib */
check('contract module: _shared copy is byte-identical to src/lib',
  lib.length > 0 && sha(lib) === sha(shared),
  'the two contract copies have drifted — regenerate the _shared copy');

/* 2. Frozen constants (contract §9) */
check('contract: frozen constants hold',
  /POS_CONTRACT_VERSION = 1 as const/.test(lib) &&
  /MAX_EVENTS_PER_BATCH = 50 as const/.test(lib) &&
  /PAIRING_CODE_LENGTH = 8 as const/.test(lib) &&
  /DEVICE_TOKEN_BYTES = 32 as const/.test(lib) &&
  /pair: '\/functions\/v1\/pos-pair'/.test(lib) &&
  /ingest: '\/functions\/v1\/pos-ingest'/.test(lib),
  'a frozen constant changed — that is a contract version bump');

/* 3. sale_completed stays off the wire (D-01) */
check('contract: sale_completed is not an entity event',
  /'order_created'/.test(lib) && !/'sale_completed'/.test(lib),
  'sale_completed appears in the wire contract');

/* 4. pos-ingest invariants */
check('pos-ingest: imports the shared contract module',
  /from '\.\.\/_shared\/posContract\.ts'/.test(ingest), 'not importing _shared copy');
check('pos-ingest: deployed without JWT verification (token is the credential)',
  /Deploy WITHOUT "Verify JWT"/.test(ingest), 'deployment note missing');
check('pos-ingest: only the token HASH reaches SQL',
  /sha256hex\(token\)/.test(ingest) && /p_token_hash/.test(ingest),
  'raw token appears to be sent to SQL');
check('pos-ingest: the raw token is never logged',
  !/console\.[a-z]+\([^)]*token/i.test(ingest),
  'a console call references the token');
check('pos-ingest: revoked devices get 401 and nothing applied',
  /device\.revoked === true/.test(ingest) && /401/.test(ingest),
  'revocation refusal missing');
check('pos-ingest: batch cap uses the contract constant with HTTP 413',
  /MAX_EVENTS_PER_BATCH/.test(ingest) && /413/.test(ingest),
  'batch cap not wired to the contract');
check('pos-ingest: verifies the ack partition invariant server-side',
  /partition invariant/i.test(ingest) && /seen\.size !== ids\.size/.test(ingest),
  'partition verification missing');

/* 5. pos-pair invariants */
check('pos-pair: deployed without JWT verification',
  /Deploy WITHOUT (?:"|')?Verify JWT(?:"|')?/.test(pair), 'deployment note missing');
check('pos-pair: only the code HASH reaches SQL',
  /sha256hex\(code\)/.test(pair) && /p_code_hash/.test(pair),
  'raw code appears to be sent to SQL');
check('pos-pair: one coarse refusal for unknown/expired/used codes',
  /result\.error === 'code_not_accepted'/.test(pair) && /That pairing code was not accepted/.test(pair) && !/result\.error === '(?:unknown|expired|used)'/.test(pair),
  'pairing-code state leaks through the response');
check('pos-pair: per-IP rate limit present',
  /RATE_IP_PER_HOUR/.test(pair) && /rpc\/pos_pair_attempt/.test(pair) && /p_limit: RATE_IP_PER_HOUR/.test(pair) && /rate_limited/.test(pair) && /429/.test(pair),
  'atomic rate reservation is not wired through pos_pair_attempt');
check('pos-pair: the plaintext token/code is never logged',
  !/console\.[a-z]+\([^)]*(deviceToken|\bcode\b)/i.test(pair),
  'a console call references the token or code');
check('pos-pair: 8-char alnum code shape enforced before SQL',
  /\^\[A-Z0-9\]\{8\}\$/.test(pair), 'code shape check missing');

/* 6. Gate 6 — cloud till-history reads (mandatory test #7's web half) */
const POSDATA = 'src/lib/posData.ts';
const TILLUI = 'src/components/admin/TillOrders.tsx';
for (const f of [POSDATA, TILLUI]) check(`${f} exists`, existsSync(f), 'file missing');
// Strip comments so the #7 check inspects code, not the annotations that
// intentionally name what is forbidden.
const stripC = (c) => c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const posData = read(POSDATA), tillUi = read(TILLUI);
const adminPanel = read('src/components/AdminPanel.tsx');
const adminNavigation = read('src/components/admin/adminNavigation.ts');
const launchFeatures = read('src/lib/launchFeatures.ts');
const appTsx = read('src/App.tsx');

check('till history: NO browser storage anywhere in the read path (#7)',
  !/localStorage|sessionStorage|indexedDB/i.test(stripC(posData)) &&
  !/localStorage|sessionStorage|indexedDB/i.test(stripC(tillUi)),
  'the cloud till-history path touches browser storage');
check('till history: reads are authenticated (JWT + anon apikey, RLS scopes)',
  /Authorization: `Bearer \$\{accessToken\}`/.test(posData) && /apikey: cfg.anonKey/.test(posData),
  'authed read headers missing');
check('till history: pos_devices read enumerates columns (token hashes not selectable)',
  !/pos_devices\?select=\*/.test(posData) && !/token_hash/.test(posData),
  'device read would request ungranted token columns');
check('till history: view renders cloud rows only (no local order state import)',
  !/from '\.\.\/\.\.\/data'|defaultState/.test(tillUi),
  'TillOrders imports local demo/order state');
check('till history: retained ledger is role-scoped but not routed in the public-web release',
  /till:\s*\{[^}]*label:\s*'Native Till Ledger'[^}]*allowedRoles:\s*\['owner', 'store_manager'\]/.test(adminNavigation) &&
  /till:\s*\{[^}]*status:\s*'post_launch'/.test(launchFeatures) &&
  !/effectiveActiveTab === 'till'/.test(adminPanel) &&
  !/<TillOrders\b/.test(adminPanel),
  'deferred Till ledger is exposed or lost its future role boundary');
check('till history: App hands AdminPanel a fresh-token getter',
  /getAccessToken=\{getAccessToken\}/.test(appTsx) && /import \{ getAccessToken \} from '\.\/lib\/auth'/.test(appTsx),
  'getAccessToken prop not passed from App');

/* 7. Gate 8 — device management + exports */
check('devices: RPC callers hit the three Owner functions by name',
  /rpc\/\$\{fn\}/.test(posData) &&
  ["create_pos_pairing_code","revoke_pos_device","rotate_pos_device_token"]
    .every((f) => posData.includes(`'${f}'`)),
  'an owner RPC caller is missing');
check('devices: forbidden is decided by the DATABASE error, not the UI',
  /only the owner/i.test(posData) && /'forbidden'/.test(posData),
  'is_owner() refusal not mapped to a forbidden result');
check('devices: secrets shown once are never persisted client-side',
  !/localStorage|sessionStorage|indexedDB/i.test(stripC(posData)) &&
  !/localStorage|sessionStorage|indexedDB/i.test(stripC(tillUi)),
  'a pairing code or rotated token could be persisted in the browser');
check('devices: UI actions are owner-gated and rotation explains the overlap window',
  /isOwner/.test(tillUi) && /old token keeps working until the till first uses the new one/i.test(tillUi),
  'owner gating or the overlap explanation is missing');
check('exports: CSV builders are pure and quote every cell',
  /export function toCsv/.test(posData) && /replace\(\/"\/g, '""'\)/.test(posData) &&
  /ordersToCsv/.test(tillUi) && /shiftsToCsv/.test(tillUi),
  'CSV export missing or unescaped');

/* 8. Gate 9 — catalogue push */
const CATMIG = 'supabase/migration_pos_catalog.sql';
const CATFN = 'supabase/functions/pos-catalog/index.ts';
const PUB = 'src/lib/posCatalog.ts';
for (const f of [CATMIG, CATFN, PUB]) check(`${f} exists`, existsSync(f), 'file missing');
const stripSql = (c) => c.replace(/--[^\n]*/g, '');
const catMig = stripSql(read(CATMIG));
const catFn = read(CATFN);
const pub = read(PUB);

check('catalogue: publish is owner-gated and the table is browser-dark',
  /if not is_owner\(\) then/i.test(catMig) &&
  /revoke all on table pos_catalog from anon/i.test(catMig) &&
  /revoke all on table pos_catalog from authenticated/i.test(catMig) &&
  /revoke all on function pos_catalog_current\(\)\s+from public, anon, authenticated/i.test(catMig),
  'catalogue table or raw-snapshot RPC reachable from a browser role');
check('catalogue: contract types shipped in the shared module',
  /CatalogSnapshot/.test(lib) && /PosCatalogResponse/.test(lib) &&
  /catalog: '\/functions\/v1\/pos-catalog'/.test(lib),
  'catalogue wire types missing from the contract module');
check('pos-catalog fn: token hashed, never logged, GET-only, honest 404',
  /Deploy WITHOUT "Verify JWT"/.test(catFn) && /sha256hex\(token\)/.test(catFn) &&
  !/console\.[a-z]+\([^)]*token/i.test(catFn) &&
  /'GET, OPTIONS'/.test(catFn) && /404/.test(catFn),
  'pos-catalog function breaks a credential or protocol rule');
check('ingest: acknowledgements advertise catalogVersion (guarded lookup)',
  /to_regclass\('public\.pos_catalog'\)/.test(stripSql(read('supabase/migration_pos_sync.sql'))) &&
  /catalogVersion/.test(ingest),
  'ingest does not advertise the catalogue version');
check('publisher: pounds→pence via Math.round and modifiers NEVER published',
  /Math\.round\(pounds \* 100\)/.test(pub) &&
  !/modifiers:/.test(stripC(pub)),
  'publisher money mapping wrong or it publishes a modifiers section');

/* 9. Gate 10 — live-proof harnesses */
const E2E = 'scripts/pos-e2e-live.mjs';
const RLSLIVE = 'scripts/rls-live.test.mjs';
const RUNBOOK = 'docs/GATE10-RUNBOOK.md';
for (const f of [E2E, RLSLIVE, RUNBOOK]) check(`${f} exists`, existsSync(f), 'file missing');
const e2e = read(E2E);
check('e2e: tokens are only ever printed MASKED',
  /const mask = /.test(e2e) &&
  !e2e.split('\n').some((line) => /console\.(log|error)/.test(line) &&
    /\$\{token\}|\$\{newToken\}|\$\{pair\.body\.deviceToken\}|\$\{rot\.body\}/.test(line)),
  'a raw token is interpolated into console output');
check('e2e: covers pairing, replay, conflict, refund cap, rotation overlap, revocation, catalogue',
  ['pos-pair', 'duplicate_conflict', 'invalid_money', 'rotate_pos_device_token',
   'revoke_pos_device', 'pos-catalog', 'OVERLAP'].every((k) => e2e.includes(k)),
  'an e2e stage is missing');
check('public-web live RLS explicitly excludes deferred POS behaviour',
  /POS behaviour is intentionally outside this public-web commissioning suite/.test(read(RLSLIVE))
    && /three functions remain undeployed/.test(read(RLSLIVE)),
  'public-web RLS suite does not state the deferred POS boundary');

check('gate 10: the zero-credential local full stack ships',
  ['scripts/pos-local-e2e/run.sh','scripts/pos-local-e2e/gateway.mjs',
   'scripts/pos-local-e2e/prelude-rest.sql','scripts/pos-local-e2e/bootstrap.ts',
   'scripts/pos-local-e2e/mint.mjs'].every((f) => existsSync(f)),
  'a local-stack file is missing');

console.log(`\n${failed === 0 ? '\u2714' : '\u2716'} POS CONTRACT CHECKS — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
