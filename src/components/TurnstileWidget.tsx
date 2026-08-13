// ============================================================================
//  MILK POP — Cloudflare Turnstile integration (WP-02, Technical Pack v1)
//
//  The server side has ALWAYS been ready: public-form and cv-upload verify a
//  token whenever TURNSTILE_SECRET is set. What was missing (P0-02) is this
//  file — without a widget, enabling the secret took every public form
//  offline. Contract:
//
//    • VITE_TURNSTILE_SITE_KEY unset  → hook is disabled, no script loads,
//      forms submit without tokens (server must have no secret either — the
//      pairing is asserted by scripts/turnstile-pairing.live.mjs at staging).
//    • Site key set → the script loads ONCE (explicit render, no implicit
//      global scan), each form renders one widget in `execution:'execute'`
//      mode, and getToken() resolves a FRESH single-use token per call.
//      Turnstile tokens are CONSUMED by siteverify, so Careers+CV needs two:
//      one for the application, one for the upload — hence token-per-call,
//      with reset() before every execute.
//    • expired/error/timeout → the widget resets itself; getToken() resolves
//      undefined rather than throwing, and the SERVER stays the authority: a
//      missing/stale token comes back as an honest captcha error with every
//      field retained (usePublicSubmission).
// ============================================================================

import React, { useCallback, useEffect, useRef } from 'react';

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  execute: (id: string) => void;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

declare global {
  interface Window { turnstile?: TurnstileApi }
}

const SITE_KEY = String(import.meta.env.VITE_TURNSTILE_SITE_KEY || '').trim();
export const turnstileEnabled = SITE_KEY.length > 0;

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TOKEN_TIMEOUT_MS = 25_000;

let scriptPromise: Promise<void> | null = null;
/** Load the Turnstile script exactly once (explicit-render mode). */
function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => { scriptPromise = null; reject(new Error('turnstile script failed')); };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export interface TurnstileHandle {
  /** True when a site key is configured for this build. */
  enabled: boolean;
  /** Bind target for <TurnstileWidget/>. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Resolve one fresh single-use token (or undefined when disabled, or on
   * error/timeout — the server then answers with its own captcha rejection,
   * which the form reports honestly with all fields retained).
   */
  getToken: () => Promise<string | undefined>;
}

/** One hook instance per form. Renders lazily on first getToken(). */
export function useTurnstile(): TurnstileHandle {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const waiterRef = useRef<((token: string | undefined) => void) | null>(null);

  const settle = useCallback((token: string | undefined) => {
    const w = waiterRef.current;
    waiterRef.current = null;
    if (w) w(token);
  }, []);

  // Tidy up when the form unmounts (route change).
  useEffect(() => () => {
    if (widgetIdRef.current && window.turnstile) {
      try { window.turnstile.remove(widgetIdRef.current); } catch { /* gone */ }
      widgetIdRef.current = null;
    }
  }, []);

  const ensureRendered = useCallback(async (): Promise<boolean> => {
    if (!turnstileEnabled) return false;
    const el = containerRef.current;
    if (!el) return false;
    try { await loadTurnstileScript(); } catch { return false; }
    const ts = window.turnstile;
    if (!ts) return false;
    if (widgetIdRef.current) return true;
    widgetIdRef.current = ts.render(el, {
      sitekey: SITE_KEY,
      // execute-mode: the challenge runs only when we ask, and can run again
      // (fresh token) after reset — required for the Careers→CV double step.
      execution: 'execute',
      appearance: 'interaction-only',
      callback: (token: string) => settle(token),
      'error-callback': () => settle(undefined),
      'expired-callback': () => { /* a waiter, if any, will re-execute */ },
      'timeout-callback': () => settle(undefined),
    });
    return widgetIdRef.current !== null;
  }, [settle]);

  const getToken = useCallback(async (): Promise<string | undefined> => {
    if (!turnstileEnabled) return undefined;
    const ok = await ensureRendered();
    const ts = window.turnstile;
    const id = widgetIdRef.current;
    if (!ok || !ts || !id) return undefined;
    return new Promise<string | undefined>((resolve) => {
      // Supersede any stale waiter, then run a fresh challenge.
      settle(undefined);
      waiterRef.current = resolve;
      const timer = window.setTimeout(() => settle(undefined), TOKEN_TIMEOUT_MS);
      const prev = waiterRef.current;
      waiterRef.current = (token) => { window.clearTimeout(timer); prev(token); };
      try {
        ts.reset(id);     // discard any consumed/expired token
        ts.execute(id);   // run the challenge → callback settles the waiter
      } catch {
        settle(undefined);
      }
    });
  }, [ensureRendered, settle]);

  return { enabled: turnstileEnabled, containerRef, getToken };
}

/** The visible mount point. Renders nothing when no site key is configured. */
export const TurnstileWidget: React.FC<{ bind: TurnstileHandle; className?: string }> = ({ bind, className }) => {
  if (!bind.enabled) return null;
  return <div ref={bind.containerRef} className={className || 'my-2 flex justify-center'} aria-label="Verification" />;
};
