/**
 * @file staffDocs.ts
 * @description STAGE 3 — client side of the staff-document pipeline.
 *
 * Files never touch Postgres and never travel as base64 blobs through app
 * state. Upload goes multipart to the `staff-doc-upload` Edge Function (which
 * validates, stores into the PRIVATE `staff-documents` bucket and inserts the
 * metadata row with checked compensation); viewing asks `staff-doc-url` for a 60-second
 * signed URL that is used immediately and never persisted.
 */
import { getSupabaseConfig } from './supabase';
import type { StaffDocument } from '../types';
import { timedFetch } from './requestTimeout';

export type StaffDocResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

function endpoint(fn: string): { url: string; anonKey: string } | null {
  const cfg = getSupabaseConfig();
  if (!cfg) return null;
  return { url: `${cfg.url.replace(/\/$/, '')}/functions/v1/${fn}`, anonKey: cfg.anonKey };
}

/** Coarse, safe messages only — raw backend text never reaches the UI. */
async function coarseError(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string' && body.error.length < 160) return body.error;
  } catch { /* fall through */ }
  return fallback;
}

/**
 * Upload one document. `employeeId` may be omitted for "my own document";
 * managers/owners may pass another employee's id (the SERVER re-checks store
 * scope and role — nothing here is trusted).
 */
export async function uploadStaffDocument(
  args: { file: File; name: string; category: StaffDocument['category']; employeeId?: string },
  token: string,
): Promise<StaffDocResult<StaffDocument>> {
  const ep = endpoint('staff-doc-upload');
  if (!ep) return { ok: false, message: 'No database is configured — the document was NOT uploaded.' };
  const form = new FormData();
  form.set('file', args.file);
  form.set('name', args.name);
  form.set('category', args.category);
  if (args.employeeId) form.set('employeeId', args.employeeId);
  let res: Response;
  try {
    res = await timedFetch.upload(ep.url, {
      method: 'POST',
      headers: { apikey: ep.anonKey, Authorization: `Bearer ${token}` },
      body: form,
    });
  } catch {
    return { ok: false, message: 'The server did not confirm the upload. Refresh the document list before retrying.' };
  }
  if (!res.ok) {
    return { ok: false, message: await coarseError(res, 'The document could not be uploaded.') };
  }
  const body = await res.json().catch(() => null);
  const row = body?.document;
  if (!row || typeof row !== 'object') return { ok: false, message: 'The server did not confirm the upload.' };
  // snake_case → the app's camelCase shape (small fixed mapping; no dynamic keys).
  const doc: StaffDocument = {
    id: String(row.id),
    name: String(row.name || args.name),
    type: String(row.mime_type || row.type || ''),
    category: (row.category || args.category) as StaffDocument['category'],
    uploadDate: String(row.upload_date || new Date().toISOString()),
    status: (row.status || 'pending') as StaffDocument['status'],
    fileState: (row.file_state || 'active') as StaffDocument['fileState'],
    deletionError: row.deletion_error ? String(row.deletion_error) : undefined,
    employeeId: row.employee_id ? String(row.employee_id) : undefined,
    employeeName: row.employee_name ? String(row.employee_name) : undefined,
    storeId: row.store_id ? String(row.store_id) : undefined,
    storeName: row.store_name ? String(row.store_name) : undefined,
    storagePath: row.storage_path ? String(row.storage_path) : undefined,
    originalFilename: row.original_filename ? String(row.original_filename) : undefined,
    mimeType: row.mime_type ? String(row.mime_type) : undefined,
    sizeBytes: typeof row.size_bytes === 'number' ? row.size_bytes : undefined,
    checksum: row.checksum ? String(row.checksum) : undefined,
    uploadedBy: row.uploaded_by ? String(row.uploaded_by) : undefined,
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    verifiedBy: row.verified_by ? String(row.verified_by) : undefined,
    verifiedAt: row.verified_at ? String(row.verified_at) : undefined,
    expiryDate: row.expiry_date ? String(row.expiry_date) : undefined,
  };
  return { ok: true, data: doc };
}

/** OWNER-ONLY controlled removal. The private object is removed and the live
 *  metadata becomes a browser-dark audit tombstone in one server transaction. */
export async function deleteStaffDocument(
  documentId: string,
  token: string,
): Promise<StaffDocResult<true>> {
  const ep = endpoint('staff-doc-delete');
  if (!ep) return { ok: false, message: 'No database is configured.' };
  let res: Response;
  try {
    res = await timedFetch.action(ep.url, {
      method: 'POST',
      headers: { apikey: ep.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId }),
    });
  } catch {
    return { ok: false, message: 'The server did not confirm the deletion. Refresh the document list before retrying.' };
  }
  if (!res.ok) return { ok: false, message: await coarseError(res, 'The document could not be deleted.') };
  return { ok: true, data: true };
}

/** 60-second signed URL for one document, issued after the server's access
 *  check. Use it immediately (e.g. window.open) — it is never stored. */
export async function getStaffDocumentUrl(
  documentId: string,
  token: string,
): Promise<StaffDocResult<string>> {
  const ep = endpoint('staff-doc-url');
  if (!ep) return { ok: false, message: 'No database is configured.' };
  let res: Response;
  try {
    res = await timedFetch.read(ep.url, {
      method: 'POST',
      headers: { apikey: ep.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId }),
    });
  } catch {
    return { ok: false, message: 'Network problem — could not open the document.' };
  }
  if (!res.ok) return { ok: false, message: await coarseError(res, 'The document could not be opened.') };
  const body = await res.json().catch(() => null);
  if (!body?.url) return { ok: false, message: 'The server did not return a view link.' };
  return { ok: true, data: String(body.url) };
}
