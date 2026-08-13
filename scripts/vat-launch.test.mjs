/**
 * Stage 3 · WS6d — VAT launch-truth guard.
 *
 * The closure brief's §1 ruling: the business trades NOT_REGISTERED — tax
 * charged 0, tax amount 0, no VAT number, and NO 20% fallback anywhere. The
 * live matrix (§16) proves the DATABASE behaves that way; this static gate
 * proves the SOURCES can't quietly regress. It fails if any of the removed
 * fallback shapes reappear in the frontend, or if the migration chain stops
 * removing the settings-level rate, or if the client re-grows its own VAT
 * arithmetic.
 *
 * Kept deliberately shape-based (regexes over the exact idioms that existed)
 * rather than a broad "no 20 anywhere" ban — prices, quantities and unrelated
 * constants may legitimately be 20.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failed++;
};
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

function tsFiles(dir) {
  return readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules') return [];
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}
const srcAll = tsFiles(path.join(ROOT, 'src')).map((f) => [path.relative(ROOT, f), readFileSync(f, 'utf8')]);

/* 1 — the frontend carries NO fallback rate and NO settings-level VAT fields. */
{
  const hits = srcAll.filter(([, s]) => /\bvatRatePercent\b/.test(s)).map(([f]) => f);
  check('frontend has NO vatRatePercent field anywhere', hits.length === 0, hits.join(', '));
}
{
  const hits = srcAll.filter(([, s]) => /\?\?\s*20\b/.test(s)).map(([f]) => f);
  check('frontend has NO "?? 20" fallback-rate idiom', hits.length === 0, hits.join(', '));
}
{
  // The removed client formula: total * rate / (100 + rate).
  const hits = srcAll.filter(([, s]) => /\/\s*\(\s*100\s*\+\s*[A-Za-z_$][\w$]*\s*\)/.test(s)).map(([f]) => f);
  check('frontend performs NO VAT-inclusive division of its own', hits.length === 0, hits.join(', '));
}
{
  const t = read('src/types.ts');
  check('SiteSettings no longer declares vatNumber', !/vatNumber\s*:\s*string\s*;[\s\S]{0,400}websiteUrl/.test(t));
  check('types declare the VatStatus union', /export type VatStatus = 'NOT_REGISTERED' \| 'REGISTERED';/.test(t));
  check('types declare the 4-code TaxCode union', /export type TaxCode = 'ZERO_RATED' \| 'STANDARD_RATE' \| 'REDUCED_RATE' \| 'OUTSIDE_SCOPE';/.test(t));
}
{
  const s = read('src/lib/cloudSync.ts');
  check('cloudSync OMITS the four store VAT columns from client pushes',
    /table:\s*'stores'[\s\S]{0,240}omit:\s*\[\s*'vatStatus',\s*'vatNumber',\s*'vatRegistrationEffectiveDate',\s*'vatConfigConfirmedAt',/.test(s));
}

/* 2 — the SQL sources: server fallbacks removed by the chain, never re-added. */
{
  const ws6dRaw = read('supabase/migration_stage3_ws6d_vat_lifecycle.sql');
  // The header COMMENT legitimately quotes the removed idioms by name; the
  // guard rules on EXECUTABLE text only, so strip `--` comments first.
  const ws6d = ws6dRaw.replace(/--[^\n]*/g, '');
  check('WS6d drops site_settings.vat_rate_percent', /drop column if exists vat_rate_percent/.test(ws6d));
  check('WS6d drops site_settings.vat_number', /drop column if exists vat_number/.test(ws6d));
  check('WS6d removes the orders.tax_rate DEFAULT', /alter column tax_rate drop default/.test(ws6d));
  check('WS6d re-issues submit_web_order with the trading gate', /store_vat_unconfigured/.test(ws6d));
  check('WS6d refuses unclassified products under REGISTERED', /product_tax_unclassified/.test(ws6d));
  check('WS6d contains NO ":= 20" fallback assignment', !/:=\s*20\b/.test(ws6d));
  check('WS6d contains NO coalesce(vat_rate_percent…) read', !/coalesce\(\s*vat_rate_percent/i.test(ws6d));
}
{
  // WS6j — ONLINE-CONFIRMED SELLING, as carried into the WS7 CLIENT ROUND.
  // The INVARIANTS are unchanged: the till must never declare a sale
  // complete, clear the basket, or tell a cashier money may be taken before
  // the SERVER has recorded it. The MECHANICS moved: the single-shot
  // onSubmitOrder/outbox pipeline became the staged quote → reserve →
  // finalise flow in src/lib/tillPayments.ts, so each check below asserts
  // the same guarantee against its new anchor.
  const pos9h = read('src/components/SalesPOS.tsx');
  check('the till AWAITS the server before completing a sale',
    /finishFinalise\(await tp\.finaliseCash/.test(pos9h)
    && /finishFinalise\(await tp\.finaliseCardOrOnline/.test(pos9h)
    && /if \(res\.status === 'confirmed'\) \{ enterConfirmed/.test(pos9h));
  check('the basket is cleared ONLY on confirmation',
    /const enterConfirmed[\s\S]{0,600}setCart\(\[\]\)/.test(pos9h)
    && (pos9h.match(/setCart\(\[\]\)/g) || []).length === 2
    && /cartLocked\(\)\) return; invalidateQuote\(\); setCart\(\[\]\)/.test(pos9h));
  check('a refusal or unconfirmed outcome tells the cashier NOT to take payment',
    (pos9h.match(/NOT ring/g) || []).length >= 3
    && /NOT recorded/.test(pos9h));
  check('the till warns before payment when the browser is offline',
    /!navigator\.onLine[\s\S]{0,200}DO NOT accept payment/.test(pos9h));
  check('the fire-and-forget submission path is gone',
    !/onAddOrder\(order\)/.test(pos9h) && !/onSubmitOrder/.test(pos9h));
  const tillpay9h = read('src/lib/tillPayments.ts');
  check('the outbox exposes single-sale confirmation',
    // WS7: the equivalent of confirmOne() is resumeFinalise() — one stored
    // attempt, replayed with its exact persisted facts until the server
    // answers; the till's Retry button drives it.
    /export async function resumeFinalise/.test(tillpay9h)
    && /tp\.resumeFinalise\(tpDeps, attempt\)/.test(pos9h));
  check('a permanently refused sale is dropped rather than retried forever',
    /if \(last\.status !== 'unconfirmed'\) return last;/.test(tillpay9h)
    && /removeAttempt\(attempt\.quoteId\);\s*\n\s*return \{ status: 'refused'/.test(tillpay9h));
  check('server refusals reach the UI as ALLOW-LISTED codes, never raw text',
    /KNOWN_TILL_REFUSALS/.test(tillpay9h)
    && /REFUSALS_BY_LENGTH\.find/.test(tillpay9h)
    && /tp\.refusalText\(/.test(pos9h)
    && !/addToast\([^)]*res\.message/.test(pos9h));
  const app9h = read('src/App.tsx');
  check('deferred POS confirmation remains inside its retained module, not the public app',
    /const enterConfirmed[\s\S]{0,400}onOrderConfirmed\(saved\)/.test(pos9h)
    && !/handleOrderConfirmed|orderOutbox|INITIAL_ORDERS/.test(app9h));
}
{
  const ws6i = read('supabase/migration_stage3_ws6i_classification_permanence.sql');
  const ws6iNoCmt = ws6i.replace(/--[^\n]*/g, '');
  check('WS6i makes a classification PERMANENT once set', /tax_code_withdrawal_forbidden/.test(ws6iNoCmt));
  check('WS6i puts that invariant in the TRIGGER, ahead of the authority ladder',
    ws6iNoCmt.indexOf('tax_code_withdrawal_forbidden') < ws6iNoCmt.indexOf("current_setting('milkpop.tax_classify_rpc'"));
  check('WS6i no longer keys withdrawal on the charging predicate (time cannot invalidate)',
    !/cannot_unclassify_while_charging/.test(ws6iNoCmt));
  check('WS6i serialises registration against classification (shared advisory lock)',
    (ws6iNoCmt.match(/pg_advisory_xact_lock\(hashtext\('milkpop\.vat_classification'\)\)/g) || []).length === 2);
  check('WS6i ships the server-authoritative trading state',
    /create or replace function store_trading_state/.test(ws6iNoCmt) && /'vatChargingNow'/.test(ws6iNoCmt));
  const pos9g = read('src/components/SalesPOS.tsx');
  check('the till prefers the SERVER charging answer over the device clock',
    /serverState \? serverState\.vatChargingNow : isVatCharging\(store\)/.test(pos9g));
  check('the till revalidates against the server immediately before payment',
    /const fresh = store\.id && token \? await fetchStoreTradingState/.test(pos9g));
  check('the till warns when the device clock disagrees with the server',
    /clockDisagrees/.test(pos9g));
  const admin9g = read('src/components/AdminPanel.tsx');
  check('the classification UI cannot select "unclassified" once a code is set',
    /<option value="" disabled=\{!!\(\(taxOverlay\[mi\.id\] \?\? mi\.taxCode\) \?\? ''\)\}>/.test(admin9g));
}
{
  const ws6h = read('supabase/migration_stage3_ws6h_classification_withdrawal.sql').replace(/--[^\n]*/g, '');
  check('WS6h bars WITHDRAWING a classification while a store is charging',
    /cannot_unclassify_while_charging/.test(ws6h));
  check('WS6h keys that on the CHARGING predicate, not mere registration',
    /vat_registration_effective_date\s*<=\s*\(now\(\) at time zone/.test(ws6h));
  const app9f = read('src/App.tsx');
  check('server-confirmed store rows reach GLOBAL state', /const applyServerStore/.test(app9f));
  check('server-confirmed classifications reach GLOBAL state', /const applyServerClassifications/.test(app9f));
  const admin9f = read('src/components/AdminPanel.tsx');
  check('the wizard pushes the confirmed store globally, not just to its overlay',
    /applyServerStore\(r\);/.test(admin9f));
  check('classification confirmation is pushed globally too',
    /applyServerClassifications\(changed\);/.test(admin9f));
  const pos9f = read('src/components/SalesPOS.tsx');
  check('the till re-derives the VAT date at the business-day boundary',
    /msUntilNextBusinessDay/.test(pos9f) && /setDayTick/.test(pos9f));
  // SUPERSEDED by Round-9g finding 4: the payment-time recomputation now
  // prefers the SERVER's answer and only falls back to the local helper.
  check('the till revalidates charging AT PAYMENT, not from the render closure',
    /const chargingNow = fresh \? fresh\.vatChargingNow : isVatCharging\(store\);/.test(pos9f));
  const ws6gAtomic = read('supabase/migration_stage3_ws6g_operational_closure.sql');
  check('the gift-card reconciliation is ONE atomic statement (upgrade-path fix)',
    /set payment_methods = nullif\(payment_methods - 'gift_card'/.test(ws6gAtomic)
    && /setup_status\s+= case/.test(ws6gAtomic));
}
{
  const ws6g = read('supabase/migration_stage3_ws6g_operational_closure.sql').replace(/--[^\n]*/g, '');
  check('WS6g removes gift_card from the launch vocabulary (RPC + CHECK)',
    /unsupported_payment_method/.test(ws6g) && /stores_payment_methods_supported/.test(ws6g));
  check('WS6g reconciles existing gift_card configurations', /payment_methods - 'gift_card'/.test(ws6g));
  check('WS6g scopes the public view to setup-ACTIVE stores',
    /create view stores_public[\s\S]{0,400}where setup_status = 'ACTIVE'/.test(ws6g));
  const pos9e = read('src/components/SalesPOS.tsx');
  check('the till BLOCKS unclassified products before payment',
    /const needsClassification/.test(pos9e) && /storeCharging && needsClassification\(item\)/.test(pos9e));
  check('the till blocks unclassified EXTRAS too',
    /storeCharging && needsClassification\(extra\)/.test(pos9e));
  const pos9eCode = pos9e.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('the till has NO store fallback (no stores[0] fallback, no invented id)',
    !/\|\|\s*stores\[0\]/.test(pos9eCode) && !/store\?\.id \|\| 's1'/.test(pos9eCode)
    && /const storeMissing = !store;/.test(pos9eCode));
  check('the till no longer offers gift_card', !/'gift_card', 'Gift card'/.test(pos9e));
  check('browser VAT dates use the shared London business date, not UTC',
    /isVatCharging\(store\)/.test(pos9e) && !/new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(pos9e));
  const bd = read('src/lib/businessDate.ts');
  check('the business-date helper formats in the store timezone',
    /Intl\.DateTimeFormat\('en-GB'/.test(bd) && /formatToParts\(date\)/.test(bd) && /timeZone: tz/.test(bd));
  const admin9e = read('src/components/AdminPanel.tsx');
  check('the wizard no longer offers gift_card',
    /\['cash', 'card', 'online'\] as PaymentMethod\[\]/.test(admin9e));
  check('admin shares the same charging predicate', /isVatCharging\(\{ \.\.\.st/.test(admin9e));
}
{
  const ws6f = read('supabase/migration_stage3_ws6f_vat_corrections.sql').replace(/--[^\n]*/g, '');
  check('WS6f gates CHARGING on the arrived effective date', /vat_registration_effective_date <=/.test(ws6f));
  check('WS6f ships store-scoped idempotency', /order_id_conflict/.test(ws6f));
  check('WS6f ships owner-only classification (guard + RPC)',
    /tax_code_is_owner_only/.test(ws6f) && /create or replace function classify_products/.test(ws6f));
  check('WS6f ships the REGISTERED classification gate', /products_unclassified/.test(ws6f));
  check('WS6f ships the launch vocabulary (RPC + CHECKs)',
    /unsupported_timezone/.test(ws6f) && /unsupported_currency/.test(ws6f) && /stores_timezone_supported/.test(ws6f));
  check('WS6f ships per-modifier tax snapshots', /alter table order_item_modifiers add column if not exists tax_code/.test(ws6f));
  check('WS6f ships the anonymous locator view + base revoke',
    /create or replace view stores_public/.test(ws6f) && /revoke select on table stores from anon/.test(ws6f));
  const sync6f = read('src/lib/cloudSync.ts');
  // R4.9 G4: the menu omit list grew a second entry, so the assertion no longer
  // pins it as the ONLY one — it checks each omission on its own terms.
  const menuEntry = (sync6f.match(/table:\s*'menu_items'[\s\S]{0,240}?\}/) || [''])[0];
  check('menu PUBLISHES omit the owner-only taxCode', /omit:\s*\[[^\]]*'taxCode'/.test(menuEntry));
  check('menu PUBLISHES omit the server-controlled available flag', /omit:\s*\[[^\]]*'available'/.test(menuEntry));
  check('the anonymous menu pull reads the menu_items_public view', /readTable:\s*'menu_items_public'/.test(sync6f));
  check('the anonymous stores pull reads the stores_public view', /readTable:\s*'stores_public'/.test(sync6f));
  const pos = read('src/components/SalesPOS.tsx');
  check('the till is FAIL-CLOSED on explicit ACTIVE setup', /setupStatus === 'ACTIVE'/.test(pos));
  // SUPERSEDED by Round-9e item 2: the F8 "parity" answer is now that
  // gift_card exists NOWHERE in the launch surface until balance validation
  // and redemption are implemented. Parity is preserved in the other
  // direction — the till offers exactly what a store may configure.
  check('the till offers NO gift_card button (9e item 2 supersedes F8 parity)',
    !/'gift_card', 'Gift card'/.test(pos));
  // SUPERSEDED by Round-9g: the local helper is now the OFFLINE FALLBACK; the
  // server's answer wins whenever it is available.
  check('the till mirrors the server charging state (server first, helper as fallback)',
    /serverState \? serverState\.vatChargingNow : isVatCharging\(store\)/.test(pos)
    && /from '\.\.\/lib\/businessDate'/.test(pos));
  const types = read('src/types.ts');
  const oim = types.slice(types.indexOf('export interface OrderItemModifier'));
  check('types model the per-modifier VAT snapshot',
    /taxCode\?: TaxCode \| null;/.test(oim.slice(0, 800)) && /taxAmount\?: number \| null;/.test(oim.slice(0, 800)));
  const admin = read('src/components/AdminPanel.tsx');
  check('a STANDALONE owner classification editor exists (not only the wizard)',
    /setClassifyOpen\(true\)/.test(admin) && /Product VAT classification/.test(admin));
  check('unclassified products are surfaced while a store is charging',
    /anyStoreCharging && unclassifiedItems\.length > 0/.test(admin));
}
{
  const ws6e = read('supabase/migration_stage3_ws6e_store_setup_lifecycle.sql').replace(/--[^\n]*/g, '');
  check('WS6e ships the setup trading gate', /store_setup_incomplete/.test(ws6e));
  check('WS6e ships the accepted-payment-set refusal', /payment_method_not_accepted/.test(ws6e));
  check('WS6e ships the RPC-only config/VAT guard', /store_config_is_rpc_only/.test(ws6e));
  check('WS6e ships store-ID immutability', /store_id_immutable/.test(ws6e));
  check('WS6e ships configure_store_setup (owner+MFA wizard)', /create or replace function configure_store_setup/.test(ws6e));
  const sync = read('src/lib/cloudSync.ts');
  check('cloudSync ALSO omits the five setup columns from client pushes',
    /'setupStatus',\s*'timezone',\s*'currencyCode',\s*'paymentMethods',\s*'receiptFooter'/.test(sync));
  const t = read('src/types.ts');
  check('types declare the SetupStatus union', /export type SetupStatus = 'DRAFT' \| 'ACTIVE';/.test(t));
}
{
  // The manifest must run WS6d after WS6c — order is the contract.
  const man = read('launch/migration-manifest.sh');
  const a = man.indexOf('migration_stage3_ws6c_vat_bounds.sql');
  const b = man.indexOf('migration_stage3_ws6d_vat_lifecycle.sql');
  const c = man.indexOf('migration_stage3_ws6e_store_setup_lifecycle.sql');
  const d = man.indexOf('migration_stage3_ws6f_vat_corrections.sql');
  check('manifest chains WS6d after WS6c', a !== -1 && b !== -1 && b > a);
  check('manifest chains WS6e after WS6d', c !== -1 && c > b);
  check('manifest chains WS6f after WS6e', d !== -1 && d > c);
  const e = man.indexOf('migration_stage3_ws6g_operational_closure.sql');
  check('manifest chains WS6g after WS6f', e !== -1 && e > d);
  const f = man.indexOf('migration_stage3_ws6h_classification_withdrawal.sql');
  check('manifest chains WS6h after WS6g', f !== -1 && f > e);
  const g = man.indexOf('migration_stage3_ws6i_classification_permanence.sql');
  check('manifest chains WS6i after WS6h', g !== -1 && g > f);
}

console.log(`\n${failed ? `✖ ${failed} VAT launch-guard problem(s)` : '✔ VAT launch guard — all checks passed'}`);
if (failed) process.exit(1);
