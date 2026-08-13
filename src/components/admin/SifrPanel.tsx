import React from 'react';
import type { SIFRReport } from '../../types';
import { isSifrOpenStatus } from './adminDashboard';

interface SifrPanelProps {
  reports: SIFRReport[];
  busy: boolean;
  onResolve: (report: SIFRReport) => void | Promise<void>;
}

/** Read-only incident desk. The guarded lifecycle mutation stays in AdminPanel. */
export const SifrPanel = React.memo(function SifrPanel({ reports, busy, onResolve }: SifrPanelProps) {
  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="font-display font-black text-2xl text-[#2E2A26]">Staff Incident &amp; Feedback Desk</h1>
        <p className="text-2xs text-[#2E2A26]/70">Record timeline investigation logs, analyse escalated reports, and handle disputes neutrally.</p>
      </div>

      <div className="space-y-4">
        {reports.map((report) => {
          const isOpen = isSifrOpenStatus(report.status);
          return (
            <div key={report.id} className="p-5 bg-white rounded-2xl border border-[#EBDECE]/50 space-y-3 font-sans text-2xs">
              <div className="flex justify-between items-center pb-2 border-b">
                <div className="space-y-0.5">
                  <span className="text-[10px] bg-amber-50 text-[#A46832] px-2 py-0.5 rounded font-mono font-bold uppercase">{report.category}</span>
                  <h4 className="font-extrabold text-sm text-[#2E2A26]">{report.title}</h4>
                </div>
                <span className={`text-[9px] font-black uppercase px-2.5 py-1 rounded-full ${isOpen ? 'bg-red-50 text-red-500' : 'bg-[#5CA459]/20 text-[#5CA459]'}`}>
                  {report.status.toUpperCase()}
                </span>
              </div>

              <p className="text-stone-600 font-medium leading-relaxed pr-6">{report.description}</p>
              <p className="text-[10px] text-zinc-400 font-mono">
                Reported by: <b>{report.reporterName}</b>
                {report.confidentiality === 'confidential' && <span> · Sensitive report — identity visible to authorised management</span>}
                {' | '}Involved party: <b>{report.involvedPeople}</b>
              </p>

              {isOpen && (
                <div className="pt-3 border-t flex justify-end">
                  <button
                    type="button"
                    onClick={() => { void onResolve(report); }}
                    disabled={busy}
                    className="px-4 py-2 bg-[#5CA459] hover:bg-[#4E8E4B] text-white font-extrabold text-[9px] rounded-full uppercase cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Mark Resolved
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {reports.length === 0 && (
          <div className="rounded-2xl border border-dashed border-[#EBDECE] bg-white p-8 text-center text-sm text-[#2E2A26]/60">No incident reports are available.</div>
        )}
      </div>
    </div>
  );
});
