import React, { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';

interface PublicWebsiteEditBarProps {
  isOwner: boolean;
  isEditing: boolean;
  onStart: () => void;
  onCancel: () => void;
  onPublish: () => Promise<void>;
  onEditMenu: () => void;
}

/** Owner-only website editing controls. Catalogue editing is deliberately routed
 * to Admin → Menu so the public projection can never become a replacement
 * payload for the full catalogue. */
export function PublicWebsiteEditBar({
  isOwner, isEditing, onStart, onCancel, onPublish, onEditMenu,
}: PublicWebsiteEditBarProps) {
  const [publishing, setPublishing] = useState(false);
  if (!isOwner) return null;

  if (!isEditing) {
    return (
      <div className="fixed bottom-6 right-6 z-50">
        <button
          type="button"
          onClick={onStart}
          className="min-h-11 flex items-center gap-2 bg-[#2E2A26] hover:bg-[#A46832] text-white px-5 py-3 rounded-full font-bold uppercase tracking-wider text-xs shadow-xl transition-all"
        >
          <SlidersHorizontal className="h-4 w-4" />
          Edit website
        </button>
      </div>
    );
  }

  return (
    <div className="fixed top-0 left-0 w-full bg-indigo-900 border-b border-indigo-950 text-white z-[100] px-4 py-3 shadow-xl">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="bg-indigo-600 px-3 py-1 rounded-full text-2xs font-extrabold tracking-widest text-indigo-100 uppercase">Editing mode</span>
          <span className="text-sm font-medium text-indigo-200">Changes are not live until published.</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onEditMenu} disabled={publishing} className="min-h-11 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-bold transition-all text-white disabled:opacity-50">Edit menu</button>
          <button type="button" onClick={onCancel} disabled={publishing} className="min-h-11 px-4 py-2 bg-indigo-800 hover:bg-indigo-700 rounded-lg text-xs font-bold transition-all text-white disabled:opacity-50">Cancel</button>
          <button
            type="button"
            disabled={publishing}
            onClick={() => void (async () => {
              setPublishing(true);
              try { await onPublish(); } finally { setPublishing(false); }
            })()}
            className="min-h-11 px-5 py-2 bg-emerald-500 hover:bg-emerald-400 text-white rounded-lg text-xs font-bold tracking-wide transition-all shadow-md disabled:opacity-50"
          >
            {publishing ? 'Publishing…' : 'Publish changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
