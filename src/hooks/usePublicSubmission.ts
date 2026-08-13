// ============================================================================
//  MILK POP — usePublicSubmission (WP-02, Technical Pack v1)
//
//  The shared submission discipline for the three anonymous public forms
//  (Careers / Franchise / Contact). Fixes P0-03's failure family:
//
//    • PENDING LOCK — a second click while a submission is in flight is a
//      no-op (ref-based, so even same-tick double events can't race React
//      state). "Double click → one row" is guaranteed here at the source;
//      the WP-01 idempotency key + unique index guard the transport layer.
//    • TOKEN ORCHESTRATION — one fresh Turnstile token is acquired per
//      attempt and handed to the caller; when Turnstile is disabled the
//      callback simply receives undefined.
//    • HONEST STATE RULE (enforced by the CALLER, stated here as contract):
//      form fields are cleared ONLY after result.status === 'submitted'.
//      Failure, not_configured and thrown paths must leave every field
//      exactly as the person typed it.
//
//  Deliberate design note: the WP-01 idempotency key is generated per CALL
//  (in App.tsx), not held across attempts. Reusing a key after the person
//  edits a field would make the server return the ORIGINAL row and silently
//  discard their edit — worse than the duplicate it prevents. The pending
//  lock already collapses double-clicks to one call.
// ============================================================================

import { useCallback, useRef, useState } from 'react';
import type { TurnstileHandle } from '../components/TurnstileWidget';

export function usePublicSubmission(turnstile: TurnstileHandle) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  /**
   * Run one submission attempt under the lock. `fn` receives the captcha
   * token (or undefined when Turnstile is off / unobtainable — the server
   * remains the authority and answers with an honest, field-retaining error).
   */
  const run = useCallback(async (fn: (captchaToken?: string) => Promise<void>): Promise<void> => {
    if (pendingRef.current) return;          // in-flight: swallow the re-click
    pendingRef.current = true;
    setPending(true);
    try {
      const token = await turnstile.getToken();
      await fn(token);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [turnstile]);

  return { pending, run };
}
