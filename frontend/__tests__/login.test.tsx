import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LoginPage from '@/app/login/page';
import { getAuthProviders, getGoogleAuthUrl, getOnboardingStatus } from '@/lib/api';

const pushMock = vi.fn();
const routerMock = { push: pushMock, replace: vi.fn() };
let searchParams = new URLSearchParams();
let sessionStatus = 'anonymous';

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  useSearchParams: () => searchParams,
}));

vi.mock('@/lib/session/SessionContext', () => ({
  useSession: () => ({ status: sessionStatus, session: null, refresh: vi.fn(), signOut: vi.fn() }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, getAuthProviders: vi.fn(), getOnboardingStatus: vi.fn() };
});

const mockedProviders = vi.mocked(getAuthProviders);
const mockedOnboarding = vi.mocked(getOnboardingStatus);

describe('login Google option (frozen Phase 12.5 contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStatus = 'anonymous';
    searchParams = new URLSearchParams();
    sessionStorage.clear();
  });

  it('renders Continue with Google even when /api/auth/providers fails', async () => {
    mockedProviders.mockRejectedValueOnce(new Error('providers down'));
    render(<LoginPage />);
    // Button must be present immediately — never gated on the providers fetch.
    expect(screen.getByRole('button', { name: /Continue with Google/ })).not.toBeNull();
    await waitFor(() => expect(mockedProviders).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Continue with Google/ })).not.toBeNull();
  });

  it('renders Continue with Google when providers resolve', async () => {
    mockedProviders.mockResolvedValueOnce([
      { id: 'GOOGLE', name: 'Google', type: 'OAUTH', status: 'CONFIGURED', isAvailable: true, requiresConfig: false },
    ]);
    render(<LoginPage />);
    await waitFor(() => expect(mockedProviders).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Continue with Google/ })).not.toBeNull();
  });

  it('navigates to the existing GET /api/auth/google endpoint', async () => {
    mockedProviders.mockResolvedValueOnce([]);
    const href: { current: string } = { current: '' };
    Object.defineProperty(window, 'location', {
      value: {
        get href() {
          return href.current;
        },
        set href(v: string) {
          href.current = v;
        },
      },
      writable: true,
    });
    render(<LoginPage />);
    await waitFor(() => expect(mockedProviders).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));
    expect(href.current).toBe(getGoogleAuthUrl());
    expect(href.current.endsWith('/api/auth/google')).toBe(true);
  });

  it('keeps Email and Phone OTP options alongside Google', async () => {
    mockedProviders.mockResolvedValueOnce([]);
    render(<LoginPage />);
    await waitFor(() => expect(mockedProviders).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Continue with Google/ })).not.toBeNull();
    expect(screen.getByRole('tablist', { name: /Sign-in method/ })).not.toBeNull();
  });
});

describe('login deep-link intent (?next=)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStatus = 'authenticated';
    searchParams = new URLSearchParams();
    sessionStorage.clear();
  });

  it('returns onboarding-complete users to their deep link', async () => {
    searchParams = new URLSearchParams('next=%2Fmarket');
    mockedProviders.mockResolvedValueOnce([]);
    mockedOnboarding.mockResolvedValueOnce({ isComplete: true } as never);
    render(<LoginPage />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/market'));
  });

  it('lands on home without a deep link', async () => {
    mockedProviders.mockResolvedValueOnce([]);
    mockedOnboarding.mockResolvedValueOnce({ isComplete: true } as never);
    render(<LoginPage />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/'));
  });

  it('sends incomplete onboarding to /onboarding even with a deep link', async () => {
    searchParams = new URLSearchParams('next=%2Fmarket');
    mockedProviders.mockResolvedValueOnce([]);
    mockedOnboarding.mockResolvedValueOnce({ isComplete: false } as never);
    render(<LoginPage />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/onboarding'));
  });

  it('rejects absolute URLs, protocol-relative targets, and login loops', async () => {
    for (const hostile of [
      'https%3A%2F%2Fevil.example%2F',
      '%2F%2Fevil.example%2Fmarket',
      '%2Flogin',
      '%2Flogin%3Fnext%3D%252Fmarket',
    ]) {
      pushMock.mockClear();
      mockedProviders.mockResolvedValueOnce([]);
      mockedOnboarding.mockResolvedValueOnce({ isComplete: true } as never);
      searchParams = new URLSearchParams(`next=${hostile}`);
      const { unmount } = render(<LoginPage />);
      await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/'));
      unmount();
    }
  });

  it('stashes the deep link across the Google redirect round-trip', async () => {
    sessionStatus = 'anonymous';
    searchParams = new URLSearchParams('next=%2Freconciliation');
    mockedProviders.mockResolvedValueOnce([]);
    const href: { current: string } = { current: '' };
    Object.defineProperty(window, 'location', {
      value: {
        get href() {
          return href.current;
        },
        set href(v: string) {
          href.current = v;
        },
      },
      writable: true,
    });
    render(<LoginPage />);
    await waitFor(() => expect(mockedProviders).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));
    expect(sessionStorage.getItem('relay:post-login-next')).toBe('/reconciliation');
  });
});
