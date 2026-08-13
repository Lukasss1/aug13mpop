/** Customer mailbox presentation. Mutations remain in AdminPanel guards. */
import React, { useMemo, useState } from 'react';
import type { ContactMessage } from '../../types';
import { safeMailtoHref } from '../../lib/safeUrl';
import { buildAdminContactMailbox, type AdminContactFilter } from './adminContact';
import { InboxStatusBar, type InboxStatus } from './InboxStatusBar';

interface ContactInboxPanelProps {
  messages: ContactMessage[];
  inboxStatus: InboxStatus;
  emailEnabled: boolean;
  busy: boolean;
  onRefreshInbox: () => void;
  onComposeReply: (message: ContactMessage) => void;
  onStatusChange: (message: ContactMessage, status: ContactMessage['status']) => void | Promise<void>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
}

export const ContactInboxPanel = React.memo(function ContactInboxPanel({
  messages,
  inboxStatus,
  emailEnabled,
  busy,
  onRefreshInbox,
  onComposeReply,
  onStatusChange,
  addToast,
}: ContactInboxPanelProps) {
  const [filter, setFilter] = useState<AdminContactFilter>('new');
  const mailbox = useMemo(() => buildAdminContactMailbox(messages, filter), [messages, filter]);

  const beginReply = (message: ContactMessage): void => {
    if (emailEnabled) {
      onComposeReply(message);
      return;
    }
    const mailto = safeMailtoHref(message.email);
    if (mailto) {
      const href = `${mailto}?subject=${encodeURIComponent(`Re: ${message.reason}`)}`;
      // A mailto navigation does not need a pop-up. Using the current browsing
      // context avoids pop-up blockers while the operating system opens the
      // configured mail application.
      window.location.assign(href);
      return;
    }
    addToast('This sender address is not a valid e-mail, so a reply cannot be opened safely.', 'error');
  };

  return (
    <div className="space-y-6">
      <InboxStatusBar status={inboxStatus} onRefresh={onRefreshInbox} />
      <div>
        <h1 className="font-display font-black text-2xl">Customer Contact Mailbox</h1>
        <p className="text-2xs text-[#2E2A26]/70">Review consumer feedback tickets, record delivery inquiries, and write personalized email replies.</p>
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Customer message status filter">
        {(['new', 'replied', 'closed', 'all'] as const).map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={filter === status}
            onClick={() => setFilter(status)}
            className={`min-h-11 rounded-full px-4 text-[10px] font-black uppercase tracking-wider ${filter === status ? 'bg-[#2E2A26] text-white' : 'bg-white border border-[#EBDECE] text-[#2E2A26]'}`}
          >
            {status} ({mailbox.counts[status]})
          </button>
        ))}
      </div>

      <div className="space-y-4 font-sans text-sm">
        {mailbox.visibleMessages.map((message) => (
          <div key={message.id} className="p-4 bg-white rounded-2xl border border-[#EBDECE]/50 space-y-3">
            <div className="flex flex-wrap justify-between items-center gap-2 pb-2 border-b">
              <span className="font-extrabold text-sm text-[#2E2A26]">{message.fullName} ({message.email})</span>
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase font-mono font-black text-[#A46832]">{message.reason}</span>
                <span className={`rounded-full px-2 py-1 text-[9px] font-black uppercase ${message.status === 'new' ? 'bg-amber-100 text-amber-800' : message.status === 'replied' ? 'bg-emerald-100 text-emerald-800' : 'bg-stone-100 text-stone-600'}`}>{message.status}</span>
              </div>
            </div>
            <p className="text-[#2E2A26]/80 font-medium leading-relaxed">Message: “{message.message}”</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => beginReply(message)} className="min-h-11 px-4 bg-[#2E2A26] hover:bg-[#4B4540] uppercase font-black text-[10px] text-white rounded-full cursor-pointer tracking-wider">{emailEnabled ? 'Write reply' : 'Open mail app'}</button>
              {message.status !== 'replied' && (
                <button type="button" onClick={() => { void onStatusChange(message, 'replied'); }} disabled={busy} className="min-h-11 px-4 border border-emerald-300 text-emerald-800 rounded-full text-[10px] font-black uppercase disabled:opacity-50 disabled:cursor-not-allowed">Mark replied</button>
              )}
              {message.status !== 'closed' ? (
                <button type="button" onClick={() => { void onStatusChange(message, 'closed'); }} disabled={busy} className="min-h-11 px-4 border border-stone-300 text-stone-700 rounded-full text-[10px] font-black uppercase disabled:opacity-50 disabled:cursor-not-allowed">Close</button>
              ) : (
                <button type="button" onClick={() => { void onStatusChange(message, 'new'); }} disabled={busy} className="min-h-11 px-4 border border-amber-300 text-amber-800 rounded-full text-[10px] font-black uppercase disabled:opacity-50 disabled:cursor-not-allowed">Reopen</button>
              )}
            </div>
          </div>
        ))}
        {mailbox.visibleMessages.length === 0 && (
          <div className="rounded-2xl border border-dashed border-[#EBDECE] bg-white p-8 text-center text-sm text-[#2E2A26]/60">No {filter === 'all' ? '' : filter} customer messages.</div>
        )}
      </div>
    </div>
  );
});
