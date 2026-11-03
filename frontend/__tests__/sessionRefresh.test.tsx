import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import React from 'react';
import { SessionProvider, useSession } from '@/lib/session/SessionContext';
import { ApiClientError, getSession } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getSession: vi.fn(),
    logout: vi.fn(),
  };
});

const mockedGetSession = vi.mocked(getSession);

const TOKEN_KEY = 'relay_session_token';
const SESSION = {
  user: {
    id: 'usr_test',
    authProvider: 'EMAIL',
    email: 'f5@example.com',
    phone: null,
    name: 'F5',
    profileImage: null,
    onboardingStatus: 'ONBOARDING_COMPLETE',
    residentId: 'res_test',
  },
  residentId: 'res_test',
  session: { sessionId: 'sess_test', expiresAt: new Date(Date.now() + 3600_000).toISOString() },
};

function wrapper({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}

/**
 * Login → refresh → session restored. A fresh provider mount is a new page
 * load: the stored token must be re-verified, never assumed and never
 * discarded on transient failures.
 */
describe('Session refresh (F5) restoration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetAllMocks();
  });

  it('remount with a stored token re-verifies and stays authenticated (F5)', async () => {
    localStorage.setItem(TOKEN_KEY, 'rly_stored_token');
    mockedGetSession.mockResolvedValue(SESSION as never);

    const first = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(first.result.current.status).toBe('authenticated'));
    first.unmount();

    // Browser refresh: brand-new provider, same stored token.
    const second = renderHook(() => useSession(), { wrapper });
    expect(second.result.current.status).toBe('loading');
    await waitFor(() => expect(second.result.current.status).toBe('authenticated'));
    expect(second.result.current.session?.user.email).toBe('f5@example.com');
    expect(mockedGetSession).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('rly_stored_token');
    second.unmount();
  });

  it('persistent transient failure retries, then stays loading with error (never logs out)', async () => {
    localStorage.setItem(TOKEN_KEY, 'rly_stored_token');
    mockedGetSession.mockRejectedValue(new ApiClientError('boom', 500, 'HTTP_ERROR'));

    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 10000 });
    // A 500/network failure is retried with backoff before surfacing, but a
    // persistent failure must still never redirect to /login.
    expect(mockedGetSession.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBe('boom');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('rly_stored_token');

    // Recovery: a later refresh succeeds without re-login.
    mockedGetSession.mockResolvedValueOnce(SESSION as never);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toBe('authenticated');
  }, 15000);

  it('transient blip recovers inside the retry budget without manual retry', async () => {
    localStorage.setItem(TOKEN_KEY, 'rly_stored_token');
    mockedGetSession.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mockedGetSession.mockResolvedValueOnce(SESSION as never);

    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('authenticated'), { timeout: 10000 });
    expect(mockedGetSession).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.session?.user.email).toBe('f5@example.com');
  }, 15000);

  it('401 is definitive: never retried, yields anonymous immediately', async () => {
    localStorage.setItem(TOKEN_KEY, 'rly_dead_token');
    mockedGetSession.mockRejectedValue(new ApiClientError('Invalid session', 401, 'UNAUTHORIZED'));

    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));
    expect(mockedGetSession).toHaveBeenCalledTimes(1);
    expect(result.current.session).toBeNull();
  });

  it('401 verification still yields anonymous (definitive unauthenticated)', async () => {
    localStorage.setItem(TOKEN_KEY, 'rly_dead_token');
    mockedGetSession.mockRejectedValueOnce(new ApiClientError('Invalid session', 401, 'UNAUTHORIZED'));

    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));
    expect(result.current.session).toBeNull();
  });

  it('absent token yields anonymous without a network call', async () => {
    const { result } = renderHook(() => useSession(), { wrapper });
    await waitFor(() => expect(result.current.status).toBe('anonymous'));
    expect(mockedGetSession).not.toHaveBeenCalled();
  });
});
