import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import type { AuditLogItem, EmployeeRole } from '../../types';
import { getAccessToken as freshStaffToken } from '../../lib/auth';
import { listActivityLog, type ActivityLogEntry } from '../../lib/activityLog';
import { useSingleFlight } from '../../hooks/useSingleFlight';

interface AuditPanelProps {
  auditLogs: AuditLogItem[];
  currentRole: EmployeeRole;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
}

/** Audit presentation and its owner-only, load-on-demand server access log. */
export const AuditPanel = React.memo(function AuditPanel({ auditLogs, currentRole, addToast }: AuditPanelProps) {
  const [accessLog, setAccessLog] = useState<ActivityLogEntry[] | null>(null);
  const loading = useSingleFlight();

  const loadAccessLog = async (): Promise<void> => loading.run('audit:load-access-log', async () => {
    const token = await freshStaffToken();
    if (!token) {
      addToast('Your session has expired. Sign in again.', 'error');
      return;
    }
    const result = await listActivityLog(token, 200);
    if (result.ok === false) {
      addToast(result.message, 'error');
      return;
    }
    setAccessLog(result.data);
  });

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-4">
        <div>
          <h1 className="font-display font-black text-2xl">Activity &amp; Access Logs</h1>
          <p className="text-2xs text-[#2E2A26]/70">Operational activity recorded by the application, plus the server-side access log for sensitive actions.</p>
        </div>
        <div className="shrink-0 max-w-[16rem] flex items-start gap-2 bg-[#F7EFE6] border border-[#EBDECE] rounded-xl px-3 py-2">
          <Lock className="h-3.5 w-3.5 text-[#A46832] mt-0.5 shrink-0" />
          <p className="text-[10px] text-[#2E2A26]/70 leading-snug">Informational trail. The tamper-evident record lives in the server-side, append-only audit log (owner-only) and can&apos;t be edited or purged from here.</p>
        </div>
      </div>

      <div className="space-y-3 font-mono text-2xs animate-fade-in text-[#2E2A26]">
        {auditLogs.map((log) => (
          <div key={log.id} className="p-4 bg-white rounded-2xl border border-[#EBDECE]/60 space-y-1.5 flex justify-between items-start">
            <div className="space-y-1 flex-1">
              <div className="flex items-center gap-2"><span className="text-[9px] bg-[#EBDECE] text-zinc-650 px-2 py-0.5 rounded font-bold uppercase">{log.module}</span><span className="text-[10px] text-zinc-400">{new Date(log.timestamp).toLocaleString()}</span></div>
              <p className="leading-relaxed"><b>{log.operatorName}</b> ({log.role}) triggered action: <u className="no-underline text-[#A46832] font-extrabold">{log.action}</u></p>
              {log.previousValue && <p className="p-2 bg-stone-50 rounded border text-[9px] text-zinc-550 italic">Modified from “{log.previousValue}” to “{log.newValue}”</p>}
            </div>
          </div>
        ))}
        {auditLogs.length === 0 && <div className="rounded-2xl border border-dashed border-[#EBDECE] bg-white p-8 text-center text-sm text-[#2E2A26]/60">No browser operational events are available.</div>}
      </div>

      {currentRole === 'owner' && (
        <div className="bg-white p-6 rounded-3xl border border-[#EBDECE] space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div><h3 className="font-display text-xs uppercase font-extrabold tracking-widest text-[#A46832]">Server access log</h3><p className="text-[10px] text-[#2E2A26]/60 leading-snug mt-1">Document opens, uploads and deletions, staff invitations and account changes, CV access — recorded by the server with the verified actor. Append-only; owner-only.</p></div>
            <button type="button" disabled={loading.isBusy} onClick={() => { void loadAccessLog(); }} className="shrink-0 text-[9px] px-3 py-1.5 rounded-full bg-[#2E2A26] text-white font-black uppercase cursor-pointer disabled:opacity-50">{loading.isBusy ? 'Loading…' : accessLog ? 'Refresh' : 'Load log'}</button>
          </div>
          {accessLog && (accessLog.length === 0 ? (
            <p className="text-[10px] text-stone-400 italic">No server-side access events recorded yet.</p>
          ) : (
            <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
              {accessLog.map((entry) => (
                <div key={entry.id} className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[10px] p-2 rounded-lg border ${entry.outcome === 'denied' || entry.outcome === 'error' ? 'border-red-200 bg-red-50/50' : 'border-[#EBDECE]/60 bg-[#F7EFE6]/40'}`}>
                  <span className="font-mono text-[9px] text-stone-400 shrink-0">{entry.createdAt.replace('T', ' ').slice(0, 19)}</span><b className="text-[#2E2A26]">{entry.actorName || 'system'}</b><span className="text-stone-400">({entry.actorRole || '—'})</span><span className="font-extrabold text-[#A46832]">{entry.action}</span>{entry.targetKind && <span className="text-stone-500">{entry.targetKind}{entry.targetRef ? ` · ${entry.targetRef}` : ''}</span>}<span className={`ml-auto px-1.5 py-0.5 rounded-full text-[8px] font-black uppercase ${entry.outcome === 'denied' || entry.outcome === 'error' ? 'bg-red-100 text-red-600' : 'bg-[#5CA459]/15 text-[#4E8E4B]'}`}>{entry.outcome}</span>{entry.detail && <span className="basis-full text-stone-400 italic">{entry.detail}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
