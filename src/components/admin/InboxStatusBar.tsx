import React from 'react';
import { RefreshCw } from 'lucide-react';

export type InboxStatus = 'idle' | 'loading' | 'live' | 'error' | 'unavailable';

/**
 * Live-inbox status bar for the Applications / Franchise / Contact views.
 * Submissions are read from the database under the signed-in user's JWT.
 */
const INBOX_STATUS_STYLES: Record<InboxStatus, { box: string; dot: string; label: string; text: string }> = {
    live: {
      box: 'border-[#5CA459]/40 bg-[#5CA459]/10', dot: 'bg-[#5CA459]',
      label: 'Live inbox',
      text: 'Showing real submissions from the database — new entries appear on refresh.',
    },
    loading: {
      box: 'border-[#7CC0C7]/50 bg-[#7CC0C7]/10', dot: 'bg-[#7CC0C7] animate-pulse',
      label: 'Loading…',
      text: 'Fetching the latest submissions from the database.',
    },
    error: {
      box: 'border-[#A46832] bg-amber-50', dot: 'bg-[#A46832]',
      label: 'Could not load the inbox',
      text: 'The database did not respond. Check your connection and try again — submissions are safe on the server.',
    },
    unavailable: {
      box: 'border-[#A46832] bg-amber-50', dot: 'bg-[#A46832]',
      label: 'No database connected',
      text: 'This build has no Supabase connection, so only submissions made in this browser session are listed.',
    },
    idle: {
      box: 'border-[#EBDECE] bg-white', dot: 'bg-stone-300',
      label: 'Inbox',
      text: 'Sign in as a manager or owner to load submissions.',
    },
};

export const InboxStatusBar = React.memo(function InboxStatusBar({
  status,
  onRefresh,
}: { status: InboxStatus; onRefresh: () => void }) {
  const style = INBOX_STATUS_STYLES[status];
  return (
    <div role="status" className={`p-4 rounded-2xl border-2 ${style.box} text-[#2E2A26] text-xs font-sans leading-relaxed flex items-center justify-between gap-4 flex-wrap`}>
      <div className="flex items-start gap-2.5 min-w-0">
        <span className={`mt-0.5 h-2.5 w-2.5 rounded-full shrink-0 ${style.dot}`} aria-hidden="true" />
        <div>
          <p className="font-black uppercase tracking-wider text-[10px] mb-0.5">{style.label}</p>
          <p className="font-semibold opacity-90">{style.text}</p>
        </div>
      </div>
      <button
        onClick={onRefresh}
        disabled={status === 'loading'}
        className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-full bg-[#2E2A26] text-white text-[10px] font-black uppercase tracking-wider hover:bg-[#A46832] transition-colors disabled:opacity-50 disabled:cursor-wait cursor-pointer"
      >
        <RefreshCw className={`h-3 w-3 ${status === 'loading' ? 'animate-spin' : ''}`} />
        Refresh
      </button>
    </div>
  );
});
