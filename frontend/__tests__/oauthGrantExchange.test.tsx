import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { AppFrame } from '@/components/shell/AppFrame';
import { ApiClientError, exchangeOAuthGrant, getSession } from '@/lib/api';

const replaceMock = vi.fn();
const pushMock = vi.fn();
let currentPath = '/onboarding';
let currentSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => currentPath,
  useSearchParams: () => currentSearchParams,
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    exchangeOAuthGrant: vi.fn(),
    getSession: vi.fn(),
  };
});

const mockedExchange = vi.mocked(exchangeOAuthGrant);
const mockedGetSession = vi.mocked(getSession);

vi.mock('@/lib/session/useResidentContext', () => ({
  useResidentContext: () => ({
    profile: null,
    payments: null,
    mandate: null,
    paymentsTrusted: false,
    loading: false,
    error: null,
    unauthorized: false,
    hasMembership: false,
    onboarding: { isComplete: false },
    reload: vi.fn(),
  }),
}));

vi.mock('@/lib/workflow/runStore', () => ({
  useRunStore: () => ({ recordRun: vi.fn(), latestRun: null, runs: [] }),
  RunStoreProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/workflow/MissionSessionContext', () => ({
  useMissionSession: () => ({ activeMissionRunId: null, setActiveMissionRunId: vi.fn() }),
  MissionSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock AppShell to expose when the authenticated frame renders
vi.mock('@/components/shell/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));

const VALID_SESSION_INFO = {
  user: {
    id: 'usr_oauth_test',
    authProvider: 'GOOGLE',
    email: 'oauth@example.com',
    phone: null,
    name: 'OAuth Test',
    profileImage: null,
    onboardingStatus: 'AUTHENTICATED',
    residentId: 'res_oauth_test',
  },
  residentId: 'res_oauth_test',
  session: {
    sessionId: 'sess_123',
    token: 'rly_token_success_999',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  },
  isNewUser: true,
};

describe('OAuth grant-code exchange & shell guard resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    currentPath = '/onboarding';
    currentSearchParams = new URLSearchParams();

    // Reset window.location using pushState
    window.history.pushState({}, '', '/onboarding');
  });

  it('1. Grant present, exchange succeeds → token saved, URL cleaned, never redirected to /login', async () => {
    const grant = 'rly_gr_fresh_valid';
    currentSearchParams = new URLSearchParams(`oauthGrant=${grant}`);
    window.history.pushState({}, '', `/onboarding?oauthGrant=${grant}`);

    mockedExchange.mockResolvedValueOnce(VALID_SESSION_INFO);
    mockedGetSession.mockResolvedValue(VALID_SESSION_INFO);

    render(
      <AppFrame>
        <div data-testid="onboarding-content">ONBOARDING CONTENT</div>
      </AppFrame>
    );

    await waitFor(() => {
      expect(mockedExchange).toHaveBeenCalledWith(grant);
    });

    await waitFor(() => {
      expect(localStorage.getItem('relay_session_token')).toBe('rly_token_success_999');
    });

    // Verify URL was cleaned synchronously
    expect(new URLSearchParams(window.location.search).has('oauthGrant')).toBe(false);

    // Verify user was NEVER bounced to /login
    expect(replaceMock).not.toHaveBeenCalledWith(expect.stringContaining('/login'));
  });

  it('2. React Strict Mode (effects invoked twice) → exchange is called exactly once and token is saved', async () => {
    const grant = 'rly_gr_strict_mode';
    currentSearchParams = new URLSearchParams(`oauthGrant=${grant}`);
    window.history.pushState({}, '', `/onboarding?oauthGrant=${grant}`);

    mockedExchange.mockResolvedValue(VALID_SESSION_INFO);
    mockedGetSession.mockResolvedValue(VALID_SESSION_INFO);

    render(
      <React.StrictMode>
        <AppFrame>
          <div>STRICT CONTENT</div>
        </AppFrame>
      </React.StrictMode>
    );

    await waitFor(() => {
      expect(mockedExchange).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(localStorage.getItem('relay_session_token')).toBe('rly_token_success_999');
    });

    expect(replaceMock).not.toHaveBeenCalledWith(expect.stringContaining('/login'));
  });

  it('3. Grant present, exchange fails (401) → URL cleaned, status becomes anonymous, redirects to /login without hang', async () => {
    const grant = 'rly_gr_invalid_expired';
    currentSearchParams = new URLSearchParams(`oauthGrant=${grant}`);
    window.history.pushState({}, '', `/onboarding?oauthGrant=${grant}`);

    mockedExchange.mockRejectedValueOnce(
      new ApiClientError('Invalid grant', 401, 'INVALID_OAUTH_GRANT')
    );

    render(
      <AppFrame>
        <div>ONBOARDING FAILING CONTENT</div>
      </AppFrame>
    );

    await waitFor(() => {
      expect(mockedExchange).toHaveBeenCalledWith(grant);
    });

    // Verify URL was cleaned via replaceState so it never hangs in loading
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).has('oauthGrant')).toBe(false);
    });

    // Verify user is redirected to /login after failure
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fonboarding');
    });

    expect(localStorage.getItem('relay_session_token')).toBeNull();
  });

  it('4. No grant, no token, on a guarded route → redirects to /login as before', async () => {
    currentPath = '/onboarding';
    currentSearchParams = new URLSearchParams();
    window.history.pushState({}, '', '/onboarding');

    render(
      <AppFrame>
        <div>PRIVATE ONBOARDING</div>
      </AppFrame>
    );

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fonboarding');
    });

    expect(mockedExchange).not.toHaveBeenCalled();
  });

  it('5. Existing token in localStorage → authenticated as before', async () => {
    localStorage.setItem('relay_session_token', 'rly_existing_valid');
    currentPath = '/onboarding';
    currentSearchParams = new URLSearchParams();
    window.history.pushState({}, '', '/onboarding');

    mockedGetSession.mockResolvedValue(VALID_SESSION_INFO);

    render(
      <AppFrame>
        <div data-testid="onboarding-view">AUTHENTICATED ONBOARDING</div>
      </AppFrame>
    );

    await waitFor(() => {
      expect(mockedGetSession).toHaveBeenCalled();
    });

    expect(replaceMock).not.toHaveBeenCalledWith(expect.stringContaining('/login'));
    expect(mockedExchange).not.toHaveBeenCalled();
  });
});
