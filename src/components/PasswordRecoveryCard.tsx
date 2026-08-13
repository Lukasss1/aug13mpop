/**
 * @file PasswordRecoveryCard.tsx
 * @description R4.8 Workstream H1 — the two recovery surfaces:
 *   mode 'request'  — "Forgot password" e-mail form (enumeration-safe copy)
 *   mode 'complete' — new-password form shown when a recovery token landed
 * Rendered by StaffPortal inside the login card region.
 */
import React, { useEffect, useRef, useState } from 'react';
import { requestPasswordReset, completePasswordReset } from '../lib/passwordRecovery';

interface Props {
  mode: 'request' | 'complete';
  recoveryToken?: string;
  linkError?: string;
  onBackToLogin: () => void;
}

export default function PasswordRecoveryCard({ mode, recoveryToken, linkError, onBackToLogin }: Props) {
  const [email, setEmail] = useState('');
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'err'; text: string } | null>(
    linkError ? { tone: 'err', text: linkError } : null,
  );
  const returnTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (returnTimerRef.current !== null) window.clearTimeout(returnTimerRef.current);
  }, []);

  const inputCls = 'w-full px-4 py-2.5 rounded-xl border border-[#EBDECE] bg-white text-sm text-[#2E2A26] focus:outline-none focus:ring-2 focus:ring-[#A46832]/40';

  const doRequest = async () => {
    if (busy) return;
    setBusy(true); setNote(null);
    const r = await requestPasswordReset(email);
    setBusy(false);
    setNote({ tone: r.ok ? 'ok' : 'err', text: r.message });
  };

  const doComplete = async () => {
    if (busy) return;
    if (pw1 !== pw2) { setNote({ tone: 'err', text: 'The two passwords do not match.' }); return; }
    if (!recoveryToken) { setNote({ tone: 'err', text: 'The reset link is missing. Request a new one.' }); return; }
    setBusy(true); setNote(null);
    const r = await completePasswordReset(recoveryToken, pw1);
    setBusy(false);
    setNote({ tone: r.ok ? 'ok' : 'err', text: r.message });
    if (r.ok) {
      if (returnTimerRef.current !== null) window.clearTimeout(returnTimerRef.current);
      returnTimerRef.current = window.setTimeout(onBackToLogin, 1800);
    }
  };

  return (
    <div className="space-y-4 text-left">
      <h3 className="text-sm font-extrabold text-[#2E2A26]">
        {mode === 'request' ? 'Reset your password' : 'Choose a new password'}
      </h3>
      {mode === 'request' ? (
        <form onSubmit={(event) => { event.preventDefault(); void doRequest(); }} className="space-y-4">
          <p className="text-xs text-neutral-600 leading-relaxed">
            Enter your sign-in e-mail. If it has a staff account we will send a
            single-use reset link. For your privacy the message is the same
            either way.
          </p>
          <label htmlFor="recovery-email" className="text-2xs font-extrabold uppercase tracking-wider text-neutral-600">E-mail</label>
          <input id="recovery-email" name="email" type="email" autoComplete="username" inputMode="email" required className={inputCls}
            value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          <button type="submit" disabled={busy}
            className="w-full min-h-11 rounded-xl bg-[#A46832] text-white text-sm font-bold cursor-pointer disabled:opacity-50">
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void doComplete(); }} className="space-y-4">
          <label htmlFor="recovery-pw1" className="text-2xs font-extrabold uppercase tracking-wider text-neutral-600">New password</label>
          <input id="recovery-pw1" name="new-password" type="password" autoComplete="new-password" minLength={10} required className={inputCls}
            value={pw1} onChange={(e) => setPw1(e.target.value)} disabled={busy} />
          <label htmlFor="recovery-pw2" className="text-2xs font-extrabold uppercase tracking-wider text-neutral-600">Repeat new password</label>
          <input id="recovery-pw2" name="confirm-password" type="password" autoComplete="new-password" minLength={10} required className={inputCls}
            value={pw2} onChange={(e) => setPw2(e.target.value)} disabled={busy} />
          <button type="submit" disabled={busy}
            className="w-full min-h-11 rounded-xl bg-[#A46832] text-white text-sm font-bold cursor-pointer disabled:opacity-50">
            {busy ? 'Updating…' : 'Set new password'}
          </button>
        </form>
      )}
      {note && (
        <p role={note.tone === 'ok' ? 'status' : 'alert'} className={`text-xs leading-relaxed ${note.tone === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>{note.text}</p>
      )}
      <button type="button" onClick={onBackToLogin} className="text-xs font-bold text-[#8F5322] underline cursor-pointer min-h-11">
        Back to sign-in
      </button>
    </div>
  );
}
