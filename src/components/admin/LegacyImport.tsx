/**
 * @file LegacyImport.tsx
 * @description PHASE A — owner-only, one-time migration of legacy browser
 * localStorage registries into Supabase.
 *
 * Contract (launch remediation, "Required migration handling"):
 *  - DETECTS relevant legacy records still sitting in this browser.
 *  - VALIDATES them (shape + id) and shows a PREVIEW before anything uploads.
 *  - Requires a STORE ASSIGNMENT for operational records missing one.
 *  - Uploads through the authenticated, per-domain, server-confirmed
 *    operations in src/lib/registries.ts (never a bulk state push).
 *  - REPORTS accepted / rejected counts per registry.
 *  - NEVER deletes the local copy automatically — clearing is a separate,
 *    explicit, per-registry button that only unlocks after a successful
 *    import of that registry.
 *  - The whole tool is owner-gated and designed to be removed after launch.
 */
import React, { useMemo, useState } from 'react';
import { UploadCloud, Trash, RefreshCw, CheckCircle, AlertTriangle, Database } from 'lucide-react';
import type { StoreLocation } from '../../types';
import {
  employeesRepo, shiftsRepo, payslipsRepo, documentsRepo, sifrRepo,
  coursesRepo, assessmentsRepo, trainingAssignmentsRepo, certificatesRepo,
  rolePermissionsRepo, checklistTemplatesRepo, auditLogsRepo, ordersRepo,
  menuItemsRepo, storesRepo, vacanciesRepo, articlesRepo, newsRepo, cmsPagesRepo,
  mediaRepo, dealsRepo, siteSettingsRepo, siteContentRepo, appStateKv,
  registryErrorMessage, type DomainOps,
  saveWebsiteStudio, currentCollectionRevision } from '../../lib/registries';
import { getAccessToken } from '../../lib/auth';
import { KV_KEYS, KV_PREFIXES } from '../../lib/cloudSync';

/* ------------------------------------------------------------------ */
/*  What can be imported                                               */
/* ------------------------------------------------------------------ */
type Kind = 'collection' | 'singleton' | 'kv';

interface ImportTarget {
  storageKey: string;
  label: string;
  kind: Kind;
  /** Collection targets upload through this repo. */
  repo?: DomainOps<any>;
  /** Singleton targets upload through save(). */
  singleton?: { table: string };
  /** Rows in this registry carry a store and may need an assignment. */
  storeScoped?: boolean;
  /** Primary key field for validation (default 'id'). */
  pk?: string;
}

const TARGETS: ImportTarget[] = [
  { storageKey: 'milkpop_employees', label: 'Staff profiles', kind: 'collection', repo: employeesRepo, storeScoped: true },
  { storageKey: 'milkpop_shifts', label: 'Rota & shifts', kind: 'collection', repo: shiftsRepo, storeScoped: true },
  { storageKey: 'milkpop_payslips', label: 'Earnings estimates', kind: 'collection', repo: payslipsRepo, storeScoped: true },
  { storageKey: 'milkpop_docs', label: 'Staff documents', kind: 'collection', repo: documentsRepo, storeScoped: true },
  { storageKey: 'milkpop_sifr', label: 'SIFR incident reports', kind: 'collection', repo: sifrRepo, storeScoped: true },
  { storageKey: 'milkpop_courses', label: 'Training courses', kind: 'collection', repo: coursesRepo },
  { storageKey: 'milkpop_assessments', label: 'Training modules', kind: 'collection', repo: assessmentsRepo },
  { storageKey: 'milkpop_training_assignments', label: 'Training assignments', kind: 'collection', repo: trainingAssignmentsRepo },
  { storageKey: 'milkpop_training_certificates', label: 'Training certificates', kind: 'collection', repo: certificatesRepo },
  { storageKey: 'milkpop_permissions_config', label: 'Permissions matrix', kind: 'collection', repo: rolePermissionsRepo, pk: 'role' },
  { storageKey: 'milkpop_checklist_templates', label: 'Checklist templates', kind: 'collection', repo: checklistTemplatesRepo },
  { storageKey: 'milkpop_audit_logs', label: 'Audit trail', kind: 'collection', repo: auditLogsRepo },
  { storageKey: 'milkpop_orders', label: 'Orders (web till)', kind: 'collection', repo: ordersRepo, storeScoped: true },
  { storageKey: 'milkpop_menu_items', label: 'Menu items', kind: 'collection', repo: menuItemsRepo },
  { storageKey: 'milkpop_stores_list', label: 'Store locations', kind: 'collection', repo: storesRepo },
  { storageKey: 'milkpop_vacancies_list', label: 'Job vacancies', kind: 'collection', repo: vacanciesRepo },
  { storageKey: 'milkpop_articles_list', label: 'Knowledge base', kind: 'collection', repo: articlesRepo },
  { storageKey: 'milkpop_news_posts', label: 'News posts', kind: 'collection', repo: newsRepo },
  { storageKey: 'milkpop_cms_pages', label: 'CMS pages (legacy)', kind: 'collection', repo: cmsPagesRepo },
  { storageKey: 'milkpop_media_library', label: 'Media library', kind: 'collection', repo: mediaRepo },
  { storageKey: 'milkpop_deals', label: 'Deals & combos', kind: 'collection', repo: dealsRepo },
  { storageKey: 'milkpop_site_settings', label: 'Site settings', kind: 'singleton', singleton: siteSettingsRepo },
  { storageKey: 'milkpop_site_content', label: 'Website Studio content', kind: 'singleton', singleton: siteContentRepo },
];

interface Detected {
  target: ImportTarget;
  /** Raw parsed value (array for collections, object otherwise). */
  value: any;
  valid: any[];
  invalid: number;
  needsStore: number;
}

interface ResultLine { key: string; label: string; accepted: number; rejected: number; error?: string | undefined }

function detect(): Detected[] {
  const found: Detected[] = [];
  for (const t of TARGETS) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(t.storageKey); } catch { /* storage disabled */ }
    if (!raw) continue;
    let value: any;
    try { value = JSON.parse(raw); } catch { continue; }
    if (t.kind === 'singleton') {
      if (value && typeof value === 'object') found.push({ target: t, value, valid: [value], invalid: 0, needsStore: 0 });
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) continue;
    const pk = t.pk ?? 'id';
    const valid = value.filter((r) => r && typeof r === 'object' && typeof r[pk] === 'string' && r[pk].length > 0);
    const needsStore = t.storeScoped
      ? valid.filter((r) => !r.storeId && !r.storeName && !r.store).length
      : 0;
    found.push({ target: t, value, valid, invalid: value.length - valid.length, needsStore });
  }
  return found;
}

function detectKv(): { key: string; value: unknown }[] {
  const out: { key: string; value: unknown }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!(KV_KEYS.includes(key) || KV_PREFIXES.some((p) => key.startsWith(p)))) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try { out.push({ key, value: JSON.parse(raw) }); } catch { /* skip malformed */ }
    }
  } catch { /* storage disabled */ }
  return out;
}

/**
 * Whether any legacy browser (localStorage) data is actually present on this
 * device. Drives whether the migration-only "Legacy Data Import" section is
 * offered at all (see launchFeatures.isAdminSectionVisible) so the utility stays
 * hidden on a clean install rather than looking like a permanent feature
 * (C1.3, audit finding #4). Safe when storage is unavailable.
 */
export function hasLegacyData(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return detect().length > 0 || detectKv().length > 0;
  } catch {
    return false;
  }
}

interface Props {
  stores: StoreLocation[];
  addToast: (msg: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  logAction: (module: string, action: string) => void;
}

export const LegacyImport: React.FC<Props> = ({ stores, addToast, logAction }) => {
  const [scanNonce, setScanNonce] = useState(0);
  // `scanNonce` is a manual re-scan token: bumping it (after an import, or via the
  // Re-scan button) must force detect()/detectKv() to re-read localStorage. It is a
  // trigger, not a value, so it is referenced with `void` to make the dependency real.
  const detected = useMemo(() => { void scanNonce; return detect(); }, [scanNonce]);
  const kvDetected = useMemo(() => { void scanNonce; return detectKv(); }, [scanNonce]);
  const [assignStoreId, setAssignStoreId] = useState<string>(stores[0]?.id || '');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ResultLine>>({});
  const [previewKey, setPreviewKey] = useState<string | null>(null);

  const assignStore = stores.find((s) => s.id === assignStoreId) || null;

  const runImport = async (d: Detected) => {
    const t = d.target;
    if (t.storeScoped && d.needsStore > 0 && !assignStore) {
      addToast('Pick a store to assign to the records that have none.', 'error');
      return;
    }
    setBusyKey(t.storageKey);
    const token = await getAccessToken();
    if (!token) {
      addToast('Your session has expired — sign in again to import.', 'error');
      setBusyKey(null);
      return;
    }
    let accepted = 0;
    let error: string | undefined;
    try {
      if (t.kind === 'singleton' && t.singleton) {
        // INC11: singletons import through the atomic studio RPC (the direct
        // upsert is guarded off). The expected revision is read fresh here —
        // legacy import runs on an otherwise-quiet database.
        {
          const rev = await currentCollectionRevision(t.singleton.table, token);
          if (t.singleton.table === 'site_settings') {
            await saveWebsiteStudio(d.value, null, rev, null, token);
          } else {
            await saveWebsiteStudio(null, d.value, null, rev, token);
          }
        }
        accepted = 1;
      } else if (t.repo) {
        const rows = d.valid.map((r) => {
          let row = t.storeScoped && !r.storeId && !r.storeName && !r.store && assignStore
            ? { ...r, storeId: assignStore.id, storeName: assignStore.name }
            : { ...r };
          // STAGE 3: legacy staff documents carried base64 data-URLs. Those
          // never become server records — metadata only; the column is gone.
          if (t.storageKey === 'milkpop_docs') { delete (row as any).url; }
          return row;
        });
        await t.repo.upsertMany(rows, token);
        accepted = rows.length;
      }
    } catch (e) {
      error = registryErrorMessage(e);
    }
    const line: ResultLine = {
      key: t.storageKey,
      label: t.label,
      accepted: error ? 0 : accepted,
      rejected: error ? d.valid.length : d.invalid,
      error,
    };
    setResults((prev) => ({ ...prev, [t.storageKey]: line }));
    setBusyKey(null);
    if (error) {
      addToast(`${t.label}: import failed — ${error}`, 'error');
    } else {
      logAction('Legacy Import', `Imported ${accepted} ${t.label} record(s) from this browser into the database`);
      addToast(`${t.label}: ${accepted} record(s) confirmed by the database${d.invalid ? `, ${d.invalid} invalid record(s) skipped` : ''}.`, 'success');
    }
  };

  const runKvImport = async () => {
    if (!kvDetected.length) return;
    setBusyKey('__kv__');
    const token = await getAccessToken();
    if (!token) { addToast('Your session has expired — sign in again to import.', 'error'); setBusyKey(null); return; }
    let ok = 0; let fail = 0; let lastErr = '';
    for (const { key, value } of kvDetected) {
      try { await appStateKv.set(key, value, token); ok++; } catch (e) { fail++; lastErr = registryErrorMessage(e); }
    }
    setResults((prev) => ({ ...prev, __kv__: { key: '__kv__', label: 'App state (clock status, checklists, covers, e-mail prefs)', accepted: ok, rejected: fail, error: fail ? lastErr : undefined } }));
    setBusyKey(null);
    if (fail) addToast(`App state: ${ok} key(s) saved, ${fail} failed — ${lastErr}`, 'error');
    else { logAction('Legacy Import', `Imported ${ok} app-state key(s)`); addToast(`App state: ${ok} key(s) confirmed by the database.`, 'success'); }
  };

  const clearLocal = (storageKey: string, label: string) => {
    if (!window.confirm(`Remove the LOCAL browser copy of "${label}"? The imported records stay safe in the database. This cannot be undone on this device.`)) return;
    try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    logAction('Legacy Import', `Cleared the local browser copy of ${label} after import`);
    addToast(`Local copy of ${label} removed from this browser.`, 'warning');
    setScanNonce((n) => n + 1);
  };

  return (
    <div className="space-y-6 font-sans text-2xs text-[#2E2A26]">
      <div>
        <h1 className="font-display font-black text-2xl">Legacy Data Import</h1>
        <p className="text-2xs text-[#2E2A26]/70 max-w-2xl">
          One-time, owner-only tool. It reads the registries an <b>older build of this website stored in this browser</b>, shows you what it found,
          and uploads them into the central database through the same authenticated, server-confirmed operations the live app uses.
          Nothing is deleted automatically, and nothing uploads until you press Import.
        </p>
      </div>

      <div className="bg-white rounded-2xl border border-[#EBDECE] p-5 flex flex-wrap items-center gap-3">
        <Database className="h-4 w-4 text-[#A46832]" />
        <span className="font-bold">Assign records without a store to:</span>
        <select value={assignStoreId} onChange={(e) => setAssignStoreId(e.target.value)} className="bg-stone-50 border border-[#EBDECE] p-2 rounded-xl outline-none">
          {stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          {stores.length === 0 && <option value="">— no stores loaded —</option>}
        </select>
        <button onClick={() => setScanNonce((n) => n + 1)} className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 border border-[#EBDECE] rounded-full font-black uppercase tracking-wider cursor-pointer hover:bg-stone-50">
          <RefreshCw className="h-3 w-3" /> Re-scan this browser
        </button>
      </div>

      {detected.length === 0 && kvDetected.length === 0 && (
        <div className="bg-white rounded-2xl border border-[#EBDECE] p-8 text-center text-[#2E2A26]/60">
          No legacy registries were found in this browser — there is nothing to import.
        </div>
      )}

      {detected.map((d) => {
        const res = results[d.target.storageKey];
        return (
          <div key={d.target.storageKey} className="bg-white rounded-2xl border border-[#EBDECE] p-5 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-48">
                <p className="font-black text-xs">{d.target.label}</p>
                <p className="text-[#2E2A26]/60">
                  {d.target.kind === 'singleton' ? '1 saved document' : `${d.valid.length} valid record(s)`}
                  {d.invalid > 0 && <span className="text-red-500"> · {d.invalid} invalid (skipped)</span>}
                  {d.needsStore > 0 && <span className="text-[#A5642B]"> · {d.needsStore} will be assigned to {assignStore?.name || '—'}</span>}
                </p>
              </div>
              {d.target.kind === 'collection' && (
                <button onClick={() => setPreviewKey(previewKey === d.target.storageKey ? null : d.target.storageKey)} className="px-3 py-2 border border-[#EBDECE] rounded-full font-black uppercase tracking-wider cursor-pointer hover:bg-stone-50">
                  {previewKey === d.target.storageKey ? 'Hide preview' : 'Preview'}
                </button>
              )}
              <button
                disabled={busyKey !== null}
                onClick={() => void runImport(d)}
                className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#A46832] text-white rounded-full font-black uppercase tracking-wider cursor-pointer hover:bg-[#A5642B] disabled:opacity-40"
              >
                <UploadCloud className="h-3 w-3" /> {busyKey === d.target.storageKey ? 'Importing…' : 'Import'}
              </button>
              {res && !res.error && (
                <button onClick={() => clearLocal(d.target.storageKey, d.target.label)} className="inline-flex items-center gap-1.5 px-3 py-2 border border-red-200 text-red-500 rounded-full font-black uppercase tracking-wider cursor-pointer hover:bg-red-50">
                  <Trash className="h-3 w-3" /> Clear local copy
                </button>
              )}
            </div>
            {previewKey === d.target.storageKey && (
              <div className="border border-[#EBDECE] rounded-xl overflow-auto max-h-64">
                <table className="w-full text-[10px]">
                  <thead className="bg-stone-50 text-left"><tr>
                    {Object.keys(d.valid[0] || {}).slice(0, 6).map((k) => <th key={k} className="p-2 font-black uppercase">{k}</th>)}
                  </tr></thead>
                  <tbody>
                    {d.valid.slice(0, 8).map((r, i) => (
                      <tr key={i} className="border-t border-[#EBDECE]">
                        {Object.keys(d.valid[0] || {}).slice(0, 6).map((k) => (
                          <td key={k} className="p-2 truncate max-w-40">{typeof r[k] === 'object' ? '…' : String(r[k] ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {d.valid.length > 8 && <p className="p-2 text-[#2E2A26]/50">…and {d.valid.length - 8} more.</p>}
              </div>
            )}
            {res && (
              <p className={`inline-flex items-center gap-1.5 font-bold ${res.error ? 'text-red-600' : 'text-[#5CA459]'}`}>
                {res.error ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle className="h-3.5 w-3.5" />}
                {res.error ? `Failed — ${res.error}` : `${res.accepted} accepted by the database${res.rejected ? `, ${res.rejected} rejected/skipped` : ''}.`}
              </p>
            )}
          </div>
        );
      })}

      {kvDetected.length > 0 && (
        <div className="bg-white rounded-2xl border border-[#EBDECE] p-5 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex-1 min-w-48">
              <p className="font-black text-xs">App state (clock status, checklist ticks, shift covers, e-mail prefs)</p>
              <p className="text-[#2E2A26]/60">{kvDetected.length} key(s) found in this browser.</p>
            </div>
            <button disabled={busyKey !== null} onClick={() => void runKvImport()} className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#A46832] text-white rounded-full font-black uppercase tracking-wider cursor-pointer hover:bg-[#A5642B] disabled:opacity-40">
              <UploadCloud className="h-3 w-3" /> {busyKey === '__kv__' ? 'Importing…' : 'Import all'}
            </button>
          </div>
          {results.__kv__ && (
            <p className={`inline-flex items-center gap-1.5 font-bold ${results.__kv__.error ? 'text-red-600' : 'text-[#5CA459]'}`}>
              {results.__kv__.error ? <AlertTriangle className="h-3.5 w-3.5" /> : <CheckCircle className="h-3.5 w-3.5" />}
              {results.__kv__.error ? `Some keys failed — ${results.__kv__.error}` : `${results.__kv__.accepted} key(s) accepted by the database.`}
            </p>
          )}
        </div>
      )}

      <p className="text-[10px] text-[#2E2A26]/50 max-w-2xl">
        After every registry you care about shows “accepted by the database”, this page has done its job — it can be removed from the
        build, and the leftover browser copies can be cleared with the per-registry buttons above (they are never removed automatically).
      </p>
    </div>
  );
};
