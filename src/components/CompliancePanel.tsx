/**
 * @file CompliancePanel.tsx
 * @description R4.8 Workstream A1 — the staff Compliance Status widget.
 *
 * Every label is derived from staff_compliance_records via the audited
 * staff_compliance_overview() RPC. There are NO hardcoded business facts:
 *   • no rows            → each core category shows "Not recorded" (grey)
 *   • pending            → "Pending verification" (amber)
 *   • verified           → "Verified" + real expiry, from server dates
 *   • expiring/expired   → computed by the SERVER clock, never asserted here
 *   • load failure       → an honest "Unavailable" error state, not a guess
 * The summary line states only what the records actually show.
 */
import React, { useEffect, useState } from 'react';
import { callRpc } from '../lib/registries';
import { getAccessToken } from '../lib/auth';

type EffectiveStatus =
  | 'not_recorded' | 'pending_verification' | 'verified' | 'expiring'
  | 'expired' | 'rejected' | 'revoked' | 'not_applicable';

interface OverviewRow {
  id: string;
  employee_id: string;
  compliance_type: string;
  effective_status: EffectiveStatus;
  issued_at: string | null;
  expires_at: string | null;
  verified_at: string | null;
  notes: string;
}

const CORE_TYPES: Array<{ key: string; label: string }> = [
  { key: 'right_to_work', label: 'Right to Work' },
  { key: 'food_hygiene_l2', label: 'Food Hygiene L2' },
  { key: 'employment_contract', label: 'Employment Contract' },
  { key: 'fire_safety', label: 'Fire Safety Cert' },
];

const STATUS_META: Record<EffectiveStatus, { text: string; dot: string }> = {
  not_recorded: { text: 'Not recorded', dot: 'bg-gray-300' },
  pending_verification: { text: 'Pending verification', dot: 'bg-amber-400' },
  verified: { text: 'Verified', dot: 'bg-[#5FA777]' },
  expiring: { text: 'Expiring soon', dot: 'bg-amber-400' },
  expired: { text: 'Expired', dot: 'bg-red-400' },
  rejected: { text: 'Rejected', dot: 'bg-red-400' },
  revoked: { text: 'Revoked', dot: 'bg-red-400' },
  not_applicable: { text: 'Not applicable', dot: 'bg-gray-300' },
};

function expiryLabel(row: OverviewRow | undefined): string {
  if (!row) return STATUS_META.not_recorded.text;
  const meta = STATUS_META[row.effective_status] || STATUS_META.not_recorded;
  if ((row.effective_status === 'verified' || row.effective_status === 'expiring') && row.expires_at) {
    return `${meta.text} · exp. ${new Date(row.expires_at).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`;
  }
  return meta.text;
}

export default function CompliancePanel() {
  const [rows, setRows] = useState<OverviewRow[] | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) throw new Error('no_session');
        const r = await callRpc<OverviewRow[]>('staff_compliance_overview', { p_employee_id: null }, token);
        if (live) setRows(Array.isArray(r) ? r : []);
      } catch {
        if (live) { setRows([]); setError('unavailable'); }
      }
    })();
    return () => { live = false; };
  }, []);

  const byType = new Map<string, OverviewRow>();
  for (const r of rows || []) if (!byType.has(r.compliance_type)) byType.set(r.compliance_type, r);

  const verifiedCount = CORE_TYPES.filter((t) => byType.get(t.key)?.effective_status === 'verified').length;
  const attention = CORE_TYPES.filter((t) => {
    const s = byType.get(t.key)?.effective_status;
    return s === 'expiring' || s === 'expired' || s === 'revoked' || s === 'rejected';
  }).length;

  let summary: string;
  if (error) summary = 'Compliance records are unavailable right now. Please try again, or ask your manager.';
  else if (rows === null) summary = 'Loading your compliance records…';
  else if (verifiedCount === CORE_TYPES.length) summary = 'All core compliance records are verified. Contact your manager before anything expires.';
  else if (attention > 0) summary = `${attention} compliance ${attention === 1 ? 'item needs' : 'items need'} attention. Please speak to your manager.`;
  else summary = 'Some compliance records are not yet recorded or verified. Your manager records and verifies these — nothing is assumed on your behalf.';

  return (
    <div className="lg:col-span-4 bg-white p-6 rounded-3xl border border-[#EBDECE] space-y-6">
      <h3 className="font-display text-xs uppercase font-extrabold tracking-widest text-[#A46832]">Compliance Status</h3>

      <div className="space-y-4">
        {CORE_TYPES.map((t) => {
          const row = byType.get(t.key);
          const meta = STATUS_META[row?.effective_status || 'not_recorded'];
          return (
            <div key={t.key} className="flex items-center justify-between p-3 bg-neutral-50 rounded-xl border border-neutral-100">
              <div className="flex items-center space-x-3">
                <div className={`h-2 w-2 rounded-full ${meta.dot}`} />
                <span className="text-xs font-black uppercase text-[#2E2A26]">{t.label}</span>
              </div>
              <span className="text-xs font-bold text-gray-600">
                {rows === null ? '…' : expiryLabel(row)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="bg-[#FFFFFF] p-4 rounded-xl border border-[#EBDECE]/50 text-center">
        <p className="text-xs text-[#2E2A26] font-normal leading-relaxed">{summary}</p>
      </div>
    </div>
  );
}
