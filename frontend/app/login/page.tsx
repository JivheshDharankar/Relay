'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, Layers, Mail, Phone, Scale, ShieldCheck } from 'lucide-react';
import { Container } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import { Field, TextInput } from '@/components/ui/inputs';
import { LoadingState } from '@/components/feedback/Feedback';
import {
  ApiClientError,
  getAuthProviders,
  getGoogleAuthUrl,
  getOnboardingStatus,
  requestEmailOtp,
  requestPhoneOtp,
  setSessionToken,
  verifyEmailOtp,
  verifyPhoneOtp,
  type AuthProviderMetadata,
} from '@/lib/api';
import { useSession } from '@/lib/session/SessionContext';

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      className="flex items-start gap-2 rounded-lg border border-relay-danger-100 bg-relay-danger-50 px-3.5 py-2.5 text-[13px] text-relay-danger-700"
      role="alert"
    >
      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

function GoogleMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.3H12v4.3h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.1.1 3.5 2.7.2.1c2.2-2 3.8-5 3.8-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.2 0-5.9-2.1-6.8-5.1l-.1.1-3.6 2.8v.1C3.5 21.3 7.4 24 12 24z" />
      <path fill="#FBBC05" d="M5.2 14.3c-.2-.7-.4-1.5-.4-2.3s.1-1.6.4-2.3l-.1-.1-3.5-2.7-.1.1C.5 9 0 10.4 0 12s.5 3 1.4 4.3l3.8-2z" />
      <path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 16 0 12 0 7.4 0 3.5 2.7 1.5 6.7l3.8 2.9c.9-2.7 3.6-4.9 6.7-4.9z" />
    </svg>
  );
}

/** Deep-link target stashed across the Google redirect round-trip. */
const POST_LOGIN_NEXT_KEY = 'relay:post-login-next';

/** Accepts same-app relative paths only; rejects absolute URLs and loops. */
function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  if (path === '/login' || path.startsWith('/login?') || path.startsWith('/login#')) return null;
  return path;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { status: sessionStatus, error: sessionError, refresh } = useSession();
  const nextParam = safeNext(searchParams.get('next'));

  const consumeStashedNext = (): string | null => {
    try {
      const raw = sessionStorage.getItem(POST_LOGIN_NEXT_KEY);
      sessionStorage.removeItem(POST_LOGIN_NEXT_KEY);
      return safeNext(raw);
    } catch {
      return null;
    }
  };

  // Onboarding-complete users return to their deep link; everyone else
  // follows the standard onboarding/home flow.
  const postLoginTarget = (onboardingComplete: boolean): string =>
    onboardingComplete ? (nextParam ?? consumeStashedNext() ?? '/') : '/onboarding';

  const [providers, setProviders] = useState<AuthProviderMetadata[]>([]);
  const [tab, setTab] = useState<'email' | 'phone'>('email');

  const [email, setEmail] = useState('');
  const [emailOtp, setEmailOtp] = useState('');
  const [emailSent, setEmailSent] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);

  const [phone, setPhone] = useState('');
  const [phoneOtp, setPhoneOtp] = useState('');
  const [phoneSent, setPhoneSent] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  const [generalError, setGeneralError] = useState<string | null>(searchParams.get('error'));

  useEffect(() => {
    let cancelled = false;
    getAuthProviders()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch(() => {
        // Provider list is supplementary; auth forms stand alone.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (sessionStatus !== 'authenticated') return;
    let cancelled = false;
    getOnboardingStatus()
      .then((summary) => {
        if (!cancelled) router.push(postLoginTarget(summary.isComplete));
      })
      .catch(() => {
        if (!cancelled) router.push('/');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionStatus, router, nextParam]);

  const google = providers.find((p) => p.id === 'GOOGLE');

  const completeLogin = async (token: string | undefined, onboardingStatus: string | undefined) => {
    if (!token) throw new Error('Backend did not return a session token.');
    setSessionToken(token);
    await refresh();
    const summary = await getOnboardingStatus().catch(() => null);
    const complete = summary?.isComplete ?? onboardingStatus === 'ONBOARDING_COMPLETE';
    router.push(postLoginTarget(complete));
  };

  const describe = (err: unknown, fallback: string) => {
    if (err instanceof ApiClientError) {
      if (err.code === 'TIMEOUT') return 'Request timed out. Please try again.';
      if (err.code === 'NETWORK_ERROR') return 'Cannot reach Relay backend. Check that it is running.';
      return err.message;
    }
    return err instanceof Error ? err.message : fallback;
  };

  const handleEmailRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setEmailBusy(true);
    try {
      await requestEmailOtp(email.trim());
      setEmailSent(true);
    } catch (err) {
      setEmailError(describe(err, 'Failed to send verification code.'));
    } finally {
      setEmailBusy(false);
    }
  };

  const handleEmailVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setEmailError(null);
    setEmailBusy(true);
    try {
      const info = await verifyEmailOtp(email.trim(), emailOtp.trim());
      await completeLogin(info.session.token, info.user.onboardingStatus);
    } catch (err) {
      setEmailError(describe(err, 'Verification failed.'));
    } finally {
      setEmailBusy(false);
    }
  };

  const handlePhoneRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhoneError(null);
    setPhoneBusy(true);
    try {
      await requestPhoneOtp(phone.trim());
      setPhoneSent(true);
    } catch (err) {
      setPhoneError(describe(err, 'Failed to send verification code.'));
    } finally {
      setPhoneBusy(false);
    }
  };

  const handlePhoneVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setPhoneError(null);
    setPhoneBusy(true);
    try {
      const info = await verifyPhoneOtp(phone.trim(), phoneOtp.trim());
      await completeLogin(info.session.token, info.user.onboardingStatus);
    } catch (err) {
      setPhoneError(describe(err, 'Verification failed.'));
    } finally {
      setPhoneBusy(false);
    }
  };

  if (sessionStatus === 'loading') {
    return (
      <div className="w-full flex flex-col items-center">
        <LoadingState title="Checking session" description={sessionError ?? undefined} />
        {sessionError && (
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-1 text-sm font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[36px] px-3"
          >
            Retry
          </button>
        )}
      </div>
    );
  }
  if (sessionStatus === 'authenticated') return <LoadingState title="Signed in — redirecting" />;

  return (
    <div className="w-full max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-[1.05fr_1fr] gap-8 lg:gap-12 items-center">
      {/* Product story: static explanation, never live activity. */}
      <div className="space-y-7 px-1">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-relay-navy-900 shadow-raised">
            <Layers className="h-5 w-5 text-white" aria-hidden />
          </span>
          <div className="leading-tight">
            <p className="font-bold text-relay-ink-900 text-xl tracking-tight">RELAY</p>
            <p className="text-[13px] text-relay-ink-600">Autonomous community procurement</p>
          </div>
        </div>

        <div className="space-y-3">
          <h1 className="text-[34px] sm:text-[44px] font-bold tracking-[-0.02em] leading-[1.05] text-relay-ink-900">
            Tell Relay what you need.
          </h1>
          <p className="text-base sm:text-lg text-relay-ink-600 leading-relaxed max-w-xl">
            Relay finds qualified suppliers, negotiates where possible, and executes
            within your authorized mandate.
          </p>
        </div>

        <div className="rounded-lg border border-relay-surface-border bg-white shadow-card px-5 sm:px-6 py-5">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-relay-ink-500">
            How Relay works
          </p>
          <ol className="mt-4 space-y-0" aria-label="Relay procurement concept">
            {[
              ['Request', 'One natural-language command from your flat.'],
              ['Understand', 'Relay interprets products, quantities, and timing.'],
              ['Discover', 'Qualified wholesale suppliers in your service area.'],
              ['Negotiate', 'Better terms pursued where the market allows.'],
              ['Execute', 'Order, mandate-gated payment, and fulfillment.'],
              ['Verify', 'Delivery confirmed against the commitment.'],
              ['Reconcile', 'Every rupee traced: demand, supplier, payment, allocation.'],
            ].map(([step, detail], i, arr) => (
              <li key={step} className="relative flex gap-3.5 pb-4 last:pb-0">
                {i < arr.length - 1 && (
                  <span className="absolute left-[13px] top-7 bottom-0 w-px bg-relay-surface-border" aria-hidden />
                )}
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-relay-surface-border bg-relay-navy-50 font-mono text-[11px] font-semibold text-relay-ink-700"
                  aria-hidden
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="pt-0.5">
                  <span className="block text-sm font-semibold text-relay-ink-900">{step}</span>
                  <span className="block text-[13px] text-relay-ink-600 mt-0.5">{detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-relay-ink-600">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-relay-success-600" aria-hidden /> Private by design — your orders stay yours.
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Scale className="h-4 w-4 text-relay-primary-600" aria-hidden /> Every run ends in auditable proof.
          </span>
        </div>
      </div>

      {/* Sign-in card: verified auth logic below is unchanged. */}
      <div className="w-full max-w-md mx-auto lg:mx-0 lg:justify-self-end">
      <div className="rounded-lg border border-relay-surface-border bg-white shadow-card px-6 sm:px-8 py-8 space-y-5">
        <div className="flex flex-col items-center text-center space-y-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-relay-ink-900">Sign in to Relay</h2>
            <p className="text-sm text-relay-ink-600 mt-1">One account per resident. Orders stay private to you.</p>
          </div>
        </div>

        <ErrorNote message={generalError} />

        {/*
          ALWAYS rendered: visibility must not depend on the auxiliary
          /api/auth/providers fetch. Wired to existing GET /api/auth/google.
        */}
        <Button
          variant="outline"
          className="w-full"
          onClick={() => {
            if (google && !google.isAvailable) {
              setGeneralError(google.errorMessage ?? 'Google sign-in is not configured on this backend.');
              return;
            }
            // Preserve deep-link intent across the Google redirect round-trip.
            if (nextParam) {
              try {
                sessionStorage.setItem(POST_LOGIN_NEXT_KEY, nextParam);
              } catch {
                // Stash is best-effort; login still lands on the home flow.
              }
            }
            if (google?.authorizationUrl) {
              const base = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');
              window.location.href = `${base}${google.authorizationUrl}`;
              return;
            }
            window.location.href = getGoogleAuthUrl();
          }}
        >
          <GoogleMark />
          Continue with Google
        </Button>
        {google && !google.isAvailable && (
          <p className="text-xs text-relay-ink-500 text-center -mt-2">
            Google sign-in unavailable{google.errorMessage ? `: ${google.errorMessage}` : ''}
          </p>
        )}

        <div className="flex items-center gap-3 text-xs text-relay-ink-500">
          <span className="flex-1 h-px bg-relay-surface-border" aria-hidden />
          or continue with a one-time code
          <span className="flex-1 h-px bg-relay-surface-border" aria-hidden />
        </div>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-relay-navy-50 border border-relay-surface-border p-1" role="tablist" aria-label="Sign-in method">
          {(
            [
              { id: 'email', label: 'Email', icon: Mail },
              { id: 'phone', label: 'Phone', icon: Phone },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors min-h-[40px] ${
                tab === t.id ? 'bg-white text-relay-ink-900 shadow-card' : 'text-relay-ink-600 hover:text-relay-ink-900'
              }`}
            >
              <t.icon className="h-4 w-4" aria-hidden />
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'email' && (
          <form className="space-y-4" onSubmit={emailSent ? handleEmailVerify : handleEmailRequest}>
            <ErrorNote message={emailError} />
            <Field label="Email address" htmlFor="login-email">
              <TextInput
                id="login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={emailBusy || emailSent}
              />
            </Field>
            {emailSent && (
              <Field label="Verification code" htmlFor="login-email-otp" hint="Enter the code Relay sent to your email.">
                <TextInput
                  id="login-email-otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={emailOtp}
                  onChange={(e) => setEmailOtp(e.target.value)}
                  placeholder="6-digit code"
                  disabled={emailBusy}
                />
              </Field>
            )}
            <Button type="submit" className="w-full" isLoading={emailBusy}>
              {emailSent ? 'Verify & sign in' : 'Send code'}
            </Button>
            {emailSent && (
              <button
                type="button"
                onClick={() => {
                  setEmailSent(false);
                  setEmailOtp('');
                  setEmailError(null);
                }}
                className="w-full text-center text-xs font-medium text-relay-ink-600 hover:text-relay-ink-900 min-h-[32px]"
              >
                Use a different email
              </button>
            )}
          </form>
        )}

        {tab === 'phone' && (
          <form className="space-y-4" onSubmit={phoneSent ? handlePhoneVerify : handlePhoneRequest}>
            <ErrorNote message={phoneError} />
            <Field label="Phone number" htmlFor="login-phone" hint="Include country code, e.g. +91…">
              <TextInput
                id="login-phone"
                type="tel"
                autoComplete="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91…"
                disabled={phoneBusy || phoneSent}
              />
            </Field>
            {phoneSent && (
              <Field label="Verification code" htmlFor="login-phone-otp" hint="Enter the code Relay sent to your phone.">
                <TextInput
                  id="login-phone-otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  value={phoneOtp}
                  onChange={(e) => setPhoneOtp(e.target.value)}
                  placeholder="6-digit code"
                  disabled={phoneBusy}
                />
              </Field>
            )}
            <Button type="submit" className="w-full" isLoading={phoneBusy}>
              {phoneSent ? 'Verify & sign in' : 'Send code'}
            </Button>
            {phoneSent && (
              <button
                type="button"
                onClick={() => {
                  setPhoneSent(false);
                  setPhoneOtp('');
                  setPhoneError(null);
                }}
                className="w-full text-center text-xs font-medium text-relay-ink-600 hover:text-relay-ink-900 min-h-[32px]"
              >
                Use a different number
              </button>
            )}
          </form>
        )}
      </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex-1 flex items-center py-10 sm:py-14">
      <Container size="xl">
        <Suspense fallback={<LoadingState title="Loading sign-in" />}>
          <LoginForm />
        </Suspense>
      </Container>
    </div>
  );
}
