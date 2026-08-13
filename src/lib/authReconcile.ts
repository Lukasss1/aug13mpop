/**
 * @file authReconcile.ts
 * @description The final cross-tab rule (behavioural re-audit, prescribed
 * architecture): PERSISTENT STORAGE IS THE TRUTH; broadcasts only announce
 * that the truth changed; a receiving tab reconciles from storage exactly
 * once per persisted mutation and NEVER rebroadcasts.
 *
 * These are the pure decision pieces, kept out of React so the behavioural
 * suite can drive them directly against real two/three-instance storage.
 */
import type { PersistedRevision } from './authStorage';

/** What a receiving tab should do after synchronising from persisted truth. */
export type ReconcileAction = 'none' | 'clear_identity' | 'adopt_session';

/**
 * Derive the action from the PERSISTED result — never from the (possibly
 * delayed, possibly superseded) event type. A delayed equal-version
 * SIGNED_OUT arriving while the truth is a live User-C therefore adopts /
 * keeps User-C instead of clearing the UI (re-audit H3).
 */
export function reconcileAction(
  persistedUserId: string | null,
  hasSession: boolean,
  localUserId: string | null,
): ReconcileAction {
  if (!hasSession || !persistedUserId) {
    return localUserId === null ? 'none' : 'clear_identity';
  }
  if (persistedUserId === localUserId) return 'none'; // same identity (a rotated token was already adopted by the sync)
  return 'adopt_session';
}

/**
 * At-most-once gate: reconcile only when the persisted mutation differs from
 * the one this tab last applied. Duplicate or storm-echoed deliveries of the
 * same truth are no-ops (re-audit C1).
 */
export function shouldReconcile(
  persisted: PersistedRevision | null,
  lastApplied: PersistedRevision | null,
): boolean {
  // A null revision record MID-FLOW (this tab has already applied one) is the
  // other visibility-skew direction — the token envelope became visible before
  // the revision key. Skip without consuming; the revision's own storage event
  // re-triggers. Only a genuinely-legacy first contact reconciles on null.
  if (!persisted) return lastApplied === null;
  if (!lastApplied) return true;
  if (persisted.mutationId && lastApplied.mutationId) {
    return persisted.mutationId !== lastApplied.mutationId;
  }
  // An empty mutationId only occurs for a SYNTHESIZED lastApplied (a state
  // application that ran ahead of the revision record's visibility) or a
  // legacy record: order by counter alone — the revision describing the very
  // application we already made must gate-skip, a strictly newer one applies.
  return persisted.counter > lastApplied.counter;
}
