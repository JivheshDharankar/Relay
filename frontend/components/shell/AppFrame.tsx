'use client';

import React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { MotionConfig } from 'framer-motion';
import { AppShell } from '@/components/shell/AppShell';
import { SessionTokenCatcher } from '@/components/shell/SessionTokenCatcher';
import { SessionProvider, useSession } from '@/lib/session/SessionContext';
import { useResidentContext } from '@/lib/session/useResidentContext';
import { RunStoreProvider } from '@/lib/workflow/runStore';
import { MissionSessionProvider } from '@/lib/workflow/MissionSessionContext';

/**
 * Minimal frame for logged-out visitors: no sidebar, no top bar, no resident
 * context. The OAuth token catcher still runs so Google redirects land here.
 */
function PublicFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-relay-surface-bg text-relay-ink-900 flex flex-col">
      <SessionTokenCatcher />
      <main className="flex-1 w-full flex flex-col">{children}</main>
      <footer className="border-t border-relay-surface-border bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-1.5 text-xs text-relay-ink-500">
          <span>Relay — autonomous community procurement</span>
          <span>State shown is backend-verified</span>
        </div>
      </footer>
    </div>
  );
}

/**
 * Activation frame for signed-in residents who have not finished onboarding:
 * branding plus sign-out, never the application navigation. The onboarding
 * page itself renders progress, the current step, and Back/Continue.
 */
function OnboardingFrame({
  children,
  onSignOut,
}: {
  children: React.ReactNode;
  onSignOut: () => void;
}) {
  return (
    <div className="min-h-screen bg-relay-surface-bg text-relay-ink-900 flex flex-col">
      <SessionTokenCatcher />
      <header className="border-b border-relay-surface-border bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-relay-navy-900 shrink-0">
              <span className="text-white text-[11px] font-bold tracking-tight" aria-hidden>R</span>
            </span>
            <div className="leading-tight min-w-0">
              <p className="font-bold text-[15px] tracking-tight truncate">RELAY</p>
              <p className="text-[11px] text-relay-ink-600 truncate">Autonomous community procurement</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="text-[13px] font-semibold text-relay-ink-600 hover:text-relay-ink-900 min-h-[36px] px-2 shrink-0"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 w-full flex flex-col">{children}</main>
      <footer className="border-t border-relay-surface-border bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-1.5 text-xs text-relay-ink-500">
          <span>Relay — autonomous community procurement</span>
          <span>State shown is backend-verified</span>
        </div>
      </footer>
    </div>
  );
}

/** Neutral placeholder while a private route waits for a verified session. */
function GuardSplash({
  message,
  error,
  onRetry,
}: {
  message: string;
  error?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div
      className="flex-1 flex flex-col items-center justify-center gap-2 py-24"
      role="status"
      aria-label={message}
    >
      <p className="font-bold text-relay-ink-900 text-lg tracking-tight">RELAY</p>
      <p className="text-sm text-relay-ink-500">{message}</p>
      {error && (
        <>
          <p className="text-sm text-relay-ink-700 max-w-sm text-center">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 text-sm font-semibold text-relay-primary-600 hover:text-relay-primary-700 min-h-[36px] px-3"
            >
              Retry
            </button>
          )}
        </>
      )}
    </div>
  );
}

function ShellFrame({ children }: { children: React.ReactNode }) {
  const { status: sessionStatus, error: sessionError, refresh: refreshSession, signOut } = useSession();
  const resident = useResidentContext();
  const router = useRouter();
  const pathname = usePathname();

  // The shell outlives page navigation: refresh identity context on every
  // route change so the sidebar/footer never shows pre-onboarding data.
  // (Initial load is covered by the hook's own fetch; skip it here.)
  const reload = resident.reload;
  const prevPath = React.useRef(pathname);
  React.useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    if (sessionStatus === 'authenticated') {
      void reload();
    }
  }, [pathname, sessionStatus, reload]);

  // Login-first routing: logged-out visitors never see the authenticated
  // application shell. Driven by the verified session mechanism only.
  // Home (/) keeps its own page-level redirect + splash; every other
  // non-login route is guarded centrally here.
  const isPublicRoute = pathname === '/login';
  const isHome = pathname === '/';
  const isOnboardingRoute = pathname === '/onboarding';
  const isLoggedOutHome = isHome && sessionStatus !== 'authenticated';
  const guarded = !isPublicRoute && !isHome;

  React.useEffect(() => {
    if (!guarded || sessionStatus !== 'anonymous') return;
    router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [guarded, sessionStatus, pathname, router]);

  // Onboarding activation boundary: signed-in residents who have not
  // finished onboarding stay inside the activation flow. Only redirect once
  // identity has settled to avoid bouncing fresh completions back.
  const onboardingComplete = resident.onboarding?.isComplete ?? null;
  const activationPending =
    sessionStatus === 'authenticated' && !resident.unauthorized && onboardingComplete === false;
  React.useEffect(() => {
    if (!activationPending || resident.loading || isOnboardingRoute || isPublicRoute) return;
    router.replace('/onboarding');
  }, [activationPending, resident.loading, isOnboardingRoute, isPublicRoute, router]);

  const handleSignOut = () => {
    void signOut().then(() => router.push('/login'));
  };

  if (isPublicRoute || isLoggedOutHome) {
    return <PublicFrame>{children}</PublicFrame>;
  }
  if (guarded && sessionStatus !== 'authenticated') {
    // Private route without a verified session: neutral splash inside the
    // public frame — never the shell, never the page content. The effect
    // above redirects once anonymity is confirmed (not while resolving).
    return (
      <PublicFrame>
        <GuardSplash
          message={sessionStatus === 'loading' ? 'Checking your session…' : 'Redirecting to sign-in…'}
          error={sessionStatus === 'loading' ? sessionError : null}
          onRetry={() => void refreshSession()}
        />
      </PublicFrame>
    );
  }
  if (activationPending && !isPublicRoute) {
    // Incomplete onboarding: activation frame only, never the app shell.
    // The onboarding page renders the correct step from backend status.
    if (!isOnboardingRoute) {
      return (
        <OnboardingFrame onSignOut={handleSignOut}>
          <GuardSplash message="Resuming onboarding…" />
        </OnboardingFrame>
      );
    }
    return <OnboardingFrame onSignOut={handleSignOut}>{children}</OnboardingFrame>;
  }
  if (sessionStatus === 'authenticated' && onboardingComplete === null && resident.loading && !isPublicRoute) {
    // First paint before activation state resolves: hold a splash rather
    // than flashing the full navigation to an incomplete resident.
    return (
      <PublicFrame>
        <GuardSplash message="Checking your session…" />
      </PublicFrame>
    );
  }

  return (
    <AppShell
      identity={{
        societyName: resident.profile?.societyName ?? null,
        flatLabel: resident.profile?.flatNumber ?? null,
        mandateActive: resident.profile ? resident.profile.activeMandate !== null : null,
        loading: resident.loading,
        // Session truth: profile is null pre-membership even when signed in.
        authenticated: sessionStatus === 'authenticated' && !resident.unauthorized,
      }}
      onSignOut={handleSignOut}
    >
      <SessionTokenCatcher />
      {children}
    </AppShell>
  );
}

export function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user">
      <SessionProvider>
        <RunStoreProvider>
          <MissionSessionProvider>
            <ShellFrame>{children}</ShellFrame>
          </MissionSessionProvider>
        </RunStoreProvider>
      </SessionProvider>
    </MotionConfig>
  );
}
