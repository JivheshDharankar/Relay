import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MandateLimitEditor } from '@/components/finance/MandateLimitEditor';
import { ApiClientError, updateMandateLimit } from '@/lib/api';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, updateMandateLimit: vi.fn() };
});

const mockedUpdate = vi.mocked(updateMandateLimit);

const MANDATE = { id: 'mandate_test', maximumAmount: 10000, currency: 'INR', status: 'ACTIVE' };

function renderEditor(overrides: Partial<Parameters<typeof MandateLimitEditor>[0]> = {}) {
  const reload = vi.fn().mockResolvedValue(undefined);
  render(
    <MandateLimitEditor
      mandate={MANDATE}
      usedAmount={2450}
      remainingLimit={7550}
      reload={reload}
      {...overrides}
    />
  );
  return { reload };
}

describe('mandate limit editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows current limit, used, and remaining with an edit action', () => {
    renderEditor();
    expect(screen.getByText('Monthly limit')).not.toBeNull();
    expect(screen.getByText('Used')).not.toBeNull();
    expect(screen.getByText('Remaining')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Edit limit' })).not.toBeNull();
  });

  it('rejects invalid input without calling the backend', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit limit' }));
    fireEvent.change(screen.getByLabelText('New monthly limit'), { target: { value: '-50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    expect(screen.getByRole('alert').textContent).toMatch(/greater than 0/);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation, then saves and reloads authoritative values', async () => {
    mockedUpdate.mockResolvedValueOnce({
      id: 'mandate_test',
      maximumAmount: 15000,
      spentAmount: 2450,
      reservedAmount: 0,
      remainingLimit: 12550,
      currency: 'INR',
      status: 'ACTIVE',
    });
    const { reload } = renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit limit' }));
    fireEvent.change(screen.getByLabelText('New monthly limit'), { target: { value: '15000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));

    // Confirmation names both the old and new authoritative values.
    expect(screen.getByText(/Change your monthly limit from/)).not.toBeNull();
    expect(mockedUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm new limit' }));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith(15000));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  it('shows backend errors honestly and never claims success on rejection', async () => {
    mockedUpdate.mockRejectedValueOnce(new ApiClientError('Spending limit must be greater than 0', 400, 'INVALID_MANDATE_LIMIT'));
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit limit' }));
    fireEvent.change(screen.getByLabelText('New monthly limit'), { target: { value: '15000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm new limit' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/greater than 0/));
    // Still on the confirmation step so the user can correct or cancel.
    expect(screen.getByRole('button', { name: 'Confirm new limit' })).not.toBeNull();
  });

  it('warns when the new limit falls below the used amount', () => {
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit limit' }));
    fireEvent.change(screen.getByLabelText('New monthly limit'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    expect(screen.getByText(/Completed payments stay valid/)).not.toBeNull();
  });

  it('disables editing for revoked mandates', () => {
    renderEditor({ mandate: { ...MANDATE, status: 'REVOKED' } });
    expect(screen.queryByRole('button', { name: 'Edit limit' })).toBeNull();
    expect(screen.getByText(/cannot be changed/)).not.toBeNull();
  });
});
