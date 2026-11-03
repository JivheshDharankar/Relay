import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useResidentContext } from '@/lib/session/useResidentContext';
import { getOnboardingStatus, getPayments, getResidentProfile } from '@/lib/api';

vi.mock('@/lib/session/SessionContext', () => ({
  useSession: () => ({ status: 'authenticated', session: null, refresh: vi.fn(), signOut: vi.fn() }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getResidentProfile: vi.fn(),
    getPayments: vi.fn(),
    getOnboardingStatus: vi.fn(),
  };
});

const mockedProfile = vi.mocked(getResidentProfile);
const mockedPayments = vi.mocked(getPayments);
const mockedStatus = vi.mocked(getOnboardingStatus);

const FALLBACK_PROFILE = {
  id: 'res_x',
  name: 'Someone',
  email: 's@example.com',
  flatNumber: 'Flat 101',
  societyId: 'soc_seed',
  societyName: 'Nashik Heights Residency',
  societyAddress: 'Gangapur Road, Nashik',
  societyCity: 'Nashik',
  activeMandate: null,
  totalOrders: 0,
};

describe('resident context membership gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPayments.mockResolvedValue(null as never);
  });

  it('nulls the profile before society membership (backend fallback is not identity)', async () => {
    mockedProfile.mockResolvedValue(FALLBACK_PROFILE);
    mockedStatus.mockResolvedValue({ hasMembership: false } as never);
    const { result } = renderHook(() => useResidentContext());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMembership).toBe(false);
    expect(result.current.profile).toBeNull();
    expect(result.current.mandate).toBeNull();
  });

  it('exposes the profile once membership exists', async () => {
    mockedProfile.mockResolvedValue(FALLBACK_PROFILE);
    mockedStatus.mockResolvedValue({ hasMembership: true } as never);
    const { result } = renderHook(() => useResidentContext());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMembership).toBe(true);
    expect(result.current.profile).not.toBeNull();
  });

  it('fails open on a status outage so established identity is kept', async () => {
    mockedProfile.mockResolvedValue(FALLBACK_PROFILE);
    mockedStatus.mockRejectedValue(new Error('status down'));
    const { result } = renderHook(() => useResidentContext());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.profile).not.toBeNull();
  });
});
