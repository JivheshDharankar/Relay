import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import CommandCenterPage from '@/app/page';
import { ActiveRunPreview, MarketPreview, OrdersPreview, CommunityPreview } from '@/components/home/HomePreviews';

const replaceMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: replaceMock }),
  usePathname: () => '/',
}));

const sessionState = { status: 'anonymous' as string };
vi.mock('@/lib/session/SessionContext', () => ({
  useSession: () => ({
    status: sessionState.status,
    session: null,
    refresh: vi.fn(),
    signOut: vi.fn(),
    markUnauthorized: vi.fn(),
  }),
}));

const residentState = {
  profile: null as null | { societyName: string; flatNumber: string; activeMandate: null },
  mandate: null as null,
  loading: false,
  unauthorized: true,
};
vi.mock('@/lib/session/useResidentContext', () => ({
  useResidentContext: () => ({
    profile: residentState.profile,
    payments: null,
    mandate: residentState.mandate,
    paymentsTrusted: false,
    loading: residentState.loading,
    error: null,
    unauthorized: residentState.unauthorized,
    reload: vi.fn(),
  }),
}));

vi.mock('@/lib/workflow/MissionSessionContext', () => ({
  useMissionSession: () => ({
    run: { status: 'idle', prompt: '', error: null },
    start: vi.fn(),
    reset: vi.fn(),
    isProcessing: false,
    isFailed: false,
    demoMode: false,
    setDemoMode: vi.fn(),
  }),
}));

vi.mock('@/lib/workflow/runStore', () => ({
  useRunStore: () => ({ recordRun: vi.fn(), latestRun: null, runs: [] }),
  RunStoreProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getCommunity: vi.fn().mockResolvedValue(null),
    getOrders: vi.fn().mockResolvedValue(null),
    getSuppliers: vi.fn().mockResolvedValue(null),
  };
});

describe('login-first routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionState.status = 'anonymous';
    residentState.profile = null;
    residentState.mandate = null;
    residentState.loading = false;
    residentState.unauthorized = true;
  });

  it('redirects logged-out visitors from / to /login without the command center', async () => {
    render(<CommandCenterPage />);
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/login'));
    expect(screen.queryByRole('heading', { name: /what does your community need/i })).toBeNull();
  });

  it('renders the command center for authenticated sessions', async () => {
    sessionState.status = 'authenticated';
    residentState.unauthorized = false;
    residentState.profile = { societyName: 'Test Society', flatNumber: 'A-1', activeMandate: null };
    render(<CommandCenterPage />);
    expect(
      await screen.findByRole('heading', { name: /what does your community need/i })
    ).not.toBeNull();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('keeps the first screen free of dashboard preview grids', async () => {
    sessionState.status = 'authenticated';
    residentState.unauthorized = false;
    residentState.profile = { societyName: 'Test Society', flatNumber: 'A-1', activeMandate: null };
    const { container } = render(<CommandCenterPage />);
    await screen.findByRole('heading', { name: /what does your community need/i });
    // No fake dashboard preview composition on the first screen.
    expect(container.textContent).not.toContain('autonomous procurement history appears here');
    expect(container.textContent).not.toContain('pool compatible demand privately');
    expect(container.textContent).not.toContain('discover qualified suppliers');
    expect(container.textContent).not.toContain('Procurement Proof');
    // Composer + the real journey strip and operations overview remain.
    expect(screen.getByTestId('ask-relay-button')).not.toBeNull();
    expect(container.textContent).toContain('How Relay works');
    expect(container.textContent).toContain('Muse recommends. Relay verifies and executes.');
  });
});

describe('home previews show intentional empty states, never skeletons', () => {
  it('market/orders/community explain themselves with settled empty data', () => {
    const { container } = render(
      <>
        <MarketPreview suppliers={[]} loading={false} />
        <OrdersPreview orders={[]} loading={false} />
        <CommunityPreview
          community={{ activeDemandPools: [] } as never}
          loading={false}
        />
      </>
    );
    expect(screen.getByText(/discover qualified suppliers/i)).not.toBeNull();
    expect(screen.getByText(/autonomous procurement history appears here/i)).not.toBeNull();
    expect(screen.getByText(/pool compatible demand privately/i)).not.toBeNull();
    // No skeleton shimmer blocks anywhere in the settled cards.
    expect(container.querySelector('.animate-pulse')).toBeNull();
  });

  it('labels the latest run with its honest outcome and finish time', () => {
    const failed = {
      status: 'failed',
      prompt: 'bad command',
      finishedAt: '2026-10-31T12:00:00.000Z',
      agentResponse: { runId: 'run-f1' },
    } as never;
    const { unmount } = render(<ActiveRunPreview run={failed} />);
    expect(screen.getByText(/could not complete/i)).not.toBeNull();
    expect(screen.queryByText(/^completed/i)).toBeNull();
    unmount();
    const done = {
      status: 'complete',
      prompt: 'good command',
      finishedAt: '2026-10-31T12:00:00.000Z',
      agentResponse: { runId: 'run-c1' },
    } as never;
    render(<ActiveRunPreview run={done} />);
    expect(screen.getByText(/completed/i)).not.toBeNull();
  });
});
