// ============================================================================
//  MILK POP — browser media pipeline v2 (WP04R-B/E)
//
//  TWO-PHASE CONTRACT (Patch Spec §10/§16): processAndUploadImage() stores a
//  PENDING object and returns its identity — it never deletes anything and
//  replacePath no longer exists anywhere in the API. Making the image live is
//  the parent save's job via attachMediaReference(); a pending object that is
//  never attached is removed later by the reference-and-scan-guarded worker.
//
//  DECODE HARDENING (P1-R5): the source file is bounded BEFORE decode
//  (10 MB), dimensions are bounded AFTER decode (8000×8000 and 40 MP),
//  EXIF orientation is honoured via createImageBitmap where available, and
//  when quality 0.35 still exceeds the 500 KB hard cap the pipeline shrinks
//  dimensions before giving an honest refusal.
//
//  FLAG (spec §19): with VITE_MEDIA_V2 unset/false the pipeline refuses with
//  an honest message. It never falls back to Base64 — that regression class
//  is closed for good.
// ============================================================================

import { getSupabaseConfig } from './supabase';
import { getAccessToken } from './auth';
import { timedFetch } from './requestTimeout';
import { MEDIA_V2 } from './featureFlags';

const SOURCE_MAX_BYTES = 10 * 1024 * 1024; // pre-decode cap on the picked file
const MAX_DIMENSION = 8000;                // per-axis post-decode cap
const MAX_PIXELS = 40_000_000;             // 40 MP post-decode cap
const TARGET_MAX_DIM = 1200;               // final longest edge
const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.5, 0.35] as const;
const TARGET_BYTES = 300 * 1024;           // aim under this
const HARD_MAX_BYTES = 500 * 1024;         // server rejects above this — never send it
const DIMENSION_FALLBACK_STEPS = 3;        // ×0.8 shrink attempts before refusing

/** The exact MIME types the picker should offer — image/* invites HEIC and
 *  worse (P1-R5: never accept image/* blindly). */
export const ACCEPTED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ACCEPTED_IMAGE_ACCEPT_ATTR = ACCEPTED_IMAGE_MIME.join(',');

export type MediaUploadResult =
  | { status: 'uploaded'; objectId: string; url: string; storagePath: string; width: number; height: number }
  | { status: 'failed'; errorCode: string; retryable: boolean; message: string };

export type MediaAttachResult =
  | { status: 'attached'; objectId: string; url: string | null; previousObjectCleanup: 'not_needed' | 'scheduled' }
  | { status: 'failed'; errorCode: string; retryable: boolean };

type Decoded = { source: CanvasImageSource; width: number; height: number; dispose: () => void };

/** Decode with EXIF orientation honoured. createImageBitmap applies
 *  'from-image' orientation explicitly; the <img> fallback relies on the
 *  browser's default image-orientation handling (correct in all evergreen
 *  engines — the acceptance test, not this code, is the proof for iPhone
 *  portraits per spec §17). */
async function decodeImage(file: File): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      return { source: bmp, width: bmp.width, height: bmp.height, dispose: () => bmp.close() };
    } catch { /* fall through to <img> */ }
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({
      source: img, width: img.naturalWidth, height: img.naturalHeight,
      dispose: () => URL.revokeObjectURL(url),
    });
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function encode(source: CanvasImageSource, srcW: number, srcH: number, maxDim: number): Promise<Blob | null> {
  const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise<Blob | null>((resolve) => {
    const tryStep = (i: number) => {
      canvas.toBlob((blob) => {
        if (blob && (blob.size <= TARGET_BYTES || i === QUALITY_STEPS.length - 1)) resolve(blob);
        else tryStep(i + 1);
      }, 'image/webp', QUALITY_STEPS[i]);
    };
    tryStep(0);
  });
}

/** Preprocess + upload ONE image as a PENDING media object. */
export async function processAndUploadImage(file: File, opts: { altText?: string } = {}): Promise<MediaUploadResult> {
  if (!MEDIA_V2) {
    return {
      status: 'failed', errorCode: 'disabled', retryable: false,
      message: 'Media uploads are not enabled on this deployment yet.',
    };
  }
  const cfg = getSupabaseConfig();
  if (!cfg) {
    return { status: 'failed', errorCode: 'not_configured', retryable: false, message: 'This site is not connected to its media system.' };
  }

  // P1-R5 gate 1: MIME allow-list (explicit HEIC message — iPhones default to it).
  if (!ACCEPTED_IMAGE_MIME.includes(file.type as typeof ACCEPTED_IMAGE_MIME[number])) {
    const heic = /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
    return {
      status: 'failed', errorCode: 'bad_type', retryable: false,
      message: heic
        ? 'HEIC photos are not supported yet — in iPhone camera settings choose "Most Compatible", or export the photo as JPEG first.'
        : 'Only JPEG, PNG or WebP images are accepted.',
    };
  }
  // P1-R5 gate 2: source byte cap BEFORE any decode work.
  if (file.size > SOURCE_MAX_BYTES) {
    return { status: 'failed', errorCode: 'too_large', retryable: false, message: 'That image is over the 10 MB source limit. Please export a smaller copy.' };
  }

  const decoded = await decodeImage(file);
  if (!decoded) {
    return { status: 'failed', errorCode: 'decode_failed', retryable: false, message: 'That file could not be read as an image.' };
  }
  try {
    // P1-R5 gate 3: dimension + pixel caps AFTER decode, BEFORE canvas work.
    if (decoded.width > MAX_DIMENSION || decoded.height > MAX_DIMENSION || decoded.width * decoded.height > MAX_PIXELS) {
      return { status: 'failed', errorCode: 'too_large', retryable: false, message: 'That image is too large to process in the browser (max 8000×8000 / 40 MP).' };
    }

    // Encode; if 0.35 quality still busts the hard cap, shrink dimensions ×0.8
    // a bounded number of times, then refuse honestly (spec §13).
    let maxDim = TARGET_MAX_DIM;
    let blob: Blob | null = null;
    for (let i = 0; i <= DIMENSION_FALLBACK_STEPS; i++) {
      blob = await encode(decoded.source, decoded.width, decoded.height, maxDim);
      if (blob && blob.size <= HARD_MAX_BYTES) break;
      maxDim = Math.max(200, Math.round(maxDim * 0.8));
      blob = null;
    }
    if (!blob) {
      return { status: 'failed', errorCode: 'too_large', retryable: false, message: 'This image could not be compressed under the 500 KB limit — please try a simpler or smaller image.' };
    }

    const token = await getAccessToken();
    if (!token) {
      return { status: 'failed', errorCode: 'auth', retryable: false, message: 'Your session has expired. Sign in again to upload media.' };
    }

    const scale = Math.min(1, maxDim / Math.max(decoded.width, decoded.height));
    const outW = Math.max(1, Math.round(decoded.width * scale));
    const outH = Math.max(1, Math.round(decoded.height * scale));
    const form = new FormData();
    form.append('file', blob, 'image.webp');
    if (opts.altText) form.append('altText', opts.altText.slice(0, 300));
    form.append('width', String(outW));
    form.append('height', String(outH));

    const res = await timedFetch.upload(`${cfg.url}/functions/v1/media-upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey },
      body: form,
    });
    const out = await res.json().catch(() => null) as
      { status?: string; objectId?: string; url?: string; storagePath?: string; error?: string; errorCode?: string; message?: string } | null;
    if (res.ok && out?.status === 'uploaded' && out.objectId && out.url && out.storagePath) {
      return { status: 'uploaded', objectId: out.objectId, url: out.url, storagePath: out.storagePath, width: outW, height: outH };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'failed', errorCode: 'auth', retryable: false, message: String(out?.error || 'You are not permitted to upload media.') };
    }
    if (res.status === 413 || res.status === 415) {
      return { status: 'failed', errorCode: res.status === 413 ? 'too_large' : 'bad_type', retryable: false, message: String(out?.error || 'That image was refused.') };
    }
    return {
      status: 'failed', errorCode: String(out?.errorCode || 'upload_failed'), retryable: true,
      message: String(out?.message || out?.error || 'The image could not be uploaded. Please try again.'),
    };
  } catch {
    return {
      status: 'failed', errorCode: 'network', retryable: true,
      message: 'The image upload could not be completed. Check the connection and try again.',
    };
  } finally {
    decoded.dispose();
  }
}

/** Two-phase step 2: attach a PENDING object to the entity field that now
 *  uses it. Call AFTER the parent content is saved/published. The displaced
 *  object (if any) is grace-scheduled server-side — never deleted here. */
export async function attachMediaReference(
  objectId: string, entityType: string, entityId: string, fieldPath: string,
): Promise<MediaAttachResult> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { status: 'failed', errorCode: 'not_configured', retryable: false };
  const token = await getAccessToken();
  if (!token) return { status: 'failed', errorCode: 'auth', retryable: false };
  try {
    const res = await timedFetch.action(`${cfg.url}/functions/v1/media-upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'attach', objectId, entityType, entityId, fieldPath }),
    });
    const out = await res.json().catch(() => null) as
      { status?: string; objectId?: string; url?: string | null; previousObjectCleanup?: string; errorCode?: string; retryable?: boolean } | null;
    if (res.ok && out?.status === 'attached' && out.objectId) {
      return {
        status: 'attached', objectId: out.objectId, url: out.url ?? null,
        previousObjectCleanup: out.previousObjectCleanup === 'scheduled' ? 'scheduled' : 'not_needed',
      };
    }
    return { status: 'failed', errorCode: String(out?.errorCode || 'attach_failed'), retryable: out?.retryable === true };
  } catch {
    return { status: 'failed', errorCode: 'network', retryable: true };
  }
}

/** An editable image value → a browser-renderable URL, or undefined.
 *  (Unchanged: absolute URLs pass through; bare storage paths resolve to the
 *  public bucket URL; data:/blob: values from the pre-patch era still render
 *  until the Base64 migration retires them.) */
export function resolveMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const v = value.trim();
  if (/^(https:|data:image\/|blob:)/.test(v)) return v;
  if (/^\/(brand|img)\//.test(v)) return v; // bundled site assets
  const cfg = getSupabaseConfig();
  if (!cfg) return undefined;
  if (/^[0-9a-f-]{36}\.(webp|png|jpg)$/i.test(v)) {
    return `${cfg.url}/storage/v1/object/public/menu-media/${v}`;
  }
  return undefined;
}
