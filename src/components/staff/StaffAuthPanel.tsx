import React, { memo, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { LogoVertical } from '../../brand';
import { useSingleFlight } from '../../hooks/useSingleFlight';
import type { MfaPending } from '../../hooks/useAuth';
import type { AuthSession } from '../../lib/auth';
import { readRecoveryFromHash, scrubRecoveryHash } from '../../lib/passwordRecovery';
import PasswordRecoveryCard from '../PasswordRecoveryCard';

interface StaffAuthPanelProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  onSignIn?: ((email: string, password: string) => Promise<string | null>) | undefined;
  mfaPending?: MfaPending | null | undefined;
  onSubmitMfaCode?: ((code: string) => Promise<string | null>) | undefined;
  onCompleteMfaEnrolment?: ((session: AuthSession) => Promise<string | null>) | undefined;
  onCancelMfa?: (() => Promise<void>) | undefined;
  authConfigured: boolean;
  authLoading: boolean;
}

const StaffAuthPanel: React.FC<StaffAuthPanelProps> = ({
  currentTab,
  setCurrentTab,
  onSignIn,
  mfaPending = null,
  onSubmitMfaCode,
  onCompleteMfaEnrolment,
  onCancelMfa,
  authConfigured,
  authLoading,
}) => {
  // Ref-backed guards stop two clicks in the same event-loop turn. Each domain
  // remains independent so a document upload does not block clocking or a
  // checklist action.
  const authFlight = useSingleFlight();

  // Sign-in form state (used only when authConfigured is true).
  const [loginEmail, setLoginEmail] = useState('');
  // R4.8 (Workstream H1): password-recovery surfaces. 'login' is the normal
  // form; 'forgot' requests a reset link; 'recovery' is entered automatically
  // when a Supabase recovery token lands on /staff/ in the URL fragment.
  const [authView, setAuthView] = useState<'login' | 'forgot' | 'recovery'>('login');
  const [recoveryToken, setRecoveryToken] = useState('');
  const [recoveryLinkError, setRecoveryLinkError] = useState('');
  useEffect(() => {
    const parsed = readRecoveryFromHash(window.location.hash);
    if (parsed.kind === 'recovery') {
      setRecoveryToken(parsed.accessToken);
      setAuthView('recovery');
    } else if (parsed.kind === 'error') {
      setRecoveryLinkError(parsed.message);
      setAuthView('forgot');
      scrubRecoveryHash();
    }
  }, []);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);

  // MFA challenge/enrolment UI state (Item 5).
  const [mfaCode, setMfaCode] = useState('');
  const [mfaBusy, setMfaBusy] = useState(false);
  const [mfaError, setMfaError] = useState<string | null>(null);
  // Enrolment sub-state: the QR/secret returned by startMfaEnrolment.
  const [enrolData, setEnrolData] = useState<{ factorId: string; uri?: string | undefined; secret?: string | undefined } | null>(null);
  const [enrolLoading, setEnrolLoading] = useState(false);
  useEffect(() => {
    setMfaCode('');
    setMfaBusy(false);
    setMfaError(null);
    setEnrolData(null);
    setEnrolLoading(false);
  }, [mfaPending?.kind, mfaPending?.session.accessToken]);
  /** QR for the otpauth URI — generated LOCALLY in the browser (qrcode pkg),
      so the TOTP secret never leaves the device. */
  const [enrolQr, setEnrolQr] = useState<string | null>(null);
  useEffect(() => {
    const uri = enrolData?.uri;
    if (!uri) { setEnrolQr(null); return; }
    let live = true;
    QRCode.toDataURL(uri, { width: 220, margin: 1, errorCorrectionLevel: 'M' })
      .then((url) => { if (live) setEnrolQr(url); })
      .catch(() => { if (live) setEnrolQr(null); });
    return () => { live = false; };
  }, [enrolData?.uri]);

  const submitMfaChallenge = async () => {
    if (!onSubmitMfaCode) return;
    if (!/^\d{6}$/.test(mfaCode.trim())) { setMfaError('Enter the 6-digit code from your authenticator app.'); return; }
    await authFlight.run('mfa-challenge', async () => {
      setMfaBusy(true);
      setMfaError(null);
      try {
        const err = await onSubmitMfaCode(mfaCode.trim());
        setMfaCode('');
        if (err) setMfaError(err); else setCurrentTab('staff_dashboard');
      } finally { setMfaBusy(false); }
    });
  };

  // Begin enrolment when a privileged-role user has no factor yet.
  const beginEnrolment = async () => {
    if (!mfaPending || mfaPending.kind !== 'enrol') return;
    await authFlight.run('mfa-enrol-start', async () => {
      setEnrolLoading(true);
      setMfaError(null);
      try {
        const { startMfaEnrolment } = await import('../../lib/auth');
        const res = await startMfaEnrolment(mfaPending.session);
        if (res.status === 'ok' && res.factorId) {
          setEnrolData({ factorId: res.factorId, uri: res.uri, secret: res.secret });
        } else {
          setMfaError(res.message || 'Could not start enrolment. Please try again.');
        }
      } finally { setEnrolLoading(false); }
    });
  };

  // Verify the first code to activate a newly-enrolled factor, then finish sign-in.
  const submitEnrolmentCode = async () => {
    if (!mfaPending || mfaPending.kind !== 'enrol' || !enrolData) return;
    if (!/^\d{6}$/.test(mfaCode.trim())) { setMfaError('Enter the 6-digit code shown in your authenticator app.'); return; }
    await authFlight.run('mfa-enrol-verify', async () => {
      setMfaBusy(true);
      setMfaError(null);
      try {
        const { verifyMfaCode } = await import('../../lib/auth');
        const verified = await verifyMfaCode(mfaPending.session, enrolData.factorId, mfaCode.trim());
        setMfaCode('');
        if (verified.status === 'ok' && verified.session && onCompleteMfaEnrolment) {
          const err = await onCompleteMfaEnrolment(verified.session);
          setEnrolData(null);
          if (err) setMfaError(err); else setCurrentTab('staff_dashboard');
        } else {
          setMfaError(verified.status === 'invalid_credentials' ? (verified.message || 'That code was not correct.') : (verified.message || 'Enrolment failed.'));
        }
      } finally { setMfaBusy(false); }
    });
  };

  const submitSignIn = async () => {
    if (!onSignIn) return;
    setLoginError(null);
    if (!loginEmail.trim() || !loginPassword) {
      setLoginError('Enter your email and password.');
      return;
    }
    await authFlight.run('sign-in', async () => {
      setLoginBusy(true);
      try {
        const err = await onSignIn(loginEmail, loginPassword);
        // On success the parent hook sets `employee` and remounts the portal.
        setLoginPassword('');
        if (err) setLoginError(err);
      } finally { setLoginBusy(false); }
    });
  };



  return (
    <>
      {currentTab === 'staff_login' && (
        <div className="max-w-md mx-auto py-16 px-4">
          <div className="bg-white p-8 sm:p-10 rounded-3xl border border-[#EBDECE] shadow-sm flex flex-col justify-between text-left">
            <div className="space-y-6">
              <div className="space-y-3 text-center flex flex-col items-center">
                <LogoVertical className="h-20 w-auto" title="Milk Pop staff portal" />
                <h2 className="text-xl font-bold tracking-tight text-[#2E2A26]">Staff Portal Access</h2>
                <p className="text-xs text-neutral-500 leading-relaxed text-center">
                  Verify your secure credentials to log hours, organize shifts, access the academy courses, and handle compliance records.
                </p>
              </div>

              {/* SECURITY: this form performs NO client-side credential check.
                  It only forwards email+password to Supabase Auth via onSignIn;
                  the verified session and the role come back from the server.
                  When no backend is configured we keep the honest fail-closed
                  notice instead of a form that cannot work. */}
              {authConfigured ? (authView !== 'login' ? (
                <PasswordRecoveryCard
                  mode={authView === 'recovery' ? 'complete' : 'request'}
                  recoveryToken={recoveryToken}
                  linkError={recoveryLinkError}
                  onBackToLogin={() => { setAuthView('login'); setRecoveryLinkError(''); setRecoveryToken(''); }}
                />
              ) : (
                <div className="space-y-4 text-left">
                  <div className="space-y-1.5">
                    <label htmlFor="staff-email" className="text-2xs font-extrabold uppercase tracking-wider text-neutral-500">Email</label>
                    <input
                      id="staff-email"
                      type="email"
                      autoComplete="username"
                      value={loginEmail}
                      onChange={(e) => setLoginEmail(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitSignIn(); }}
                      disabled={loginBusy || authLoading}
                      className="w-full px-4 py-2.5 rounded-xl border border-[#EBDECE] bg-white text-sm text-[#2E2A26] focus:outline-none focus:ring-2 focus:ring-[#A46832]/40"
                      placeholder="you@milkpop.uk"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor="staff-password" className="text-2xs font-extrabold uppercase tracking-wider text-neutral-500">Password</label>
                    <input
                      id="staff-password"
                      type="password"
                      autoComplete="current-password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitSignIn(); }}
                      disabled={loginBusy || authLoading}
                      className="w-full px-4 py-2.5 rounded-xl border border-[#EBDECE] bg-white text-sm text-[#2E2A26] focus:outline-none focus:ring-2 focus:ring-[#A46832]/40"
                      placeholder="••••••••"
                    />
                  </div>
                  {loginError && (
                    <p role="alert" className="text-xs text-red-600 leading-relaxed">{loginError}</p>
                  )}
                  <button
                    type="button"
                    onClick={() => setAuthView('forgot')}
                    className="text-xs font-bold text-[#8F5322] underline cursor-pointer min-h-11 text-left"
                  >
                    Forgot password?
                  </button>
                  <button
                    id="staff-signin-submit"
                    onClick={submitSignIn}
                    disabled={loginBusy || authLoading}
                    className="w-full px-5 py-3 bg-[#2E2A26] hover:bg-[#A46832] disabled:opacity-60 disabled:cursor-not-allowed text-white rounded-full text-2xs font-extrabold uppercase tracking-wider transition-all cursor-pointer"
                  >
                    {loginBusy ? 'Signing in…' : authLoading ? 'Checking session…' : 'Sign in'}
                  </button>
                  <p className="text-[10px] text-neutral-400 leading-relaxed text-center">
                    Accounts are provisioned by your manager. First time signing in?
                    Use the email your invite was sent to.
                  </p>
                </div>
              )) : (
                <div className="p-5 bg-amber-50 border border-amber-200 rounded-2xl space-y-2 text-left">
                  <p className="text-xs font-extrabold text-[#2E2A26] uppercase tracking-wider">Sign-in unavailable</p>
                  <p className="text-xs text-neutral-600 leading-relaxed">
                    No authentication backend is configured for this deployment yet,
                    so staff sign-in is disabled rather than run in an insecure mode.
                  </p>
                  <p className="text-[10px] text-neutral-500 leading-relaxed">
                    Administrators: set <span className="font-mono">VITE_SUPABASE_URL</span> / <span className="font-mono">VITE_SUPABASE_ANON_KEY</span>,
                    apply the auth migrations, then follow <span className="font-mono">PRODUCTION-COMMISSIONING-T13.3.30.md</span> → One-time real bootstrap to create the first owner login.
                  </p>
                </div>
              )}
            </div>

            <div className="border-t border-neutral-100 pt-6 mt-8">
              <p className="text-[10px] text-neutral-400 leading-relaxed font-light text-center">
                Milk Pop UK staff portal.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ===== MFA: challenge (enter code) OR mandatory enrolment (Item 5) ===== */}
      {currentTab === 'staff_mfa' && mfaPending && (
        <div className="max-w-md mx-auto py-16 px-4">
          <div className="bg-white p-8 sm:p-10 rounded-3xl border border-[#EBDECE] shadow-sm text-left space-y-6">
            <div className="space-y-3 text-center flex flex-col items-center">
              <LogoVertical className="h-16 w-auto" title="Milk Pop staff portal" />
              <h2 className="text-xl font-bold tracking-tight text-[#2E2A26]">
                {mfaPending.kind === 'challenge' ? 'Two-step verification' : 'Set up two-step verification'}
              </h2>
              <p className="text-xs text-neutral-500 leading-relaxed text-center">
                {mfaPending.kind === 'challenge'
                  ? 'Enter the 6-digit code from your authenticator app to finish signing in.'
                  : 'Two-factor authentication is required for your role. Scan the code with an authenticator app (e.g. Google Authenticator, 1Password, Authy), then enter the 6-digit code it shows.'}
              </p>
            </div>

            {/* CHALLENGE: existing verified factor → just enter the code */}
            {mfaPending.kind === 'challenge' && (
              <div className="space-y-4">
                <input
                  id="staff-mfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitMfaChallenge(); }}
                  disabled={mfaBusy}
                  className="w-full px-4 py-3 text-center tracking-[0.5em] font-mono text-lg rounded-xl border border-[#EBDECE] bg-white text-[#2E2A26] focus:outline-none focus:ring-2 focus:ring-[#A46832]/40"
                  placeholder="000000"
                />
                {mfaError && <p role="alert" className="text-xs text-red-600 leading-relaxed">{mfaError}</p>}
                <button
                  id="staff-mfa-submit"
                  onClick={submitMfaChallenge}
                  disabled={mfaBusy}
                  className="w-full px-5 py-3 bg-[#2E2A26] hover:bg-[#A46832] disabled:opacity-60 text-white rounded-full text-2xs font-extrabold uppercase tracking-wider transition-all cursor-pointer"
                >
                  {mfaBusy ? 'Verifying…' : 'Verify & sign in'}
                </button>
              </div>
            )}

            {/* ENROL: privileged role with no factor → provision one, then verify */}
            {mfaPending.kind === 'enrol' && (
              <div className="space-y-4">
                {!enrolData ? (
                  <button
                    onClick={beginEnrolment}
                    disabled={enrolLoading}
                    className="w-full px-5 py-3 bg-[#2E2A26] hover:bg-[#A46832] disabled:opacity-60 text-white rounded-full text-2xs font-extrabold uppercase tracking-wider cursor-pointer"
                  >
                    {enrolLoading ? 'Preparing…' : 'Begin set-up'}
                  </button>
                ) : (
                  <div className="space-y-4">
                    {enrolData.uri && (
                      <div className="flex flex-col items-center gap-2">
                        {/* QR generated locally in the browser (qrcode package):
                            the otpauth secret never leaves this device. */}
                        {enrolQr ? (
                          <>
                            <p className="text-[10px] text-neutral-500 text-center">Scan with your authenticator app, then enter the 6-digit code it shows:</p>
                            <img
                              src={enrolQr}
                              alt="Authenticator set-up QR code"
                              width={200}
                              height={200}
                              className="rounded-xl border border-[#EBDECE] bg-white p-2"
                            />
                            <details className="w-full text-center">
                              <summary className="text-[10px] text-neutral-400 cursor-pointer select-none">Can't scan? Enter the key manually</summary>
                              <code className="block w-full text-center text-xs font-mono bg-[#F7EFE6] border border-[#EBDECE] rounded-xl px-3 py-2 break-all mt-2">
                                {enrolData.secret || enrolData.uri}
                              </code>
                              <p className="text-[9px] text-neutral-400 mt-1">This key doesn't expire — only the 6-digit codes rotate every 30 seconds.</p>
                            </details>
                          </>
                        ) : (
                          <>
                            <p className="text-[10px] text-neutral-500 text-center">Enter this setup key in your authenticator app (it doesn't expire):</p>
                            <code className="block w-full text-center text-xs font-mono bg-[#F7EFE6] border border-[#EBDECE] rounded-xl px-3 py-2 break-all">
                              {enrolData.secret || enrolData.uri}
                            </code>
                          </>
                        )}
                      </div>
                    )}
                    <input
                      id="staff-mfa-enrol-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitEnrolmentCode(); }}
                      disabled={mfaBusy}
                      className="w-full px-4 py-3 text-center tracking-[0.5em] font-mono text-lg rounded-xl border border-[#EBDECE] bg-white text-[#2E2A26] focus:outline-none focus:ring-2 focus:ring-[#A46832]/40"
                      placeholder="000000"
                    />
                    <button
                      onClick={submitEnrolmentCode}
                      disabled={mfaBusy}
                      className="w-full px-5 py-3 bg-[#2E2A26] hover:bg-[#A46832] disabled:opacity-60 text-white rounded-full text-2xs font-extrabold uppercase tracking-wider cursor-pointer"
                    >
                      {mfaBusy ? 'Activating…' : 'Activate & sign in'}
                    </button>
                  </div>
                )}
                {mfaError && <p role="alert" className="text-xs text-red-600 leading-relaxed">{mfaError}</p>}
              </div>
            )}

            <button
              onClick={async () => { if (onCancelMfa) await onCancelMfa(); setMfaCode(''); setEnrolData(null); setMfaError(null); setCurrentTab('staff_login'); }}
              className="w-full text-[10px] text-neutral-400 hover:text-neutral-600 underline cursor-pointer"
            >
              Cancel and return to sign-in
            </button>
          </div>
        </div>
      )}


    </>
  );
};

export default memo(StaffAuthPanel);
