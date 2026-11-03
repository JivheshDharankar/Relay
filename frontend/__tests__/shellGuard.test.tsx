import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AppFrame } from '@/components/shell/AppFrame';

const replaceMock = vi.fn();
const pushMock = vi.fn();
let currentPath = '/market';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => currentPath,
  useSearchParams: () => new URLSearchParams(),
}));

let sessionStatus: string = 'anonymous';
let residentOnboarding: { isComplete: boolean } | null = null;
let residentLoading = false;
vi.mock('@/lib/session/SessionContext', () => ({
  useSession: () => ({
    status: sessionStatus,
    session: null,
    refresh: vi.fn(),
    signOut: vi.fn(),
    markUnauthorized: vi.fn(),
  }),
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/session/useResidentContext', () => ({
  useResidentContext: () => ({
    profile: null,
    payments: null,
    mandate: null,
    paymentsTrusted: false,
    loading: residentLoading,
    error: null,
    unauthorized: false,
    hasMembership: false,
    onboarding: residentOnboarding,
    reload: vi.fn(),
  }),
}));

vi.mock('@/lib/workflow/runStore', () => ({
  useRunStore: () => ({ recordRun: vi.fn(), latestRun: null, runs: [] }),
  RunStoreProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/shell/SessionTokenCatcher', () => ({
  SessionTokenCatcher: () => null,
}));

// The shell under test: any rendered <aside> means the authenticated
// application shell leaked to the visitor.
vi.mock('@/components/shell/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
}));

describe('login-first shell guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStatus = 'anonymous';
    residentOnboarding = null;
    residentLoading = false;
    currentPath = '/market';
  });

  it('redirects anonymous visitors on private routes to /login with deep-link intent', async () => {
    render(
      <AppFrame>
        <div>PRIVATE MARKET CONTENT</div>
      </AppFrame>
    );
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fmarket'));
    // No authenticated shell and no private content before authentication.
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByText('PRIVATE MARKET CONTENT')).toBeNull();
    expect(screen.getByRole('status')).not.toBeNull();
  });

  it('guards nested private routes the same way', async () => {
    currentPath = '/runs/run_123/reconciliation';
    render(
      <AppFrame>
        <div>PRIVATE RECON CONTENT</div>
      </AppFrame>
    );
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Fruns%2Frun_123%2Freconciliation')
    );
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByText('PRIVATE RECON CONTENT')).toBeNull();
  });

  it('does not redirect while the session is still resolving', () => {
    sessionStatus = 'loading';
    render(
      <AppFrame>
        <div>PRIVATE MARKET CONTENT</div>
      </AppFrame>
    );
    expect(replaceMock).not.toHaveBeenCalled();
    // Still no shell and no private content during resolution.
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByText('PRIVATE MARKET CONTENT')).toBeNull();
    expect(screen.getByRole('status')).not.toBeNull();
  });

  it('leaves /login alone for anonymous visitors', () => {
    currentPath = '/login';
    render(
      <AppFrame>
        <div>LOGIN FORM</div>
      </AppFrame>
    );
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByText('LOGIN FORM')).not.toBeNull();
  });

  it('renders private routes normally for authenticated sessions', () => {
    sessionStatus = 'authenticated';
    residentOnboarding = { isComplete: true };
    render(
      <AppFrame>
        <div>PRIVATE MARKET CONTENT</div>
      </AppFrame>
    );
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByText('PRIVATE MARKET CONTENT')).not.toBeNull();
  });
});

describe('onboarding activation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStatus = 'authenticated';
    residentOnboarding = { isComplete: false };
    residentLoading = false;
    currentPath = '/market';
  });

  it('returns incomplete residents on app routes to onboarding without the shell', async () => {
    render(
      <AppFrame>
        <div>PRIVATE MARKET CONTENT</div>
      </AppFrame>
    );
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/onboarding'));
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByText('PRIVATE MARKET CONTENT')).toBeNull();
    expect(screen.getByRole('status')).not.toBeNull();
  });

  it('renders onboarding inside the activation frame with sign-out, never the shell', () => {
    currentPath = '/onboarding';
    render(
      <AppFrame>
        <div>ONBOARDING STEP</div>
      </AppFrame>
    );
    expect(replaceMock).not.toHaveBeenCalled();
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.getByText('ONBOARDING STEP')).not.toBeNull();
    expect(screen.getByRole('button', { name: /sign out/i })).not.toBeNull();
  });

  it('holds a splash on first paint before activation state resolves', () => {
    residentOnboarding = null;
    residentLoading = true;
    render(
      <AppFrame>
        <div>PRIVATE MARKET CONTENT</div>
      </AppFrame>
    );
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByText('PRIVATE MARKET CONTENT')).toBeNull();
    expect(screen.getByRole('status')).not.toBeNull();
  });

  it('does not bounce settled complete residents', () => {
    residentOnboarding = { isComplete: true };
    render(
      <AppFrame>
        <div>PRIVATE MARKET CONTENT</div>
      </AppFrame>
    );
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByText('PRIVATE MARKET CONTENT')).not.toBeNull();
  });
});
