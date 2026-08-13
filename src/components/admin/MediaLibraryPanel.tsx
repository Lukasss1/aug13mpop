import React, { useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { MediaItem } from '../../types';
import { MEDIA_V2 } from '../../lib/featureFlags';
import { ACCEPTED_IMAGE_ACCEPT_ATTR, processAndUploadImage } from '../../lib/mediaUpload';
import { businessTodayISO } from '../../lib/businessDate';
import { createClientId } from '../../lib/clientId';
import { useSingleFlight } from '../../hooks/useSingleFlight';

interface MediaLibraryPanelProps {
  mediaItems: MediaItem[];
  publishMediaItems: (next: MediaItem[] | ((previous: MediaItem[]) => MediaItem[])) => Promise<boolean>;
  addToast: (message: string, type: 'success' | 'warning' | 'error' | 'info') => void;
  logAction: (module: string, action: string, previousValue?: string, newValue?: string) => void;
}

/**
 * Bounded Media Library workflow.
 *
 * Upload state belongs here so an in-progress upload or a file-input change
 * cannot rerender the entire admin controller. Persistence and audit semantics
 * are unchanged: storage first, then the canonical media collection, then the
 * browser audit entry only after both steps succeed.
 */
export const MediaLibraryPanel = React.memo(function MediaLibraryPanel({
  mediaItems,
  publishMediaItems,
  addToast,
  logAction,
}: MediaLibraryPanelProps) {
  const { isBusy, run } = useSingleFlight();

  const handleUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    void run('media:upload', async () => {
      try {
        const result = await processAndUploadImage(file, { altText: file.name });
        if (result.status !== 'uploaded') {
          addToast(result.message, 'error');
          return;
        }

        const asset: MediaItem = {
          id: createClientId('media'),
          name: file.name,
          folder: 'products',
          size: `${Math.max(1, Math.round(file.size / 1024))} KB`,
          type: 'image/webp',
          uploadedAt: businessTodayISO(),
          url: result.url,
        };
        const saved = await publishMediaItems((previous) => [asset, ...previous]);
        if (!saved) {
          addToast('The image reached storage, but its Media Library record was not saved. Retry before using it.', 'warning');
          return;
        }

        logAction('Media Library', `Uploaded media file "${file.name}"`);
        addToast(`"${file.name}" added to the media library.`, 'success');
      } catch (error) {
        addToast(
          error instanceof Error
            ? `Image upload failed: ${error.message}`
            : 'Image upload failed. Check your connection and retry.',
          'error',
        );
      }
    });
  }, [addToast, logAction, publishMediaItems, run]);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="font-display font-black text-2xl">Media Asset Library Vault</h1>
          <p className="text-2xs text-[#2E2A26]/70">Store images, logos, product graphics, and takeaway leaflets securely.</p>
        </div>
        {MEDIA_V2 ? (
          <label className="px-4 py-2 bg-[#A46832] text-white rounded-full text-2xs tracking-wider uppercase font-black cursor-pointer inline-block">
            {isBusy ? 'Uploading…' : 'Upload image'}
            <input
              type="file"
              disabled={isBusy}
              accept={ACCEPTED_IMAGE_ACCEPT_ATTR}
              className="hidden"
              onChange={handleUpload}
            />
          </label>
        ) : (
          <span
            className="px-4 py-2 bg-[#2E2A26]/10 text-[#2E2A26]/60 rounded-full text-2xs tracking-wider uppercase font-black inline-flex items-center gap-2"
            title="Image uploads are turned off until the media pipeline gate passes (set VITE_MEDIA_V2=true). Existing images keep rendering."
          >
            <AlertTriangle className="w-3.5 h-3.5" /> Uploads disabled
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {mediaItems.map((media) => (
          <div key={media.id} className="bg-white rounded-2xl border p-4 shadow-2xs space-y-3">
            <div className="h-32 bg-stone-100 rounded-xl overflow-hidden flex items-center justify-center">
              {media.url ? (
                <img referrerPolicy="no-referrer" src={media.url} className="object-cover h-full w-full" alt="" />
              ) : (
                <span className="text-2xl">📁</span>
              )}
            </div>
            <div className="text-2xs space-y-1">
              <p className="font-bold truncate text-[#2E2A26]">{media.name}</p>
              <p className="text-stone-400 font-mono text-[9px] flex justify-between">
                <span>{media.size}</span>
                <span>{media.folder.toUpperCase()}</span>
              </p>
              {/* Media publication is intentionally not modelled: byte visibility
                  belongs to storage and public visibility belongs to records that
                  reference the asset, not to this authenticated library row. */}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
