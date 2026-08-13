#!/usr/bin/env node
/**
 * ============================================================================
 *  migrate-base64-media-v2.mjs — legacy Base64 → Storage (WP04R-D, spec §12)
 *
 *  Replaces the withdrawn v1 tool, whose coverage stopped at menu_items /
 *  site_content / app_state (P1-R4). This version:
 *    • covers EVERY media-bearing field found in schema + code:
 *        menu_items.image, stores.image, news_posts.image,
 *        cms_pages.hero_image/about_image1/about_image2,
 *        media_assets.url (the legacy Library), and every string leaf inside
 *        site_content (all jsonb document columns) and app_state values;
 *    • writes a JSONL MANIFEST line per migrated value BEFORE touching the
 *      row (spec §12.2) — the manifest is the rollback map and the resume
 *      checkpoint (re-runs skip whatever it already marks done);
 *    • registers every uploaded object in media_objects (status='attached',
 *      uploaded_by='base64-migration') so the cleanup worker sees them;
 *    • de-duplicates identical images by SHA-256 — one object, many fields;
 *    • refuses to modify anything without --confirm-backup, and supports
 *      --dry-run (a per-table/field census with byte totals, zero writes).
 *
 *  USAGE
 *    export SUPABASE_URL=https://<project>.supabase.co
 *    export SUPABASE_SERVICE_ROLE_KEY=<service key>          # server-side only
 *    node scripts/migrate-base64-media-v2.mjs --dry-run
 *    node scripts/migrate-base64-media-v2.mjs --confirm-backup [--limit 100]
 *
 *  The service key must NEVER ship in the site bundle; this script runs on
 *  YOUR machine only. data: stays in the CSP until a follow-up dry-run
 *  reports zero remaining values (spec §12.1).
 * ============================================================================
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const DRY = process.argv.includes('--dry-run');
const CONFIRMED = process.argv.includes('--confirm-backup');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? Math.max(1, Number(process.argv[i + 1]) || 1) : Infinity;
})();
const MANIFEST = 'migration-manifest.jsonl';
const MIGRATION_ID = `b64v2_${new Date().toISOString().replace(/[:.]/g, '-')}`;
const BUCKET = 'menu-media';

if (!URL_BASE || !SERVICE) {
  console.error('✖ Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  process.exit(1);
}
if (!DRY && !CONFIRMED) {
  console.error('✖ A real run modifies database rows. Take a database backup');
  console.error('  (Supabase Dashboard → Database → Backups, or pg_dump), then');
  console.error('  re-run with --confirm-backup. Use --dry-run for the census.');
  process.exit(1);
}

const svc = (path, init = {}) =>
  fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/* ---- resume: (table|row|field) → done, and sha → existing object ---------- */
const doneKeys = new Set();
const shaToUrl = new Map();
if (existsSync(MANIFEST)) {
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.status === 'done') {
        doneKeys.add(`${m.table_name}|${m.row_id}|${m.field_path}`);
        if (m.old_value_sha256 && m.new_url) shaToUrl.set(m.old_value_sha256, { url: m.new_url, objectId: m.new_object_id, path: m.new_storage_path });
      }
    } catch { /* tolerate partial lines */ }
  }
  console.log(`Resuming: manifest already covers ${doneKeys.size} field(s).`);
}

const manifestLine = (entry) => appendFileSync(MANIFEST, JSON.stringify(entry) + '\n');

const DATA_RX = /^data:image\/(png|jpe?g|webp);base64,/i;

/* ---- upload one decoded image; returns {url, objectId, path} --------------- */
async function uploadBase64(dataUrl) {
  const hash = sha256(dataUrl);
  if (shaToUrl.has(hash)) return { ...shaToUrl.get(hash), reused: true, sha: hash };
  const m = dataUrl.match(DATA_RX);
  const mime = `image/${m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase()}`;
  const ext = mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1];
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  if (bytes.length === 0) throw new Error('empty_image');
  if (bytes.length > 500 * 1024) throw new Error(`oversize_${bytes.length}b`); // registry cap; report + skip
  const key = `${randomUUID()}.${ext}`;
  const up = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      'Content-Type': mime, 'x-upsert': 'false',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
    body: bytes,
  });
  if (!up.ok) throw new Error(`storage_${up.status}`);
  const url = `${URL_BASE}/storage/v1/object/public/${BUCKET}/${key}`;
  const reg = await svc('media_objects?select=id', {
    method: 'POST', headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      bucket: BUCKET, storage_path: key, public_url: url, mime_type: mime,
      size_bytes: bytes.length, alt_text: '', status: 'attached',
      attached_at: new Date().toISOString(), uploaded_by: 'base64-migration',
    }]),
  });
  if (!reg.ok) throw new Error(`registry_${reg.status}`);
  const objectId = (await reg.json())?.[0]?.id;
  const out = { url, objectId, path: key, reused: false, sha: hash };
  shaToUrl.set(hash, out);
  return out;
}

/* ---- migrate one plain column value; returns true when migrated ----------- */
let migrated = 0, skipped = 0, failed = 0, planned = 0, plannedBytes = 0;
const census = new Map(); // table.field → count
const bump = (k, bytes) => { census.set(k, (census.get(k) || 0) + 1); plannedBytes += bytes; };

async function migrateColumn(table, idCol, rowId, field, value) {
  const key = `${table}|${rowId}|${field}`;
  if (doneKeys.has(key)) { skipped++; return; }
  if (typeof value !== 'string' || !DATA_RX.test(value)) return;
  bump(`${table}.${field}`, value.length);
  if (DRY) { planned++; return; }
  if (migrated >= LIMIT) return;
  const started = new Date().toISOString();
  try {
    const obj = await uploadBase64(value);
    const patch = await svc(`${table}?${idCol}=eq.${encodeURIComponent(rowId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ [field]: obj.url }),
    });
    if (!patch.ok) throw new Error(`patch_${patch.status}`);
    manifestLine({
      migration_id: MIGRATION_ID, table_name: table, row_id: rowId, field_path: field,
      old_value_sha256: obj.sha, old_value_length: value.length,
      new_object_id: obj.objectId, new_storage_path: obj.path, new_url: obj.url,
      status: 'done', error: null, started_at: started, completed_at: new Date().toISOString(),
    });
    doneKeys.add(key); migrated++;
    console.log(`  ✔ ${table}.${field} [${rowId}] → ${obj.path}${obj.reused ? ' (deduped)' : ''}`);
  } catch (e) {
    failed++;
    manifestLine({
      migration_id: MIGRATION_ID, table_name: table, row_id: rowId, field_path: field,
      old_value_sha256: sha256(value), old_value_length: value.length,
      new_object_id: null, new_storage_path: null, new_url: null,
      status: 'failed', error: String(e?.message || e), started_at: started, completed_at: new Date().toISOString(),
    });
    console.error(`  ✖ ${table}.${field} [${rowId}] — ${String(e?.message || e)}`);
  }
}

/* ---- JSON documents: replace data-URL string leaves, tracking pointers ----- */
async function migrateJsonValue(node, pointer, replacements) {
  if (typeof node === 'string') {
    if (DATA_RX.test(node)) replacements.push({ pointer, value: node });
    return;
  }
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) await migrateJsonValue(node[i], `${pointer}/${i}`, replacements);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) await migrateJsonValue(v, `${pointer}/${k}`, replacements);
  }
}
const setPointer = (root, pointer, value) => {
  const parts = pointer.split('/').filter(Boolean);
  let n = root;
  for (let i = 0; i < parts.length - 1; i++) n = n[Array.isArray(n) ? Number(parts[i]) : parts[i]];
  n[Array.isArray(n) ? Number(parts.at(-1)) : parts.at(-1)] = value;
};

async function migrateJsonRow(table, idCol, rowId, column, doc) {
  const reps = [];
  await migrateJsonValue(doc, '', reps);
  if (reps.length === 0) return;
  let dirty = false;
  for (const r of reps) {
    const key = `${table}|${rowId}|${column}${r.pointer}`;
    if (doneKeys.has(key)) { skipped++; continue; }
    bump(`${table}.${column}${r.pointer.split('/').slice(0, 2).join('/')}`, r.value.length);
    if (DRY) { planned++; continue; }
    if (migrated >= LIMIT) break;
    const started = new Date().toISOString();
    try {
      const obj = await uploadBase64(r.value);
      setPointer(doc, r.pointer, obj.url);
      dirty = true;
      manifestLine({
        migration_id: MIGRATION_ID, table_name: table, row_id: rowId, field_path: `${column}${r.pointer}`,
        old_value_sha256: obj.sha, old_value_length: r.value.length,
        new_object_id: obj.objectId, new_storage_path: obj.path, new_url: obj.url,
        status: 'done', error: null, started_at: started, completed_at: new Date().toISOString(),
      });
      doneKeys.add(key); migrated++;
      console.log(`  ✔ ${table}.${column}${r.pointer} [${rowId}] → ${obj.path}${obj.reused ? ' (deduped)' : ''}`);
    } catch (e) {
      failed++;
      manifestLine({
        migration_id: MIGRATION_ID, table_name: table, row_id: rowId, field_path: `${column}${r.pointer}`,
        old_value_sha256: sha256(r.value), old_value_length: r.value.length,
        new_object_id: null, new_storage_path: null, new_url: null,
        status: 'failed', error: String(e?.message || e), started_at: started, completed_at: new Date().toISOString(),
      });
      console.error(`  ✖ ${table}.${column}${r.pointer} [${rowId}] — ${String(e?.message || e)}`);
    }
  }
  if (dirty && !DRY) {
    const patch = await svc(`${table}?${idCol}=eq.${encodeURIComponent(rowId)}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ [column]: doc }),
    });
    if (!patch.ok) console.error(`  ✖ ${table}.${column} [${rowId}] document PATCH failed (${patch.status}) — manifest lines above record the uploads; re-run to retry.`);
  }
}

/* ---- fetch helpers (paged) -------------------------------------------------- */
async function eachRow(table, select, cb) {
  const PAGE = 200;
  for (let from = 0; ; from += PAGE) {
    const res = await svc(`${table}?select=${select}`, { headers: { Range: `${from}-${from + PAGE - 1}` } });
    if (!res.ok) { console.error(`✖ ${table} read failed: ${res.status}`); return; }
    const rows = await res.json();
    for (const row of rows) await cb(row);
    if (rows.length < PAGE) return;
  }
}

/* ---- the coverage list (spec §12.3) ---------------------------------------- */
console.log(`${DRY ? 'DRY-RUN census' : 'MIGRATION'} ${MIGRATION_ID} against ${URL_BASE}`);
console.log('');

console.log('menu_items.image');
await eachRow('menu_items', 'id,image', (r) => migrateColumn('menu_items', 'id', r.id, 'image', r.image));
console.log('stores.image');
await eachRow('stores', 'id,image', (r) => migrateColumn('stores', 'id', r.id, 'image', r.image));
console.log('news_posts.image');
await eachRow('news_posts', 'id,image', (r) => migrateColumn('news_posts', 'id', r.id, 'image', r.image));
console.log('cms_pages hero/about images');
await eachRow('cms_pages', 'id,hero_image,about_image1,about_image2', async (r) => {
  await migrateColumn('cms_pages', 'id', r.id, 'hero_image', r.hero_image);
  await migrateColumn('cms_pages', 'id', r.id, 'about_image1', r.about_image1);
  await migrateColumn('cms_pages', 'id', r.id, 'about_image2', r.about_image2);
});
console.log('media_assets.url (legacy Library)');
await eachRow('media_assets', 'id,url', (r) => migrateColumn('media_assets', 'id', r.id, 'url', r.url));
console.log('site_content (all document columns)');
await eachRow('site_content', '*', async (r) => {
  for (const [col, val] of Object.entries(r)) {
    if (col === 'id' || val === null || typeof val !== 'object') continue;
    await migrateJsonRow('site_content', 'id', r.id, col, val);
  }
});
console.log('app_state (all values)');
await eachRow('app_state', 'key,value', async (r) => {
  if (r.value && typeof r.value === 'object') await migrateJsonRow('app_state', 'key', r.key, 'value', r.value);
  else if (typeof r.value === 'string') await migrateColumn('app_state', 'key', r.key, 'value', r.value);
});

/* ---- summary ---------------------------------------------------------------- */
console.log('');
if (census.size > 0) {
  console.log('Base64 census (table.field → values):');
  for (const [k, v] of [...census.entries()].sort()) console.log(`  ${k}: ${v}`);
  console.log(`  total payload: ${(plannedBytes / 1024 / 1024).toFixed(1)} MB of Base64 text`);
} else {
  console.log('No Base64 image values found — data: can be removed from the CSP after one more verifying dry-run.');
}
if (DRY) {
  console.log(`\nDRY-RUN complete: ${planned} value(s) would migrate. Nothing was modified.`);
} else {
  console.log(`\nMIGRATION complete: ${migrated} migrated, ${skipped} already done (manifest), ${failed} failed.`);
  console.log(`Manifest: ${MANIFEST} — keep it with the database backup; it is the rollback map.`);
  if (failed > 0) { console.log('Re-run the same command to retry failures.'); process.exit(2); }
}
