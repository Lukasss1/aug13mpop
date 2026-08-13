/**
 * @file passwordRecovery.ts
 * @description R4.8 Workstream H1 — user-facing forgotten-password flow.
 *
 * Design:
 *   • requestPasswordReset() posts to Supabase Auth /recover with the anon
 *     apikey. The redirect target is BUILT HERE from window.location.origin +
 *     a fixed path — the caller can never inject a redirect, so there is no
 *     open-redirect surface. The UI response is IDENTICAL whether or not the
 *     address has an account (no enumeration).
 *   • readRecoveryFromHash() parses the Supabase recovery fragment on the
 *     /staff/ landing (#access_token=…&type=recovery, or #error_code=…).
 *     Expired/used links surface as an honest, specific message.
 *   • completePasswordReset() PUTs the new password to /auth/v1/user with the
 *     one-time recovery token, then scrubs the fragment from the URL/history.
 *     Supabase revokes outstanding refresh tokens on password update, which is
 *     the cross-tab/session consistency guarantee: other tabs fall back to
 *     signed-out on their next refresh.
 */
import { getSupabaseConfig } from './supabase';
import { fetchWithTimeout, REQUEST_TIMEOUT_MS } from './requestTimeout';

const RESET_LANDING_PATH = '/staff/';

export type RecoveryHash =
  | { kind: 'none' }
  | { kind: 'recovery'; accessToken: string }
  | { kind: 'error'; message: string };

export async function requestPasswordReset(email: string): Promise<{ ok: boolean; message: string }> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, message: 'Sign-in is not configured on this deployment.' };
  const clean = email.trim().toLowerCase();
  if (!clean || !clean.includes('@')) return { ok: false, message: 'Enter the e-mail address you sign in with.' };
  try {
    const res = await fetchWithTimeout(`${cfg.url.replace(/\/$/, '')}/auth/v1/recover`, {
      method: 'POST',
      headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: clean,
        // Fixed, same-origin landing — never caller-supplied.
        gotrue_meta_security: {},
        redirect_to: `${window.location.origin}${RESET_LANDING_PATH}`,
      }),
    }, REQUEST_TIMEOUT_MS.auth);
    // Deliberately identical wording for 200 and for "no such user" responses:
    // the endpoint itself is enumeration-safe, and so are we.
    if (res.ok || res.status === 400 || res.status === 422 || res.status === 429) {
      return { ok: true, message: 'If that address has a staff account, a reset link is on its way. The link expires quickly — use it soon.' };
    }
    return { ok: false, message: 'The reset service is unavailable right now. Please try again shortly.' };
  } catch {
    return { ok: false, message: 'The reset service could not be reached. Check your connection and try again.' };
  }
}

export function readRecoveryFromHash(hash: string): RecoveryHash {
  const raw = (hash || '').replace(/^#/, '');
  if (!raw) return { kind: 'none' };
  const p = new URLSearchParams(raw);
  const errCode = p.get('error_code') || p.get('error');
  if (errCode) {
    const desc = (p.get('error_description') || '').replace(/\+/g, ' ');
    if (/expired|invalid/i.test(errCode + ' ' + desc)) {
      return { kind: 'error', message: 'That reset link has expired or was already used. Request a new one below.' };
    }
    return { kind: 'error', message: desc || 'That reset link could not be used. Request a new one below.' };
  }
  if (p.get('type') === 'recovery' && p.get('access_token')) {
    return { kind: 'recovery', accessToken: p.get('access_token') as string };
  }
  return { kind: 'none' };
}

export function scrubRecoveryHash(): void {
  try {
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  } catch { /* history not writable — the token is single-use regardless */ }
}

export async function completePasswordReset(
  recoveryToken: string,
  newPassword: string,
): Promise<{ ok: boolean; message: string }> {
  const cfg = getSupabaseConfig();
  if (!cfg) return { ok: false, message: 'Sign-in is not configured on this deployment.' };
  if (newPassword.length < 10) return { ok: false, message: 'Choose a password of at least 10 characters.' };
  try {
    const res = await fetchWithTimeout(`${cfg.url.replace(/\/$/, '')}/auth/v1/user`, {
      method: 'PUT',
      headers: { apikey: cfg.anonKey, Authorization: `Bearer ${recoveryToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword }),
    }, REQUEST_TIMEOUT_MS.auth);
    if (res.ok) {
      scrubRecoveryHash();
      return { ok: true, message: 'Password updated. Sign in with your new password. Other devices have been signed out.' };
    }
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    const msg = String((body as { msg?: string; error_description?: string }).msg || (body as { error_description?: string }).error_description || '');
    if (res.status === 401 || /expired|invalid/i.test(msg)) {
      return { ok: false, message: 'That reset link has expired or was already used. Request a new one.' };
    }
    if (/should be different|same password/i.test(msg)) {
      return { ok: false, message: 'The new password must be different from the old one.' };
    }
    return { ok: false, message: 'The password could not be updated. Request a new link and try again.' };
  } catch {
    return { ok: false, message: 'The reset service could not be reached. Check your connection and try again.' };
  }
}
