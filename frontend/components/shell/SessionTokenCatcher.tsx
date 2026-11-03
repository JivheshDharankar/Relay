'use client';

import React, { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { exchangeOAuthGrant, setSessionToken } from '@/lib/api';
import { useSession } from '@/lib/session/SessionContext';

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

  useEffect(() => {
    const grant = searchParams.get('oauthGrant');
    if (!grant) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await exchangeOAuthGrant(grant);
        if (cancelled) return;
        if (info.session.token) {
          setSessionToken(info.session.token);
        }
      } catch {
        // Invalid/expired/consumed grant: fall through to the normal
        // unauthenticated experience rather than trapping the user.
      } finally {
        if (cancelled) return;
        const params = new URLSearchParams(searchParams.toString());
        params.delete('oauthGrant');
        const clean = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
        router.replace(clean);
        void refresh();
      }
    })();
    return () => {
      cancelled = true;
    };
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
