/**
 * @file ClosurePanels.tsx
 * @description R4.8 admin panels — Launch Readiness (F2), Operational Health
 * (M), Notification Health (C5). Shared rules:
 *   • every value comes from an owner-scoped RPC; nothing is asserted locally
 *   • load failure renders an explicit "Unavailable" state, never a guess
 *   • absence of data renders "unknown / not configured", never green
 */
import React, { useCallback, useEffect, useState } from 'react';
import { callRpc } from '../../lib/registries';
import { getAccessToken } from '../../lib/auth';
import { safeCanonicalSiteHref, safeMailtoHref, safePolicyHref, safeTelHref } from '../../lib/safeUrl';


/* ---------- shared bits ---------------------------------------------------- */
const STATE_STYLE: Record<string, string> = {
  complete: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  healthy: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  incomplete: 'bg-red-50 text-red-600 border-red-200',
  failed: 'bg-red-50 text-red-600 border-red-200',
  unknown: 'bg-gray-50 text-gray-500 border-gray-200',
  not_applicable: 'bg-gray-50 text-gray-500 border-gray-200',
  externally_verified: 'bg-sky-50 text-sky-700 border-sky-200',
};
function Chip({ state }: { state: string }) {
  const cls = STATE_STYLE[state] || STATE_STYLE.unknown;
  return <span className={`text-[11px] font-black uppercase border px-2 py-0.5 rounded ${cls}`}>{state.replace(/_/g, ' ')}</span>;
}
function useOwnerRpc<T>(name: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('no_session');
      const r = await callRpc<T>(name, {}, token);
      setData(r);
    } catch { setData(null); setError('unavailable'); }
  }, [name]);
  useEffect(() => { load(); }, [load]);
  return { data, error, reload: load };
}
const box = 'bg-white p-6 rounded-2xl border border-[#EBDECE]/60 space-y-3';

/* ---------- F2: Launch Readiness ------------------------------------------- */
interface ReadinessItem { key: string; state: string; fix: string }
export function LaunchReadinessPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const { data, error, reload } = useOwnerRpc<{ ok: boolean; items?: ReadinessItem[] }>('launch_readiness');
  useEffect(() => {
    if (refreshToken > 0) void reload();
  }, [refreshToken, reload]);
  return (
    <div className={box}>
      <div className="flex items-center justify-between">
        <h3 className="font-display font-bold text-xs uppercase tracking-wide">Launch Readiness</h3>
        <button onClick={reload} className="text-[10px] font-bold text-[#A46832] underline cursor-pointer min-h-11 px-2">Refresh</button>
      </div>
      {error && <p className="text-xs text-stone-500">Readiness data is unavailable right now — this panel reports nothing rather than guessing. Try again shortly.</p>}
      {!error && !data && <p className="text-xs text-stone-500">Loading readiness checks…</p>}
      {data?.ok && (
        <ul className="space-y-2">
          {(data.items || []).map((it) => (
            <li key={it.key} className="flex items-center justify-between gap-2">
              <a href={it.fix} className="text-xs font-bold text-[#2E2A26] underline decoration-[#EBDECE] hover:decoration-[#A46832] min-h-11 flex items-center">
                {it.key.replace(/_/g, ' ')}
              </a>
              <Chip state={it.state} />
            </li>
          ))}
        </ul>
      )}
      <p className="text-[11px] text-stone-500 leading-relaxed">
        Legal identity, notice text and business facts are entered by the owner —
        nothing here is pre-filled or assumed. A store cannot be set to “open”,
        and public forms will not run once gates are armed, while required items
        are incomplete.
      </p>
    </div>
  );
}

/* ---------- M: Operational Health ------------------------------------------ */
interface HealthSignal { key: string; value: unknown; state: string; note?: string }
export function OpsHealthPanel({ releaseVersion }: { releaseVersion: string }) {
  const { data, error, reload } = useOwnerRpc<{ ok: boolean; generated_at?: string; signals?: HealthSignal[] }>('ops_health');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyDiagnostics = useCallback(async () => {
    if (!data?.ok) return;
    const report = [
      'Milk Pop system status',
      `Release: ${releaseVersion}`,
      `Generated: ${data.generated_at || 'not provided'}`,
      ...(data.signals || []).map((signal) => `${signal.key}: ${signal.state}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(report);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }, [data, releaseVersion]);
  return (
    <div className={box}>
      <div className="flex items-center justify-between">
        <h3 className="font-display font-bold text-xs uppercase tracking-wide">Operational Health</h3>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => { void copyDiagnostics(); }} disabled={!data?.ok} className="text-xs font-bold text-[#A46832] underline cursor-pointer min-h-11 px-2 disabled:opacity-40 disabled:cursor-not-allowed">Copy status</button>
          <button type="button" onClick={reload} className="text-xs font-bold text-[#A46832] underline cursor-pointer min-h-11 px-2">Refresh</button>
        </div>
      </div>
      <p className="text-xs text-stone-500">Release {releaseVersion}. Signals report <em>unknown</em> when a source is not configured — absence of data is never shown as healthy.</p>
      {copyState !== 'idle' && <p className={`text-xs ${copyState === 'copied' ? 'text-emerald-700' : 'text-red-600'}`} role="status" aria-live="polite">{copyState === 'copied' ? 'Safe status summary copied.' : 'Status could not be copied on this device.'}</p>}
      {error && <p className="text-xs text-stone-500">Health data is unavailable right now.</p>}
      {data?.ok && (
        <ul className="space-y-2">
          {(data.signals || []).map((sg) => (
            <li key={sg.key} className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-[#2E2A26]">{sg.key.replace(/_/g, ' ')}
                {sg.value !== null && sg.value !== undefined && <span className="ml-2 font-mono text-[11px] text-stone-500">{String(sg.value)}</span>}
                {sg.note && <span className="ml-2 text-[11px] text-stone-500">({sg.note.replace(/_/g, ' ')})</span>}
              </span>
              <Chip state={sg.state} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- C5: Notification Health ---------------------------------------- */
interface OutboxRow {
  id: string; event_type: string; entity_type: string; entity_id: string;
  status: string; attempt_count: number; last_attempt_at: string | null;
  last_error_code: string | null; created_at: string;
}
export function NotificationHealthPanel() {
  const [rows, setRows] = useState<OutboxRow[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      const token = await getAccessToken();
      if (!token) throw new Error('no_session');
      const r = await callRpc<OutboxRow[]>('outbox_recent', { p_limit: 50 }, token);
      setRows(Array.isArray(r) ? r : []);
    } catch { setRows(null); setError('unavailable'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const retry = async (id: string) => {
    try {
      const token = await getAccessToken();
      if (!token) return;
      await callRpc('outbox_retry_now', { p_id: id }, token);
      await load();
    } catch { /* surfaced by reload state */ }
  };

  const counts = (rows || []).reduce<Record<string, number>>((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
  return (
    <div className={box}>
      <div className="flex items-center justify-between">
        <h3 className="font-display font-bold text-xs uppercase tracking-wide">Notification Health</h3>
        <button onClick={load} className="text-[10px] font-bold text-[#A46832] underline cursor-pointer min-h-11 px-2">Refresh</button>
      </div>
      {error && <p className="text-xs text-stone-500">Outbox data is unavailable right now.</p>}
      {rows && (
        <>
          <div className="flex flex-wrap gap-2">
            {['pending', 'processing', 'retry', 'delivered', 'failed', 'dead_letter', 'blocked_config'].map((k) => (
              <span key={k} className="text-[10px] font-bold text-stone-600 border border-[#EBDECE] rounded px-2 py-0.5">
                {k.replace(/_/g, ' ')}: {counts[k] || 0}
              </span>
            ))}
          </div>
          {rows.length === 0 && <p className="text-xs text-stone-500">No notification jobs recorded yet.</p>}
          <ul className="space-y-2 max-h-64 overflow-y-auto">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 border-b border-[#EBDECE]/50 pb-1">
                <span className="text-[11px] font-mono text-stone-600 truncate">
                  {r.event_type} · {r.entity_id.slice(0, 8)} · tries {r.attempt_count}
                  {r.last_error_code ? ` · ${r.last_error_code}` : ''}
                  {r.last_attempt_at ? ` · ${new Date(r.last_attempt_at).toLocaleString('en-GB')}` : ' · never attempted'}
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <Chip state={r.status === 'delivered' ? 'healthy' : r.status === 'pending' || r.status === 'processing' || r.status === 'retry' ? 'warning' : 'failed'} />
                  {['failed', 'dead_letter', 'retry', 'blocked_config'].includes(r.status) && (
                    <button onClick={() => retry(r.id)} className="text-[10px] font-bold text-[#A46832] underline cursor-pointer min-h-11 px-1">Retry</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/* ---------- F1/F4: Launch Facts editor ------------------------------------- */
import { loadLaunchSettings, saveLaunchSettings, loadLaunchRevision, loadPrivacyNotices, publishPrivacyNotice, EMPTY_LAUNCH_SETTINGS, type LaunchSettingsRow, type PrivacyNoticeRow } from '../../lib/launchSettings';

export function LaunchFactsPanel({
  operatorName: _operatorName,
  onSaved,
}: {
  operatorName: string;
  onSaved?: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<LaunchSettingsRow>(EMPTY_LAUNCH_SETTINGS);
  const [notices, setNotices] = useState<PrivacyNoticeRow[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [note, setNote] = useState('');
  const [np, setNp] = useState({ audience: 'careers' as PrivacyNoticeRow['audience'], version: '', text: '', url: '' });

  const [launchRevision, setLaunchRevision] = useState<number | null>(null);
  const load = useCallback(async () => {
    setStatus('loading');
    const [ls, pn, rev] = await Promise.all([loadLaunchSettings(), loadPrivacyNotices(), loadLaunchRevision()]);
    if (ls.ok) { setDraft(ls.data); setStatus('ready'); } else setStatus('unavailable');
    if (pn.ok) setNotices(pn.data);
    setLaunchRevision(rev);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setNote('');
    const tooLong = [
      ['Legal business name', draft.legal_business_name, 200],
      ['Company number', draft.company_number, 50],
      ['Registered address', draft.registered_address, 500],
      ['Public contact e-mail', draft.public_contact_email, 320],
      ['Privacy contact e-mail', draft.privacy_contact_email, 320],
      ['Public telephone', draft.public_telephone, 25],
      ['Canonical website URL', draft.canonical_url, 500],
      ['Receipt identity footer', draft.receipt_identity_footer, 500],
      ['Notification recipient', draft.notification_recipient, 320],
    ].find(([, value, max]) => String(value).trim().length > Number(max));
    if (tooLong) {
      setNote(`Not saved (${tooLong[0]} is longer than ${tooLong[2]} characters).`);
      return;
    }
    if (draft.public_contact_email.trim() && !safeMailtoHref(draft.public_contact_email)) {
      setNote('Not saved (public contact e-mail is not a valid e-mail address).');
      return;
    }
    if (draft.privacy_contact_email.trim() && !safeMailtoHref(draft.privacy_contact_email)) {
      setNote('Not saved (privacy contact e-mail is not a valid e-mail address).');
      return;
    }
    if (draft.notification_recipient.trim() && !safeMailtoHref(draft.notification_recipient)) {
      setNote('Not saved (notification recipient is not a valid e-mail address).');
      return;
    }
    if (draft.public_telephone.trim() && !safeTelHref(draft.public_telephone)) {
      setNote('Not saved (public telephone is not a valid telephone number).');
      return;
    }
    if (draft.canonical_url.trim() && !safeCanonicalSiteHref(draft.canonical_url)) {
      setNote('Not saved (canonical website URL must be a public HTTPS root address, such as https://milkpop.uk/).');
      return;
    }
    const r = await saveLaunchSettings(draft, launchRevision);
    setNote(r.ok ? 'Saved.' : `Not saved (${r.error}). Owner sign-in with two-step verification is required.`);
    if (r.ok) {
      setLaunchRevision(r.data.revision);
      await load();
      await onSaved?.();
    }
  };
  const publish = async () => {
    setNote('');
    if (np.url.trim() && !safePolicyHref(np.url)) {
      setNote('Not published (policy URL must be HTTPS or a root-relative path such as /privacy/).');
      return;
    }
    const r = await publishPrivacyNotice(np.audience, np.version, np.text, np.url);
    setNote(r.ok ? `Published ${np.audience} notice ${np.version}.` : `Not published (${r.error}).`);
    if (r.ok) { setNp({ ...np, version: '', text: '' }); load(); }
  };

  const inputCls = 'w-full min-h-11 border border-[#EBDECE] rounded-lg p-2 text-base sm:text-sm';
  const field = (key: keyof LaunchSettingsRow, label: string, hint?: string) => (
    <label className="block text-xs font-bold text-stone-700">{label}
      <input className={inputCls} value={String(draft[key] ?? '')}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
      {hint && <span className="block text-[10px] font-normal text-stone-400 mt-0.5">{hint}</span>}
    </label>
  );
  const toggle = (key: keyof LaunchSettingsRow, label: string, hint: string) => (
    <label className="flex items-start gap-2 text-xs font-bold text-stone-700">
      <input type="checkbox" className="mt-0.5" checked={Boolean(draft[key])}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} />
      <span>{label}<span className="block text-[10px] font-normal text-stone-400">{hint}</span></span>
    </label>
  );

  return (
    <div className={box}>
      <h3 className="font-display font-bold text-xs uppercase tracking-wide">Launch Facts (owner)</h3>
      <p className="text-[11px] text-stone-500 leading-relaxed">
        These values come from you and your legal adviser — nothing is pre-filled.
        They gate store opening, public forms and receipts; the Launch Readiness
        panel above tracks each gap.
      </p>
      {status === 'loading' && <p className="text-xs text-stone-500">Loading launch facts…</p>}
      {status === 'unavailable' && <p className="text-xs text-stone-500">Launch facts are unavailable — owner sign-in (with two-step verification) is required to view or edit them.</p>}
      {status === 'ready' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {field('legal_business_name', 'Legal business name')}
          {field('company_number', 'Company number', 'Leave blank only if not incorporated.')}
          {field('registered_address', 'Registered / business address')}
          {field('public_contact_email', 'Public contact e-mail')}
          {field('privacy_contact_email', 'Privacy contact e-mail')}
          {field('public_telephone', 'Public telephone')}
          {field('canonical_url', 'Canonical website URL')}
          {field('receipt_identity_footer', 'Receipt identity footer')}
          {field('notification_recipient', 'Form notification recipient', 'Where owner alerts for public submissions are sent. Required before forms are commissioned.')}
          <div className="space-y-2 md:col-span-2">
            {toggle('telephone_alternative_ok', 'Approved alternative to a public telephone', 'Tick only if you have explicitly approved contact without a phone number.')}
            {toggle('vat_state_confirmed', 'VAT state confirmed', 'Confirm the VAT registration position with your accountant first.')}
            {toggle('customer_ack_enabled', 'Send customer acknowledgement e-mails', 'A receipt-of-submission note only; it never claims human review.')}
            {toggle('enforce_public_gates', 'Arm public launch gates', 'Once armed, forms require a notification recipient and published privacy notice. Menu publication follows the configured allergen mode; this release uses in-store disclosure, so approved allergen information must be available at the kiosk rather than represented as a complete online declaration.')}
          </div>
          <button onClick={save} className="min-h-11 px-4 rounded-lg bg-[#A46832] text-white text-xs font-bold cursor-pointer md:col-span-2 w-fit">Save launch facts</button>
        </div>
      )}
      <div className="border-t border-[#EBDECE] pt-3 space-y-2">
        <h4 className="text-xs font-extrabold text-[#2E2A26] uppercase">Privacy notices (versioned)</h4>
        <p className="text-[11px] text-stone-500 leading-relaxed">
          Each public form shows an acknowledgement of the published notice for its
          audience and stamps that version on the stored submission. Paste the text
          your legal adviser approved; publishing creates a new version.
        </p>
        <ul className="text-[11px] text-stone-600 space-y-1">
          {(['careers','franchise','contact'] as const).map((a) => {
            const current = notices.find((n) => n.audience === a && n.published_at);
            return <li key={a}><span className="font-bold">{a}</span>: {current ? `v ${current.version_label} (published ${new Date(current.published_at as string).toLocaleDateString('en-GB')})` : 'no published notice — the form gate will refuse once armed'}</li>;
          })}
        </ul>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <label className="block text-xs font-bold text-stone-700">Audience
            <select className={inputCls} value={np.audience} onChange={(e) => setNp({ ...np, audience: e.target.value as PrivacyNoticeRow['audience'] })}>
              <option value="careers">careers</option><option value="franchise">franchise</option><option value="contact">contact</option>
            </select>
          </label>
          <label className="block text-xs font-bold text-stone-700">Version label
            <input className={inputCls} value={np.version} onChange={(e) => setNp({ ...np, version: e.target.value })} placeholder="e.g. 2026-08-v1" />
          </label>
          <label className="block text-xs font-bold text-stone-700 md:col-span-2">Notice text (owner/legal supplied)
            <textarea className={inputCls} rows={3} value={np.text} onChange={(e) => setNp({ ...np, text: e.target.value })} />
          </label>
          <label className="block text-xs font-bold text-stone-700 md:col-span-2">Policy URL (optional)
            <input className={inputCls} value={np.url} onChange={(e) => setNp({ ...np, url: e.target.value })} placeholder="/privacy/ or https://…" />
            <span className="mt-1 block text-[11px] font-normal text-stone-500">Use an HTTPS address or a route on this website, such as /privacy/.</span>
          </label>
        </div>
        <button onClick={publish} className="min-h-11 px-4 rounded-lg border border-[#A46832] text-[#8F5322] text-xs font-bold cursor-pointer">Publish notice version</button>
      </div>
      {note && <p className="text-xs text-stone-600" role="status">{note}</p>}
    </div>
  );
}
