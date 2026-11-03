import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AppFrame } from '@/components/shell/AppFrame';

const replaceMock = vi.fn();
const pushMock = vi.fn();
let currentPath = '/runs';
let currentSearch = '';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => currentPath,
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

let sessionStatus: string = 'authenticated';
vi.mock('@/lib/session/SessionContext', () => ({
  useSession: () => ({
    status: sessionStatus,
    session: null,
    error: null,
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
    loading: false,
    error: null,
    unauthorized: false,
    hasMembership: true,
    onboarding: { isComplete: true },
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

vi.mock('@/components/shell/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
}));

/**
 * Refresh route preservation: an authenticated refresh is NOT a login
 * event. Hydration must never navigate — the browser stays at the exact
 * requested URL (path, dynamic segments, query, hash).
 */
describe('refresh preserves the current route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStatus = 'authenticated';
    currentPath = '/runs';
    currentSearch = '';
  });

  it.each([
    ['/runs'],
    ['/market'],
    ['/market/quotes'],
    ['/finance/payments'],
    ['/settings'],
    ['/mission'],
    ['/procurement'],
    ['/quotes'],
  ])('authenticated refresh on %s never navigates', (path) => {
    currentPath = path;
    render(
      <AppFrame>
        <div>CONTENT {path}</div>
      </AppFrame>
    );
    expect(replaceMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByText(`CONTENT ${path}`)).not.toBeNull();
  });

  it('authenticated refresh on a dynamic route keeps the exact segments', () => {
    currentPath = '/runs/run_abc123/reconciliation';
    render(
      <AppFrame>
        <div>DYNAMIC CONTENT</div>
      </AppFrame>
    );
    expect(replaceMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByText('DYNAMIC CONTENT')).not.toBeNull();
  });

  it('authenticated refresh with query parameters performs no navigation (params preserved)', () => {
    currentPath = '/market/quotes';
    currentSearch = '?run=run_abc123&tab=compare';
    render(
      <AppFrame>
        <div>QUOTES CONTENT</div>
      </AppFrame>
    );
    // Any programmatic navigation would drop or rewrite the query string.
    expect(replaceMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByText('QUOTES CONTENT')).not.toBeNull();
  });

  it('loading-to-authenticated hydration never calls replace/push with /', () => {
    sessionStatus = 'loading';
    const { rerender } = render(
      <AppFrame>
        <div>SETTINGS CONTENT</div>
      </AppFrame>
    );
    expect(replaceMock).not.toHaveBeenCalled();
    // Session restoration completes (the F5 moment).
    sessionStatus = 'authenticated';
    rerender(
      <AppFrame>
        <div>SETTINGS CONTENT</div>
      </AppFrame>
    );
    expect(replaceMock).not.toHaveBeenCalledWith('/');
    expect(pushMock).not.toHaveBeenCalledWith('/');
    expect(replaceMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('unauthenticated private route still redirects to /login (and only /login)', async () => {
    sessionStatus = 'anonymous';
    currentPath = '/finance/payments';
    render(
      <AppFrame>
        <div>PRIVATE CONTENT</div>
      </AppFrame>
    );
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith('/login?next=%2Ffinance%2Fpayments')
    );
    expect(replaceMock).not.toHaveBeenCalledWith('/');
    expect(pushMock).not.toHaveBeenCalledWith('/');
    expect(screen.queryByText('PRIVATE CONTENT')).toBeNull();
  });
});
