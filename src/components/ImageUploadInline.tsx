// ============================================================================
//  MILK POP — inline image editor tile (WP-04 rewrite)
//
//  Previously this component FileReader-encoded the chosen file to a Base64
//  data URL and handed it to the caller, which stored it INSIDE the content
//  row (P0-06). It now routes through the WP-04 pipeline: preprocess to WebP
//  in-browser → media-upload Edge Function → public Storage URL. The caller
//  receives a small https URL in the exact same callback, so every existing
//  call site keeps working unchanged. The previous value is passed to the
//  WP04R: uploads are two-phase and DELETION-FREE. Picking a replacement
//  only stores a PENDING object and updates the local field value — the old
//  image is untouched (a draft that is discarded leaves the live site exactly
//  as it was, P0-R2/R3). Attachment happens at the parent SAVE via
//  attachMediaReference; unattached pendings are collected later by the
//  reference-and-scan-guarded worker.
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Upload, Loader2 } from 'lucide-react';
import { processAndUploadImage, resolveMediaUrl, ACCEPTED_IMAGE_ACCEPT_ATTR } from '../lib/mediaUpload';
import { MEDIA_V2 } from '../lib/featureFlags';

interface ImageUploadInlineProps {
  currentImageUrl: string;
  onImageChange: (url: string) => void;
  className?: string;
  imgClassName?: string;
  /** Shown when an upload fails; optional so existing call sites compile. */
  onError?: (message: string) => void;
  /** WP04R: the parent save flow uses this to attach the pending object
   *  (entity/field are the parent's business, not this generic widget's). */
  onUploaded?: (objectId: string, storagePath: string) => void;
}

export const ImageUploadInline: React.FC<ImageUploadInlineProps> = ({ currentImageUrl, onImageChange, className = '', imgClassName = '', onError, onUploaded }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await processAndUploadImage(file, { altText: file.name });
      // A form may close or switch entity while the upload is in flight. The
      // object remains a pending upload for the cleanup worker, but a stale
      // callback must never write its URL/objectId into a newly opened form.
      if (!mountedRef.current) return;
      if (res.status === 'uploaded') {
        onImageChange(res.url);
        onUploaded?.(res.objectId, res.storagePath);
      } else {
        onError?.(res.message);
      }
    } catch {
      if (mountedRef.current) {
        onError?.('The image could not be processed. Please try a smaller JPEG, PNG or WebP file.');
      }
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const displayUrl = resolveMediaUrl(currentImageUrl);

  return (
    <div className={`relative group overflow-hidden ${className}`}>
      {displayUrl ? (
        <img src={displayUrl} className={imgClassName} alt="Uploaded preview" />
      ) : (
        <div className={`flex items-center justify-center bg-gray-200 text-gray-400 ${imgClassName}`}>
          <ImageIcon className="h-8 w-8" />
        </div>
      )}

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={!MEDIA_V2 || busy}
        aria-label={busy ? 'Uploading image' : (MEDIA_V2 ? 'Change image' : 'Image uploads disabled')}
        className={`absolute inset-0 border-0 bg-indigo-900/50 flex flex-col items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-white transition-opacity text-white ${MEDIA_V2 ? 'cursor-pointer' : 'cursor-not-allowed'}`}
        title={MEDIA_V2 ? undefined : 'Image uploads are turned off until the media pipeline gate passes (VITE_MEDIA_V2). The current image is unaffected.'}
      >
        {busy
          ? <Loader2 className="h-8 w-8 mb-2 animate-spin" />
          : <Upload className="h-8 w-8 mb-2" />}
        <span className="text-xs font-bold uppercase tracking-wider">{busy ? 'Uploading…' : (MEDIA_V2 ? 'Change Image' : 'Uploads disabled')}</span>
      </button>

      {MEDIA_V2 && (
      <input
        aria-label="Choose image file"
        type="file"
        accept={ACCEPTED_IMAGE_ACCEPT_ATTR}
        ref={fileInputRef}
        onChange={handleFileChange}
        className="hidden"
      />
      )}
    </div>
  );
};
