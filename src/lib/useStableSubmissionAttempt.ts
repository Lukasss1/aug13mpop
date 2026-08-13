// ============================================================================
//  MILK POP — stable submission-attempt key (Patch Spec §6.1 / P1-R1)
//
//  THE RULE: the idempotency key stays STABLE while the canonical payload is
//  unchanged, and ROTATES when the payload changes or after confirmed
//  success. That gives both halves the old per-call design could only trade
//  between: a user retry after a lost response reuses the key (the server
//  resolves to the ORIGINAL row — no duplicate), while an edited payload
//  gets a fresh key (an edit can never be silently swallowed by replay).
//
//  Memory-only by design: no PII, no key, no hash touches localStorage or
//  sessionStorage for launch (spec §6.1). A page reload starts a new attempt,
//  which at worst re-submits knowingly — never silently.
// ============================================================================

import { useCallback, useRef } from 'react';
import { canonicalPublicFormHash } from './publicSubmissionHash';

export interface SubmissionAttempt {
  key: string;
  payloadHash: string;
}

export function useStableSubmissionAttempt() {
  const attemptRef = useRef<SubmissionAttempt | null>(null);

  /** The attempt for THIS payload: reused while the payload hash matches,
   *  fresh when it doesn't. Call once per submit, with the user-controlled
   *  fields only (ids/timestamps would defeat stability). */
  const getAttempt = useCallback(async (payload: Record<string, unknown>): Promise<SubmissionAttempt> => {
    const hash = await canonicalPublicFormHash(payload);
    if (!attemptRef.current || attemptRef.current.payloadHash !== hash) {
      attemptRef.current = { key: crypto.randomUUID(), payloadHash: hash };
    }
    return attemptRef.current;
  }, []);

  /** Rotate after confirmed success (a NEW submission of identical text is a
   *  new intent), or after an idempotency_conflict (the key is burnt). */
  const rotate = useCallback(() => { attemptRef.current = null; }, []);

  return { getAttempt, rotate };
}
