/**
 * @file launchSettings.ts
 * @description R4.8 Workstream F — client access to the owner-only launch
 * facts. Follows the house authed-REST pattern (updateInboxStatusAuthed):
 * user JWT + anon apikey, RLS does the enforcement (launch_settings and
 * privacy_notice_versions are owner-only for writes; published notices are
 * publicly readable). NOTHING here invents values — empty stays empty, and
 * the Launch Readiness panel reports each gap.
 */
import { getSupabaseConfig } from './supabase';
import { getAccessToken } from './auth';
import { safePolicyHref } from './safeUrl';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from './requestTimeout';

export interface LaunchSettingsRow {
  legal_business_name: string;
  company_number: string;
  registered_address: string;
  public_contact_email: string;
  privacy_contact_email: string;
  public_telephone: string;
  telephone_alternative_ok: boolean;
  canonical_url: string;
  receipt_identity_footer: string;
  vat_state_confirmed: boolean;
  notification_recipient: string;
  customer_ack_enabled: boolean;
  enforce_public_gates: boolean;
}

export const EMPTY_LAUNCH_SETTINGS: LaunchSettingsRow = {
  legal_business_name: '', company_number: '', registered_address: '',
  public_contact_email: '', privacy_contact_email: '', public_telephone: '',
  telephone_alternative_ok: false, canonical_url: '', receipt_identity_footer: '',
  vat_state_confirmed: false, notification_recipient: '',
  customer_ack_enabled: false, enforce_public_gates: false,
};

type AuthedResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function authedRest<T>(path: string, init: RequestInit = {}): Promise<AuthedResult<T>> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, error: 'not_configured' };
  const token = await getAccessToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetchWithTimeout(`${cfg.url.replace(/\/$/, '')}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: cfg.anonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: init.method && init.method !== 'GET' ? 'return=representation' : 'count=none',
        ...(init.headers as Record<string, string> || {}),
      },
    }, init.method && init.method !== 'GET' ? REQUEST_TIMEOUT_MS.action : REQUEST_TIMEOUT_MS.read);
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'not_permitted' };
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const text = await res.text();
    return { ok: true, data: (text ? JSON.parse(text) : undefined) as T };
  } catch {
    return { ok: false, error: 'network' };
  }
}

export async function loadLaunchSettings(): Promise<AuthedResult<LaunchSettingsRow>> {
  const r = await authedRest<LaunchSettingsRow[]>('launch_settings?select=*&id=eq.true');
  if (!r.ok) return r;
  return { ok: true, data: { ...EMPTY_LAUNCH_SETTINGS, ...(r.data?.[0] || {}) } };
}

/** INC11: launch facts save through the atomic RPC — the server verifies the
 *  expected revision, applies the patch, DERIVES updated_by from the caller's
 *  staff row (never client-supplied), and writes the audit row in the same
 *  transaction. Returns the new revision for the panel to carry forward. */
export async function saveLaunchSettings(
  patch: Partial<LaunchSettingsRow>,
  expectedRevision: number | null,
): Promise<AuthedResult<{ revision: number }>> {
  const r = await authedRest<{ revision: number }>('rpc/save_launch_settings', {
    method: 'POST',
    body: JSON.stringify({ p_patch: patch, p_expected_revision: expectedRevision }),
  });
  return r.ok ? { ok: true, data: { revision: r.data.revision } } : r;
}

/** The launch-facts revision the save must echo (null = ledger row missing). */
export async function loadLaunchRevision(): Promise<number | null> {
  const r = await authedRest<Array<{ revision: number }>>(
    'collection_revisions?table_key=eq.launch_settings&select=revision', { method: 'GET' });
  return r.ok && Array.isArray(r.data) && r.data[0] ? r.data[0].revision : null;
}

export interface PrivacyNoticeRow {
  id: string;
  audience: 'careers' | 'franchise' | 'contact' | 'staff';
  version_label: string;
  notice_text: string;
  policy_url: string;
  published_at: string | null;
}

export async function loadPrivacyNotices(): Promise<AuthedResult<PrivacyNoticeRow[]>> {
  const r = await authedRest<PrivacyNoticeRow[]>('privacy_notice_versions?select=*&order=created_at.desc');
  return r.ok ? { ok: true, data: r.data || [] } : r;
}

/** Publish a new notice version for one audience. The text/version are typed
 *  by the OWNER (legal boundary F5) — nothing is generated or assumed here. */
export async function publishPrivacyNotice(
  audience: PrivacyNoticeRow['audience'],
  versionLabel: string,
  noticeText: string,
  policyUrl: string,
): Promise<AuthedResult<undefined>> {
  if (!versionLabel.trim() || !noticeText.trim()) {
    return { ok: false, error: 'version label and notice text are required' };
  }
  const trimmedPolicyUrl = policyUrl.trim();
  if (trimmedPolicyUrl && !safePolicyHref(trimmedPolicyUrl)) {
    return { ok: false, error: 'policy URL must be an HTTPS address or a root-relative path such as /privacy/' };
  }
  const r = await authedRest<unknown>('privacy_notice_versions', {
    method: 'POST',
    body: JSON.stringify({
      audience,
      version_label: versionLabel.trim(),
      notice_text: noticeText.trim(),
      policy_url: trimmedPolicyUrl,
      published_at: new Date().toISOString(),
    }),
  });
  return r.ok ? { ok: true, data: undefined } : r;
}
