import React from 'react';
import type { FranchiseInquiry } from '../../types';
import { InboxStatusBar, type InboxStatus } from './InboxStatusBar';

interface FranchisePanelProps {
  inquiries: FranchiseInquiry[];
  inboxStatus: InboxStatus;
  busy: boolean;
  onRefreshInbox: () => void;
  onStatusChange: (inquiry: FranchiseInquiry, status: 'contacted' | 'approved') => void | Promise<void>;
}

/** Franchise lead presentation. Status transitions remain guarded by AdminPanel. */
export const FranchisePanel = React.memo(function FranchisePanel({
  inquiries,
  inboxStatus,
  busy,
  onRefreshInbox,
  onStatusChange,
}: FranchisePanelProps) {
  return (
    <div className="space-y-6">
      <InboxStatusBar status={inboxStatus} onRefresh={onRefreshInbox} />
      <div>
        <h1 className="font-display font-black text-2xl">Franchise Enquiry Leads</h1>
        <p className="text-2xs text-[#2E2A26]/70">Track investment opportunities, qualify licensing candidates, city expansion vectors and coordinate screens.</p>
      </div>

      <div className="space-y-4 text-2xs font-sans">
        {inquiries.map((inquiry) => (
          <div key={inquiry.id} className="p-4 bg-white rounded-2xl border border-[#EBDECE]/50 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="space-y-1.5 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-sm text-[#2E2A26]">{inquiry.fullName}</span>
                <span className="text-[8px] bg-sky-50 text-sky-700 border border-sky-150 px-2 py-0.5 rounded font-mono font-bold uppercase">Budget: {inquiry.budget}</span>
              </div>
              <p className="text-zinc-500 font-semibold">City Target: <b>{inquiry.city} ({inquiry.country})</b> | Experience: “{inquiry.experience}”</p>
              <p className="text-[11px] bg-stone-50 p-3 rounded-xl border border-dotted font-light text-[#2E2A26]/85 font-mono">Budget note: “{inquiry.message}”</p>
            </div>

            <div className="flex flex-col items-end gap-2 shrink-0">
              <span className={`text-[8px] font-black uppercase tracking-widest px-2.5 py-1 rounded-full ${inquiry.status === 'approved' ? 'bg-[#5CA459]/20 text-[#5CA459]' : 'bg-amber-100 text-[#A46832]'}`}>
                {inquiry.status === 'approved' ? 'SUITABLE' : inquiry.status.toUpperCase()}
              </span>
              {inquiry.status !== 'approved' && (
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => { void onStatusChange(inquiry, 'contacted'); }} disabled={busy} className="px-3 py-1.5 border border-amber-300 text-[#A46832] font-extrabold rounded-full uppercase text-[9px] hover:bg-amber-50 cursor-pointer disabled:opacity-50">Mark Contacted</button>
                  <button type="button" onClick={() => { void onStatusChange(inquiry, 'approved'); }} disabled={busy} className="px-3 py-1.5 bg-[#A46832] hover:bg-[#A5642B] text-white font-extrabold rounded-full uppercase text-[9px] cursor-pointer disabled:opacity-50">Mark Suitable</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {inquiries.length === 0 && (
          <div className="rounded-2xl border border-dashed border-[#EBDECE] bg-white p-8 text-center text-sm text-[#2E2A26]/60">No franchise enquiries are available.</div>
        )}
      </div>
    </div>
  );
});
