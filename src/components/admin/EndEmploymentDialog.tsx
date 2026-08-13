/**
 * @file EndEmploymentDialog.tsx
 * @description R4.8 Workstream B — replaces the old destructive "Delete
 * employee" flow. Normal leavers get "End employment" (history preserved,
 * access revoked); the owner-only duplicate purge is tucked behind an
 * explicit expander with typed-name confirmation, and the SERVER still
 * refuses it whenever dependent history exists.
 */
import React, { useState } from 'react';
import { endEmployment, purgeEmployee } from '../../lib/employment';
import { businessTodayISO } from '../../lib/businessDate';

interface Props {
  employee: { id: string; name: string };
  isOwner: boolean;
  onClose: () => void;
  onDone: (message: string, tone: 'success' | 'warning' | 'error') => void;
}

export default function EndEmploymentDialog({ employee, isOwner, onClose, onDone }: Props) {
  const today = businessTodayISO();
  const [endDate, setEndDate] = useState(today);
  const [reason, setReason] = useState('resignation');
  const [notes, setNotes] = useState('');
  const [immediate, setImmediate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showPurge, setShowPurge] = useState(false);
  const [typedName, setTypedName] = useState('');

  const submit = async () => {
    setBusy(true);
    const r = await endEmployment({ employeeId: employee.id, endDate, reason, notes, immediate });
    setBusy(false);
    if (r.ok) { onDone(`Employment ended for ${employee.name}. ${r.detail}`, 'success'); onClose(); }
    else onDone(r.error, 'error');
  };

  const purge = async () => {
    setBusy(true);
    const r = await purgeEmployee(employee.id, typedName);
    setBusy(false);
    if (r.ok) { onDone(`Duplicate profile "${employee.name}" removed.`, 'warning'); onClose(); }
    else onDone(r.error, 'error');
  };

  const inputCls = 'w-full border border-[#EBDECE] rounded-lg p-2 text-xs';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={`End employment for ${employee.name}`}>
      <div className="bg-white rounded-2xl border border-[#EBDECE] w-full max-w-md p-6 space-y-4">
        <h3 className="font-display font-extrabold text-sm uppercase tracking-wide text-[#2E2A26]">End employment — {employee.name}</h3>
        <p className="text-xs text-stone-600 leading-relaxed">
          This records the departure, disables platform access and revokes active sessions,
          flags future shifts, and keeps every historic shift, order, document, training and
          audit record. The person stays visible under “Leavers”. Nothing is deleted.
        </p>
        <label className="block text-xs font-bold text-stone-700">Employment end date
          <input type="date" className={inputCls} value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
        <label className="block text-xs font-bold text-stone-700">Reason
          <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="resignation">Resignation</option>
            <option value="end_of_contract">End of contract</option>
            <option value="dismissal">Dismissal</option>
            <option value="redundancy">Redundancy</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label className="block text-xs font-bold text-stone-700">Notes (payroll / handover)
          <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-xs font-bold text-stone-700">
          <input type="checkbox" checked={immediate} onChange={(e) => setImmediate(e.target.checked)} />
          Remove access immediately (otherwise on the end date)
        </label>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} disabled={busy} className="min-h-11 px-4 rounded-lg border border-[#EBDECE] text-xs font-bold text-stone-600 cursor-pointer">Cancel</button>
          <button onClick={submit} disabled={busy} className="min-h-11 px-4 rounded-lg bg-[#A46832] text-white text-xs font-bold cursor-pointer disabled:opacity-50">{busy ? 'Working…' : 'End employment'}</button>
        </div>

        {isOwner && (
          <div className="border-t border-[#EBDECE] pt-3">
            {!showPurge ? (
              <button onClick={() => setShowPurge(true)} className="text-[11px] font-bold text-red-500 underline cursor-pointer">
                This profile is a mistaken duplicate with no history…
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-red-600 leading-relaxed font-medium">
                  Permanent removal is allowed only for a duplicate created by mistake.
                  The server refuses if any shifts, pay, documents, training, compliance
                  or reports reference this profile. Type the full name to confirm.
                </p>
                <input className={inputCls} placeholder={employee.name} value={typedName} onChange={(e) => setTypedName(e.target.value)} aria-label="Type the employee's full name to confirm" />
                <button onClick={purge} disabled={busy || typedName !== employee.name}
                  className="min-h-11 px-4 rounded-lg bg-red-600 text-white text-xs font-bold cursor-pointer disabled:opacity-40">
                  Permanently remove duplicate
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
