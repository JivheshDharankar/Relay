'use client';

import React, { Suspense, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { exchangeOAuthGrant, setSessionToken } from '@/lib/api';
import { useSession } from '@/lib/session/SessionContext';

/**
 * Removes the `oauthGrant` search parameter synchronously from the current
 * browser URL via history.replaceState, preserving pathname, hash, and other params.
 */
export function stripOAuthGrantParam(): string {
  if (typeof window === 'undefined') return '';
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('oauthGrant')) {
      url.searchParams.delete('oauthGrant');
      const clean = `${url.pathname}${url.search ? url.search : ''}${url.hash || ''}`;
      window.history.replaceState(null, '', clean);
      return clean;
    }
    return `${url.pathname}${url.search ? url.search : ''}${url.hash || ''}`;
  } catch {
    return window.location.pathname;
  }
}

/**
 * Module-level in-flight deduplication set across Strict Mode and concurrent mounts.
 */
const inFlightGrants = new Set<string>();

/**
 * Captures the backend's OAuth redirect (`?oauthGrant=...`), exchanges the
 * single-use grant code for a session, and refreshes the session. The URL
 * carries only the short-lived grant — never the session token. Runs on every
 * route; no-ops without the parameter.
 */
function Catcher() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { refresh } = useSession();
  const inFlightRef = useRef<string | null>(null);

  useEffect(() => {
    const grant = searchParams.get('oauthGrant');
    if (!grant || inFlightRef.current === grant || inFlightGrants.has(grant)) return;
    inFlightRef.current = grant;
    inFlightGrants.add(grant);

    (async () => {
      try {
        const info = await exchangeOAuthGrant(grant);
        if (info.session.token) {
          setSessionToken(info.session.token);
        }
      } catch {
        // Invalid/expired/consumed grant: fall through to the normal
        // unauthenticated experience rather than trapping the user.
      } finally {
        inFlightGrants.delete(grant);
        // Synchronously strip the grant param from the browser URL BEFORE
        // triggering refresh() so that a failed exchange immediately transitions
        // to 'anonymous' rather than hanging in 'loading'.
        const clean = stripOAuthGrantParam();
        router.replace(clean || window.location.pathname);
        void refresh();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return null;
}

export function SessionTokenCatcher() {
  return (
    <Suspense fallback={null}>
      <Catcher />
    </Suspense>
  );
}
