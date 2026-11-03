'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ApiClientError,
  getSession,
  hasSessionToken,
  logout as apiLogout,
  SessionInfo,
} from '@/lib/api';

export type SessionStatus = 'loading' | 'authenticated' | 'anonymous';

interface SessionState {
  status: SessionStatus;
  session: SessionInfo | null;
  error: string | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  markUnauthorized: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

// Bounded retry for non-definitive session failures: a single network blip
// must not brick the app until the user presses Retry. 401/403 answers are
// definitive and are never retried.
const SESSION_VERIFY_MAX_ATTEMPTS = 3;
const SESSION_VERIFY_RETRY_DELAYS_MS = [1000, 2000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hasSessionToken()) {
      setSession(null);
      setError(null);
      setStatus('anonymous');
      return;
    }
    setStatus('loading');
    setError(null);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const info = await getSession();
        setSession(info);
        setStatus('authenticated');
        return;
      } catch (err) {
        if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
          setSession(null);
          setStatus('anonymous');
          return;
        }
        if (attempt >= SESSION_VERIFY_MAX_ATTEMPTS) {
          // Persistent transient failure (timeout, network outage, 5xx):
          // NOT definitive — stay loading with the error surfaced and keep
          // the stored token, so the router never redirects to /login on a
          // non-answer.
          setError(err instanceof Error ? err.message : 'Session check failed');
          setStatus('loading');
          return;
        }
        await delay(SESSION_VERIFY_RETRY_DELAYS_MS[attempt - 1] ?? 2000);
      }
    }
  }, []);

  const signOut = useCallback(async () => {
    await apiLogout();
    setSession(null);
    setError(null);
    setStatus('anonymous');
  }, []);

  const markUnauthorized = useCallback(() => {
    setSession(null);
    setStatus('anonymous');
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ status, session, error, refresh, signOut, markUnauthorized }),
    [status, session, error, refresh, signOut, markUnauthorized]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within SessionProvider');
  }
  return ctx;
}
