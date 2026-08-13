/**
 * auth-multitab.browser.test.mjs — REAL multi-tab verification of the
 * cross-tab auth architecture. Bundles harness/auth-harness.ts (the REAL
 * authStorage/authChannel/authReconcile modules), serves it, opens THREE
 * genuine Chromium tabs sharing one origin (real localStorage + real
 * BroadcastChannel), and replays the audit scenarios on real transport.
 *
 * DETERMINISM: no fixed sleeps for effects. Every scenario waits on an
 * OBSERVABLE condition (waitForFunction, 10 s ceiling). Probes with no
 * observable effect by design (a duplicate redelivery; a stale ghost event)
 * are immediately followed by a real mutation from the SAME sender — per-tab
 * BroadcastChannel delivery is FIFO per sender, so once the follow-up's
 * effect is visible the probe has certainly been delivered (and, per the
 * counters, ignored).
 *
 * Browser tier (like audit:final / audit:clicks): provisioned by
 * `npm exec --offline -- playwright install chromium`, chained from `npm run test:browser`.
 * Deliberately NOT part of `npm run verify` (verify stays npm-ci-only).
 */
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✔' : '✖'} ${name}${ok ? '' : `  — ${detail}`}`);
  if (ok) passed += 1; else failed += 1;
};

/* ---- bundle the harness (real modules) ------------------------------------ */
const dir = mkdtempSync(path.join(tmpdir(), 'mp-harness-'));
await build({
  entryPoints: [path.join(ROOT, 'harness/auth-harness.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(dir, 'auth-harness.js'),
  logLevel: 'silent',
});
writeFileSync(path.join(dir, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>auth harness</title></head>' +
  '<body><script type="module" src="./auth-harness.js"></script></body></html>');

/* ---- serve it ------------------------------------------------------------- */
const server = createServer((req, res) => {
  const file = req.url === '/' || req.url === '/index.html' ? 'index.html' : 'auth-harness.js';
  const type = file.endsWith('.html') ? 'text/html' : 'text/javascript';
  res.writeHead(200, { 'content-type': type });
  res.end(readFileSync(path.join(dir, file)));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r)); // ephemeral: re-runnable back-to-back
const PORT = server.address().port;

/* ---- FIVE real tabs, one origin (audit item 9: five-tab stability) -------- */
const browser = await chromium.launch();
const context = await browser.newContext();
const [A, B, C, D, E] = await Promise.all([context.newPage(), context.newPage(), context.newPage(), context.newPage(), context.newPage()]);
const names = new Map([[A, 'A'], [B, 'B'], [C, 'C'], [D, 'D'], [E, 'E']]);
for (const p of [A, B, C, D, E]) {
  p.on('pageerror', (e) => console.error(`  [page ${names.get(p)}] ERROR:`, e.message));
  p.on('console', (m) => { if (m.type() === 'error') console.error(`  [page ${names.get(p)}] console.error:`, m.text()); });
}
const ready = (p) => p.waitForFunction(() => document.title === 'auth-harness ready' && Boolean(window.__h), null, { timeout: 15_000 });
for (const p of [A, B, C, D, E]) { await p.goto(`http://127.0.0.1:${PORT}/`); await ready(p); }
await A.evaluate(() => { localStorage.clear(); });
for (const p of [A, B, C, D, E]) { await p.reload(); await ready(p); }

/** On ANY uncaught failure: dump every tab's state + wire log, then clean up. */
const fatal = async (err) => {
  console.error('FATAL:', err instanceof Error ? err.message : String(err));
  try {
    for (const p of [A, B, C, D, E]) {
      console.error(`  state ${names.get(p)}:`, JSON.stringify(await st(p)));
      console.error(`  wire  ${names.get(p)}:`, JSON.stringify(await p.evaluate(() => window.__h.debug())));
    }
  } catch { /* page gone */ }
  try { await browser.close(); } catch { /* already closed */ }
  try { server.close(); } catch { /* already closed */ }
  process.exit(1);
};
process.on('unhandledRejection', fatal);
process.on('uncaughtException', fatal);

const st = (p) => p.evaluate(() => window.__h.state());
/** Wait until the page's harness state satisfies `expr` (stringified predicate over s). */
const until = (p, expr) => p.waitForFunction(
  (e) => { const s = window.__h.state(); return Function('s', `return (${e});`)(s); },
  expr, { timeout: 10_000 },
);

/* B1 — a real login in Tab A appears in Tabs B and C over real BroadcastChannel */
await A.evaluate(() => window.__h.login('user-a', 'm1'));
await Promise.all([until(B, "s.localUser === 'user-a'"), until(C, "s.localUser === 'user-a'")]);
{
  const [a, b, c] = await Promise.all([st(A), st(B), st(C)]);
  check('B1: real-transport login propagates to BOTH receivers',
    b.localUser === 'user-a' && c.localUser === 'user-a', `B=${b.localUser} C=${c.localUser}`);
  check('B1: receivers reconciled exactly once and posted NOTHING',
    b.processed === 1 && c.processed === 1 && b.posted === 0 && c.posted === 0,
    `B=${b.processed}/${b.posted} C=${c.processed}/${c.posted}`);
  check('B1: all three tabs converge on one version', a.version === b.version && b.version === c.version,
    `${a.version}/${b.version}/${c.version}`);
}

/* B2+B5 — duplicate redelivery (no observable effect) flushed by a real refresh */
await A.evaluate(() => window.__h.repostLast());
const tokenA = (await A.evaluate(() => { window.__h.refresh('m3'); return window.__h.state(); })).token;
await Promise.all([until(B, `s.token === ${JSON.stringify(tokenA)}`), until(C, `s.token === ${JSON.stringify(tokenA)}`)]);
{
  const [b, c] = await Promise.all([st(B), st(C)]);
  check('B2: redelivered announcement was ignored (FIFO-flushed by the refresh)',
    b.processed === 2 && c.processed === 2, `B=${b.processed} C=${c.processed} (login+refresh only)`);
  check('B5: peer adopts the rotated token over real transport (no second refresh)',
    b.token === tokenA && b.posted === 0 && b.localUser === 'user-a', `tokensEqual=${b.token === tokenA}`);
}

/* B4 — logout → immediate re-login converges everywhere (round-3 C1 repro) */
await A.evaluate(() => window.__h.logout());
await Promise.all([until(B, 's.localUser === null'), until(C, 's.localUser === null')]);
{
  const [a, b] = await Promise.all([st(A), st(B)]);
  check('B4: remote logout clears receivers WITHOUT any receiver write',
    b.localUser === null && b.version === a.version && b.posted === 0 && b.clears === 1,
    `B=${String(b.localUser)}/${b.version} A=${a.version} clears=${b.clears}`);
}
await A.evaluate(() => window.__h.login('user-a', 'm2'));
await Promise.all([until(B, "s.localUser === 'user-a'"), until(C, "s.localUser === 'user-a'")]);
{
  const [b, c] = await Promise.all([st(B), st(C)]);
  check('B4: the immediate re-login is adopted, never rejected as stale',
    b.localUser === 'user-a' && c.localUser === 'user-a', `B=${b.localUser} C=${c.localUser}`);
}

/* B6 — a delayed equal-version SIGNED_OUT (ghost) cannot dislodge the live truth (H3) */
await A.evaluate(() => {
  const v = window.__h.state().version;
  window.__h.postRaw({ type: 'SIGNED_OUT', reason: 'stale_ghost', sessionVersion: v, mutation: { writerId: 'ghost', mutationId: 'ghost' } });
  window.__h.login('user-b', 'm4');   // FIFO flush from the same sender
});
await Promise.all([until(B, "s.localUser === 'user-b'"), until(C, "s.localUser === 'user-b'")]);
{
  const [b, c] = await Promise.all([st(B), st(C)]);
  check('B6: the stale equal-version SIGNED_OUT never cleared anyone (single real clear only)',
    b.clears === 1 && c.clears === 1 && b.localUser === 'user-b', `clears B=${b.clears} C=${c.clears}`);
}

/* B7 — rapid account switch: receivers land on the LAST identity */
await A.evaluate(() => window.__h.login('user-c', 'm5'));
await Promise.all([until(B, "s.localUser === 'user-c'"), until(C, "s.localUser === 'user-c'")]);
{
  const [b, c] = await Promise.all([st(B), st(C)]);
  check('B7: rapid switches converge on the final identity in every tab',
    b.localUser === 'user-c' && c.localUser === 'user-c' && b.userId === 'user-c', `B=${b.localUser} C=${c.localUser}`);
}

/* B3 — totals: only the writer ever posts; receiver reconciles = real mutations only */
{
  const [a, b, c] = await Promise.all([st(A), st(B), st(C)]);
  // A posted: login, repost, refresh, logout, relogin, ghost, login-b, login-c = 8
  // receivers reconciled: login, refresh, logout, relogin, login-b, login-c = 6 (repost + ghost ignored)
  check('B3: total bus traffic = the writer\'s posts alone (no storm possible)',
    a.posted === 8 && b.posted === 0 && c.posted === 0, `A=${a.posted} B=${b.posted} C=${c.posted}`);
  check('B3: receivers processed exactly the real mutations (probes ignored)',
    b.processed === 6 && c.processed === 6, `B=${b.processed} C=${c.processed}`);
}

/* B8 — FIVE tabs stable across the whole run (audit item 9): D and E were
 *  silent receivers for every mutation — login, duplicate, refresh, logout,
 *  re-login, ghost, two switches — and must have converged identically. */
await Promise.all([until(D, "s.localUser === 'user-c'"), until(E, "s.localUser === 'user-c'")]);
{
  const [a, d, e] = await Promise.all([st(A), st(D), st(E)]);
  check('B8: tabs four and five converge on the final identity and version',
    d.localUser === 'user-c' && e.localUser === 'user-c' && d.version === a.version && e.version === a.version,
    `D=${d.localUser}/${d.version} E=${e.localUser}/${e.version} A=${a.version}`);
  check('B8: five-tab run stays finite and exact (processed=6, posted=0, clears=1 each)',
    d.processed === 6 && e.processed === 6 && d.posted === 0 && e.posted === 0 && d.clears === 1 && e.clears === 1,
    `D=${d.processed}/${d.posted}/${d.clears} E=${e.processed}/${e.posted}/${e.clears}`);
}

await browser.close();
server.close();
console.log(`\nAUTH MULTI-TAB BROWSER — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

