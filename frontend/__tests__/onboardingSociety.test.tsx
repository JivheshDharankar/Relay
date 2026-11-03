import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import OnboardingPage from '@/app/onboarding/page';
import { getOnboardingStatus, registerSociety, searchSocieties } from '@/lib/api';

const pushMock = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));

vi.mock('@/lib/session/SessionContext', () => ({
  useSession: () => ({ status: 'authenticated', session: null, refresh: vi.fn(), signOut: vi.fn() }),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getOnboardingStatus: vi.fn(),
    searchSocieties: vi.fn(),
    registerSociety: vi.fn(),
  };
});

const mockedStatus = vi.mocked(getOnboardingStatus);
const mockedSearch = vi.mocked(searchSocieties);
const mockedRegister = vi.mocked(registerSociety);

const soc = (id: string, name: string, city: string) =>
  ({ id, name, city, address: `${city} addr`, state: 'ST', postalCode: '000000' }) as never;

describe('onboarding society search / register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedStatus.mockResolvedValue({ isComplete: false, currentStep: 'SOCIETY_REQUIRED' } as never);
  });

  async function toSocietyStep() {
    render(<OnboardingPage />);
    await screen.findByRole('heading', { name: /find your society/i });
  }

  function searchInput() {
    return screen.getByLabelText(/search societies/i);
  }

  it('shows an explicit no-result state with a register path', async () => {
    mockedSearch.mockResolvedValueOnce([]);
    await toSocietyStep();
    fireEvent.change(searchInput(), { target: { value: 'Nopeville' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    expect(await screen.findByText(/no society found/i)).not.toBeNull();
    expect(screen.getByRole('button', { name: /register your society/i })).not.toBeNull();
    expect(screen.queryByLabelText(/select society/i)).toBeNull();
  });

  it('reloads the registry after registration instead of trusting the create response', async () => {
    mockedSearch.mockResolvedValueOnce([]);
    await toSocietyStep();
    // Empty search first, then register.
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    await screen.findByText(/no society found/i);
    fireEvent.click(screen.getByRole('button', { name: /register your society/i }));

    fireEvent.change(screen.getByLabelText(/society name/i), { target: { value: 'Fresh Towers' } });
    fireEvent.change(screen.getByLabelText(/society address/i), { target: { value: '1 New Road' } });
    // City/state/postal inputs are shared address state; fill via placeholders ids.
    fireEvent.change(document.getElementById('ob-soc-city') as HTMLInputElement, { target: { value: 'Pune' } });
    fireEvent.change(document.getElementById('ob-soc-state') as HTMLInputElement, { target: { value: 'MH' } });
    fireEvent.change(document.getElementById('ob-soc-postal') as HTMLInputElement, { target: { value: '411001' } });
    fireEvent.change(document.getElementById('ob-soc-lat') as HTMLInputElement, { target: { value: '18.5' } });
    fireEvent.change(document.getElementById('ob-soc-lng') as HTMLInputElement, { target: { value: '73.8' } });

    // Create response carries a different city than the persisted registry
    // record; the UI must render the registry version.
    mockedRegister.mockResolvedValueOnce(soc('soc_1', 'Fresh Towers', 'Draft-City'));
    mockedSearch.mockResolvedValueOnce([]); // exact-match pre-check: absent
    mockedSearch.mockResolvedValueOnce([soc('soc_1', 'Fresh Towers', 'Pune')]);
    fireEvent.click(screen.getByRole('button', { name: /^register$/i }));

    await waitFor(() => expect(mockedRegister).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockedSearch).toHaveBeenCalledWith(expect.objectContaining({ query: 'Fresh Towers' }))
    );
    expect(await screen.findByText(/society registered\./i)).not.toBeNull();
    const select = (await screen.findByLabelText(/select society/i)) as HTMLSelectElement;
    expect(select.options.length).toBe(1);
    expect(select.options[0].text).toContain('Pune');
    expect(select.options[0].text).not.toContain('Draft-City');
    expect(select.value).toBe('soc_1');
  });

  it('short-circuits registration when the exact name already exists', async () => {
    await toSocietyStep();
    fireEvent.click(screen.getByRole('button', { name: /can't find your society/i }));
    fireEvent.change(screen.getByLabelText(/society name/i), { target: { value: 'Old Towers' } });
    fireEvent.change(screen.getByLabelText(/society address/i), { target: { value: '9 Old Road' } });
    fireEvent.change(document.getElementById('ob-soc-city') as HTMLInputElement, { target: { value: 'Pune' } });
    fireEvent.change(document.getElementById('ob-soc-state') as HTMLInputElement, { target: { value: 'MH' } });
    fireEvent.change(document.getElementById('ob-soc-postal') as HTMLInputElement, { target: { value: '411001' } });
    fireEvent.change(document.getElementById('ob-soc-lat') as HTMLInputElement, { target: { value: '18.5' } });
    fireEvent.change(document.getElementById('ob-soc-lng') as HTMLInputElement, { target: { value: '73.8' } });
    mockedSearch.mockResolvedValueOnce([soc('soc_9', 'Old Towers', 'Pune')]);
    fireEvent.click(screen.getByRole('button', { name: /^register$/i }));
    expect(await screen.findByText(/already registered — select it below/i)).not.toBeNull();
    expect(mockedRegister).not.toHaveBeenCalled();
    const select = (await screen.findByLabelText(/select society/i)) as HTMLSelectElement;
    expect(select.value).toBe('soc_9');
  });

  it('keeps the register form with a real error when registration fails', async () => {
    await toSocietyStep();
    fireEvent.click(screen.getByRole('button', { name: /can't find your society/i }));
    fireEvent.change(screen.getByLabelText(/society name/i), { target: { value: 'Dup Towers' } });
    fireEvent.change(screen.getByLabelText(/society address/i), { target: { value: '2 Old Road' } });
    fireEvent.change(document.getElementById('ob-soc-city') as HTMLInputElement, { target: { value: 'Pune' } });
    fireEvent.change(document.getElementById('ob-soc-state') as HTMLInputElement, { target: { value: 'MH' } });
    fireEvent.change(document.getElementById('ob-soc-postal') as HTMLInputElement, { target: { value: '411001' } });
    fireEvent.change(document.getElementById('ob-soc-lat') as HTMLInputElement, { target: { value: '18.5' } });
    fireEvent.change(document.getElementById('ob-soc-lng') as HTMLInputElement, { target: { value: '73.8' } });
    mockedSearch.mockResolvedValueOnce([]); // pre-check: absent
    mockedRegister.mockRejectedValueOnce(new Error('Society already registered'));
    fireEvent.click(screen.getByRole('button', { name: /^register$/i }));
    expect(await screen.findByText(/society already registered/i)).not.toBeNull();
    // Still on the register form: retry is possible.
    expect(screen.getByLabelText(/society name/i)).not.toBeNull();
    // Only the exact-match pre-check searched; no registry reload after failure.
    expect(mockedSearch).toHaveBeenCalledTimes(1);
  });
});
