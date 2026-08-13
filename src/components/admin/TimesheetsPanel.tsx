import React, { useMemo } from 'react';
import type { ClockHistoryItem, EmployeeProfile } from '../../types';
import { effectiveHourlyRate } from '../../lib/pay';

interface TimesheetsPanelProps {
  clockHistory: ClockHistoryItem[];
  employees: EmployeeProfile[];
  busy: boolean;
  onApprove: (id: string) => void | Promise<void>;
  onReject: (id: string) => void | Promise<void>;
  onApproveAll: (pendingCount: number) => void | Promise<void>;
}

interface TimesheetSections {
  pending: ClockHistoryItem[];
  processed: ClockHistoryItem[];
}

function buildTimesheetSections(clockHistory: ClockHistoryItem[]): TimesheetSections {
  const sections: TimesheetSections = { pending: [], processed: [] };
  for (const item of clockHistory) {
    (item.approved || item.rejected ? sections.processed : sections.pending).push(item);
  }
  sections.pending.sort((a, b) => (b.clockIn || '').localeCompare(a.clockIn || ''));
  sections.processed.sort((a, b) => (b.clockIn || '').localeCompare(a.clockIn || ''));
  return sections;
}

/** Timesheet lists are projected once and rendered outside the Admin controller. */
export const TimesheetsPanel = React.memo(function TimesheetsPanel({
  clockHistory,
  employees,
  busy,
  onApprove,
  onReject,
  onApproveAll,
}: TimesheetsPanelProps) {
  const employeesById = useMemo(() => new Map(employees.map((employee) => [employee.id, employee])), [employees]);
  const sections = useMemo(() => buildTimesheetSections(clockHistory), [clockHistory]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="font-display font-black text-2xl">Timesheet Approvals</h1>
          <p className="text-2xs text-[#2E2A26]/70">Every clock-out lands here as <b>Pending</b>. Only hours you approve count towards earnings estimates.</p>
        </div>
        {sections.pending.length > 1 && (
          <button type="button" onClick={() => { void onApproveAll(sections.pending.length); }} disabled={busy} className="px-4 py-2 bg-[#5CA459] text-white rounded-full text-2xs tracking-wider uppercase font-black cursor-pointer hover:bg-[#4E8E4B] disabled:opacity-50 disabled:cursor-not-allowed">Approve all pending</button>
        )}
      </div>

      {(['pending', 'processed'] as const).map((section) => {
        const rows = sections[section];
        const visibleRows = section === 'processed' ? rows.slice(0, 40) : rows;
        return (
          <div key={section} className={`bg-white ${section === 'pending' ? 'mp-blob-l' : 'mp-blob-r'} border border-[#EBDECE] overflow-hidden mp-shadow`}>
            <div className="px-4 py-3 bg-[#F7EFE6] border-b border-[#EBDECE] flex items-center justify-between">
              <h3 className="font-display font-black text-xs uppercase tracking-wide">{section === 'pending' ? 'Awaiting approval' : 'Processed history'}</h3>
              <span className={`text-[9px] font-mono border px-2 py-0.5 rounded-full inline-block ${section === 'pending' && rows.length > 0 ? 'bg-[#A46832] text-white border-[#A46832] mp-tilt-r' : 'bg-white border-[#EBDECE] text-[#2E2A26]/60'}`}>{rows.length} entries</span>
            </div>
            {rows.length === 0 ? (
              <p className="text-center py-8 text-[#2E2A26]/40 font-mono text-[10px]">{section === 'pending' ? 'Nothing waiting — all caught up. 🥛' : 'No processed entries yet.'}</p>
            ) : (
              <table className="w-full text-left text-2xs">
                <thead className="border-b border-[#EBDECE] text-[9px] uppercase font-mono text-[#A5642B]"><tr><th className="p-3">Team member</th><th className="p-3">Date</th><th className="p-3">In → Out</th><th className="p-3">Break</th><th className="p-3 text-right">Hours</th><th className="p-3 text-right">Est. pay</th><th className="p-3 text-right">{section === 'pending' ? 'Decision' : 'Status'}</th></tr></thead>
                <tbody className="divide-y divide-[#EBDECE]/70 text-[#2E2A26]/80">
                  {visibleRows.map((entry) => {
                    const employee = employeesById.get(entry.employeeId);
                    const isSalary = employee?.payType === 'salary';
                    const rate = employee ? effectiveHourlyRate(employee) : null;
                    return (
                      <tr key={entry.id} className="hover:bg-[#F7EFE6]/60">
                        <td className="p-3 font-bold text-[#2E2A26]">{entry.employeeName}{entry.notes && <span className="block text-[9px] font-normal text-[#2E2A26]/45 italic">“{entry.notes}”</span>}</td>
                        <td className="p-3 font-mono text-[10px]">{new Date(`${entry.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                        <td className="p-3 font-mono text-[10px]">{new Date(entry.clockIn).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} → {entry.clockOut ? new Date(entry.clockOut).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td className="p-3 font-mono text-[10px]">{entry.breakDurationMinutes || 0} min</td>
                        <td className="p-3 text-right font-mono font-bold">{(entry.totalDecimalHours || 0).toFixed(2)}</td>
                        <td className="p-3 text-right font-mono">{isSalary ? <span className="text-neutral-400 italic font-sans">Payroll handled separately</span> : rate === null ? <span className="text-neutral-400 italic font-sans">Pay rate not configured</span> : `£${((entry.totalDecimalHours || 0) * rate).toFixed(2)}`}</td>
                        <td className="p-3 text-right">{section === 'pending' ? <div className="flex justify-end gap-1.5"><button type="button" onClick={() => { void onApprove(entry.id); }} disabled={busy} className="px-2.5 py-1 bg-[#5CA459] hover:bg-[#4E8E4B] text-white rounded font-black text-[9px] uppercase cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Approve</button><button type="button" onClick={() => { void onReject(entry.id); }} disabled={busy} className="px-2.5 py-1 border border-red-300 text-red-500 hover:bg-red-50 rounded font-black text-[9px] uppercase cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">Reject</button></div> : entry.rejected ? <span className="text-[9px] font-black uppercase text-red-500">Rejected · {entry.approvedBy}</span> : <span className="text-[9px] font-black uppercase text-emerald-600">Approved · {entry.approvedBy}</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
});
