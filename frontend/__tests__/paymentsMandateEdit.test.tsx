import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PaymentsPage from '@/app/payments/page';
import { updateMandateLimit } from '@/lib/api';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/lib/session/SessionContext', () => ({
  useSession: () => ({ status: 'authenticated', session: null, refresh: vi.fn(), signOut: vi.fn() }),
}));

const reloadMock = vi.fn().mockResolvedValue(undefined);

vi.mock('@/lib/session/useResidentContext', () => ({
  useResidentContext: () => ({
    profile: null,
    payments: null,
    mandate: { id: 'mandate_pay', maximumAmount: 5000, currency: 'INR', status: 'ACTIVE' },
    paymentsTrusted: false,
    loading: false,
    error: null,
    unauthorized: false,
    hasMembership: true,
    onboarding: null,
    reload: reloadMock,
  }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, updateMandateLimit: vi.fn() };
});

const mockedUpdate = vi.mocked(updateMandateLimit);

describe('payments mandate edit entry point', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Edit limit under Authorized limit and keeps unavailable capacity honest', () => {
    render(<PaymentsPage />);
    expect(screen.getByText('Authorized limit')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Edit limit' })).not.toBeNull();
    expect(screen.getByText('Capacity breakdown unavailable for this mandate.')).not.toBeNull();
  });

  it('opens the existing editor flow and saves the authoritative new value', async () => {
    mockedUpdate.mockResolvedValueOnce({
      id: 'mandate_pay',
      maximumAmount: 8000,
      spentAmount: 0,
      reservedAmount: 0,
      remainingLimit: 8000,
      currency: 'INR',
      status: 'ACTIVE',
    });
    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit limit' }));

    // Existing editor opens directly at edit with the current limit prefilled.
    const input = screen.getByLabelText('New monthly limit') as HTMLInputElement;
    expect(input.value).toBe('5000');
    fireEvent.change(input, { target: { value: '8000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));

    // Explicit confirmation names old and new values.
    expect(screen.getByText(/Change your monthly limit from/)).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm new limit' }));

    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith(8000));
    await waitFor(() => expect(reloadMock).toHaveBeenCalled());
    // Panel closes after save; refreshed authoritative values come from reload.
    await waitFor(() =>
      expect(screen.queryByLabelText('New monthly limit')).toBeNull()
    );
  });

  it('cancel closes the panel without calling the backend', () => {
    render(<PaymentsPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit limit' }));
    expect(screen.getByLabelText('New monthly limit')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('New monthly limit')).toBeNull();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });
});
