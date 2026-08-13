import React from 'react';
import type { PublishableContentTable } from '../../types';

interface PublicationBadgeProps {
  live: boolean;
  closed?: boolean;
}

/** Stable, stateless lifecycle badge shared by every public content card. */
export const PublicationBadge = React.memo(function PublicationBadge({ live, closed = false }: PublicationBadgeProps) {
  return (
    <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded-full ${
      closed ? 'bg-stone-200 text-stone-500'
      : live ? 'bg-[#5CA459]/20 text-[#5CA459]'
      : 'bg-[#A5642B]/15 text-[#A5642B]'}`}>
      {closed ? 'Closed' : live ? 'Published' : 'Draft'}
    </span>
  );
});

interface PublishButtonProps {
  table: PublishableContentTable;
  id: string;
  live: boolean;
  label: string;
  canPublish: boolean;
  busyAction: string | null;
  onToggle: (table: PublishableContentTable, id: string, publish: boolean, label: string) => Promise<void>;
}

/**
 * Stable publication control. The caller owns permission and the server RPC;
 * this component only renders one honest, disabled-while-busy button.
 */
export const PublishButton = React.memo(function PublishButton({
  table, id, live, label, canPublish, busyAction, onToggle,
}: PublishButtonProps) {
  if (!canPublish) return null;
  const busyKey = `publish:${table}:${id}`;
  return (
    <button
      onClick={() => { void onToggle(table, id, !live, label); }}
      disabled={busyAction !== null}
      className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
        live ? 'bg-stone-100 text-stone-600 hover:bg-stone-200' : 'bg-[#5CA459]/15 text-[#5CA459] hover:bg-[#5CA459]/25'}`}
    >
      {busyAction === busyKey ? '…' : live ? 'Unpublish' : 'Publish'}
    </button>
  );
});
