'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, CheckCircle2, Layers, LocateFixed, MapPin } from 'lucide-react';
import { Container } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import { Field, Select, TextInput } from '@/components/ui/inputs';
import { LoadingState } from '@/components/feedback/Feedback';
import {
  ApiClientError,
  getOnboardingStatus,
  registerSociety,
  searchSocieties,
  submitAddressStep,
  submitPaymentMandateStep,
  submitProfileStep,
  submitSocietyStep,
  verifySocietyStep,
  type OnboardingStep,
  type SocietyRecord,
} from '@/lib/api';
import { useSession } from '@/lib/session/SessionContext';
import { cn } from '@/lib/utils';

const STEP_ORDER: { id: OnboardingStep; label: string }[] = [
  { id: 'PROFILE_REQUIRED', label: 'Profile' },
  { id: 'ADDRESS_REQUIRED', label: 'Address' },
  { id: 'SOCIETY_REQUIRED', label: 'Society' },
  { id: 'SOCIETY_VERIFICATION_REQUIRED', label: 'Verify' },
  { id: 'PAYMENT_AUTHORIZATION_REQUIRED', label: 'Mandate' },
];

function stepIndex(step: OnboardingStep): number {
  if (step === 'ONBOARDING_COMPLETE') return STEP_ORDER.length;
  const i = STEP_ORDER.findIndex((s) => s.id === step);
  return i === -1 ? 0 : i;
}

function readError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    if (err.code === 'TIMEOUT') return 'Request timed out. Please try again.';
    if (err.code === 'NETWORK_ERROR') return 'Cannot reach Relay backend. Check that it is running.';
    return err.details
      ? `${err.message} (${typeof err.details === 'string' ? err.details : JSON.stringify(err.details)})`
      : err.message;
  }
  return err instanceof Error ? err.message : fallback;
}

function useCoordinates() {
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const locate = () => {
    setLocationError(null);
    if (!('geolocation' in navigator)) {
      setLocationError('Geolocation is not available in this browser. Enter coordinates manually.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatitude(String(pos.coords.latitude));
        setLongitude(String(pos.coords.longitude));
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setLocationError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Enter coordinates manually.'
            : 'Could not determine location. Enter coordinates manually.'
        );
      },
      { timeout: 10000 }
    );
  };

  return { latitude, setLatitude, longitude, setLongitude, locating, locationError, locate };
}

function CoordinateFields({ coords, idPrefix }: { coords: ReturnType<typeof useCoordinates>; idPrefix: string }) {
  return (
    <div className="space-y-3 rounded-2xl border border-relay-surface-border bg-relay-navy-50/60 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-relay-ink-900 inline-flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 text-relay-ink-500" aria-hidden />
          Delivery coordinates
        </p>
        <Button type="button" variant="outline" size="sm" onClick={coords.locate} isLoading={coords.locating}>
          {!coords.locating && <LocateFixed className="h-3.5 w-3.5" aria-hidden />}
          Use my location
        </Button>
      </div>
      {coords.locationError && (
        <p className="text-xs text-relay-warn-700" role="alert">
          {coords.locationError}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Latitude" htmlFor={`${idPrefix}-lat`}>
          <TextInput
            id={`${idPrefix}-lat`}
            inputMode="decimal"
            required
            value={coords.latitude}
            onChange={(e) => coords.setLatitude(e.target.value)}
            placeholder="e.g. 18.5204"
          />
        </Field>
        <Field label="Longitude" htmlFor={`${idPrefix}-lng`}>
          <TextInput
            id={`${idPrefix}-lng`}
            inputMode="decimal"
            required
            value={coords.longitude}
            onChange={(e) => coords.setLongitude(e.target.value)}
            placeholder="e.g. 73.8567"
          />
        </Field>
      </div>
      <p className="text-xs text-relay-ink-500">
        Used for the supplier-discovery radius. From your device or typed by you — never guessed.
      </p>
    </div>
  );
}

function OnboardingForm() {
  const router = useRouter();
  const { status: sessionStatus } = useSession();

  const [currentStep, setCurrentStep] = useState<OnboardingStep | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');

  const [addressLine, setAddressLine] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const addressCoords = useCoordinates();

  const [societyQuery, setSocietyQuery] = useState('');
  const [societies, setSocieties] = useState<Array<SocietyRecord>>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedSocietyId, setSelectedSocietyId] = useState('');
  const [tower, setTower] = useState('');
  const [flatNumber, setFlatNumber] = useState('');
  const [registering, setRegistering] = useState(false);
  const [newSocietyName, setNewSocietyName] = useState('');
  const [newSocietyAddress, setNewSocietyAddress] = useState('');
  const societyCoords = useCoordinates();

  const [spendingLimit, setSpendingLimit] = useState('5000');

  useEffect(() => {
    if (sessionStatus === 'loading') return;
    if (sessionStatus === 'anonymous') {
      router.push('/login');
      return;
    }
    let cancelled = false;
    getOnboardingStatus()
      .then((summary) => {
        if (cancelled) return;
        if (summary.isComplete) {
          router.push('/');
          return;
        }
        setCurrentStep(summary.currentStep);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(readError(err, 'Failed to load onboarding status.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, router]);

  const advance = (next: OnboardingStep, complete: boolean) => {
    if (complete || next === 'ONBOARDING_COMPLETE') {
      router.push('/');
      return;
    }
    setCurrentStep(next);
  };

  const handleProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const summary = await submitProfileStep({ fullName: fullName.trim(), email: email.trim() });
      advance(summary.currentStep, summary.isComplete);
    } catch (err) {
      setError(readError(err, 'Profile step failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddress = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const summary = await submitAddressStep({
        addressLine: addressLine.trim(),
        city: city.trim(),
        state: state.trim(),
        postalCode: postalCode.trim(),
        latitude: Number(addressCoords.latitude),
        longitude: Number(addressCoords.longitude),
        isDefault: true,
      });
      advance(summary.currentStep, summary.isComplete);
    } catch (err) {
      setError(readError(err, 'Address step failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSearching(true);
    setError(null);
    setNotice(null);
    try {
      const results = await searchSocieties({ query: societyQuery.trim() || undefined });
      setSocieties(results);
      setSearched(true);
      setSelectedSocietyId(results.length > 0 ? results[0].id : '');
    } catch (err) {
      setError(readError(err, 'Society search failed.'));
    } finally {
      setSearching(false);
    }
  };

  const handleRegisterSociety = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const name = newSocietyName.trim();
      // Exact-match pre-check against the live registry: never create a
      // second row for a society that already exists.
      const pre = await searchSocieties({ query: name });
      const exact = pre.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null;
      if (exact) {
        setSocieties(pre);
        setSearched(true);
        setSelectedSocietyId(exact.id);
        setRegistering(false);
        setSubmitting(false);
        setNotice('That society is already registered — select it below.');
        return;
      }
      const created = await registerSociety({
        name,
        address: newSocietyAddress.trim(),
        city: city.trim(),
        state: state.trim(),
        postalCode: postalCode.trim(),
        latitude: Number(societyCoords.latitude),
        longitude: Number(societyCoords.longitude),
      });
      // Never trust the create response alone: reload from the registry so
      // the selectable society is the persisted backend record.
      setSubmitting(false);
      setRegistering(false);
      setSocietyQuery(created.name);
      setSearching(true);
      try {
        const results = await searchSocieties({ query: created.name });
        setSocieties(results);
        setSearched(true);
        const found = results.find((r) => r.id === created.id) ?? null;
        setSelectedSocietyId(found ? found.id : (results[0]?.id ?? ''));
        setNotice(
          found
            ? 'Society registered.'
            : 'Society registered, but it is not visible in search yet — try searching again.'
        );
      } catch (refreshErr) {
        setError(readError(refreshErr, 'Society registered, but reloading the registry failed. Search again to continue.'));
      } finally {
        setSearching(false);
      }
    } catch (err) {
      setError(readError(err, 'Society registration failed.'));
      setSubmitting(false);
    }
  };

  const handleSociety = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedSocietyId) {
      setError('Select a society or register a new one first.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const summary = await submitSocietyStep({
        societyId: selectedSocietyId,
        tower: tower.trim() || undefined,
        flatNumber: flatNumber.trim(),
      });
      advance(summary.currentStep, summary.isComplete);
    } catch (err) {
      setError(readError(err, 'Society step failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const summary = await verifySocietyStep();
      advance(summary.currentStep, summary.isComplete);
    } catch (err) {
      setError(readError(err, 'Verification failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleMandate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const summary = await submitPaymentMandateStep({
        spendingLimit: Number(spendingLimit),
        currency: 'INR',
        purpose: 'COMMUNITY_PROCUREMENT',
      });
      advance(summary.currentStep, summary.isComplete);
    } catch (err) {
      setError(readError(err, 'Payment mandate failed.'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !currentStep) {
    return <LoadingState title="Evaluating onboarding progress" />;
  }

  const activeIndex = stepIndex(currentStep);

  return (
    <div className="w-full max-w-xl mx-auto space-y-6">
      <div className="flex flex-col items-center text-center space-y-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-relay-navy-900">
          <Layers className="h-5 w-5 text-white" aria-hidden />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-relay-ink-900">Welcome to Relay</h1>
          <p className="text-sm text-relay-ink-600 mt-1">Verify your resident profile to join community procurement.</p>
        </div>
      </div>

      <ol className="flex items-center gap-1" aria-label="Onboarding progress">
        {STEP_ORDER.map((s, i) => (
          <li key={s.id} className="flex-1 min-w-0">
            <div
              className={cn(
                'h-1.5 rounded-full',
                i < activeIndex ? 'bg-relay-success-500' : i === activeIndex ? 'bg-relay-primary-600' : 'bg-relay-surface-border'
              )}
              aria-hidden
            />
            <p
              className={cn(
                'mt-1.5 text-[10px] sm:text-[11px] leading-tight truncate',
                i === activeIndex ? 'font-semibold text-relay-ink-900' : 'text-relay-ink-500'
              )}
              aria-current={i === activeIndex ? 'step' : undefined}
            >
              {s.label}
            </p>
          </li>
        ))}
      </ol>

      {error && (
        <p className="flex items-start gap-2 rounded-2xl border border-relay-danger-100 bg-relay-danger-50 px-3.5 py-2.5 text-[13px] text-relay-danger-700" role="alert">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
          <span>{error}</span>
        </p>
      )}

      {currentStep === 'PROFILE_REQUIRED' && (
        <form onSubmit={handleProfile} className="space-y-4 rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-5 sm:px-6 py-6">
          <h2 className="text-base font-semibold text-relay-ink-900">Your profile</h2>
          <Field label="Full name" htmlFor="ob-name">
            <TextInput id="ob-name" required minLength={2} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your full name" autoComplete="name" />
          </Field>
          <Field label="Email" htmlFor="ob-email">
            <TextInput id="ob-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />
          </Field>
          <Button type="submit" className="w-full" isLoading={submitting}>Continue</Button>
        </form>
      )}

      {currentStep === 'ADDRESS_REQUIRED' && (
        <form onSubmit={handleAddress} className="space-y-4 rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-5 sm:px-6 py-6">
          <h2 className="text-base font-semibold text-relay-ink-900">Delivery address</h2>
          <Field label="Address line" htmlFor="ob-address">
            <TextInput id="ob-address" required minLength={5} value={addressLine} onChange={(e) => setAddressLine(e.target.value)} placeholder="Flat, floor, street" autoComplete="street-address" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City" htmlFor="ob-city">
              <TextInput id="ob-city" required value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" />
            </Field>
            <Field label="State" htmlFor="ob-state">
              <TextInput id="ob-state" required value={state} onChange={(e) => setState(e.target.value)} autoComplete="address-level1" />
            </Field>
          </div>
          <Field label="Postal code" htmlFor="ob-postal">
            <TextInput id="ob-postal" required value={postalCode} onChange={(e) => setPostalCode(e.target.value)} autoComplete="postal-code" />
          </Field>
          <CoordinateFields coords={addressCoords} idPrefix="ob" />
          <Button type="submit" className="w-full" isLoading={submitting}>Save address</Button>
        </form>
      )}

      {currentStep === 'SOCIETY_REQUIRED' && !registering && (
        <div className="space-y-4 rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-5 sm:px-6 py-6">
          <h2 className="text-base font-semibold text-relay-ink-900">Find your society</h2>
          {notice && (
            <p className="rounded-2xl border border-relay-success-100 bg-relay-success-50 px-3.5 py-2.5 text-[13px] text-relay-success-700" role="status">
              {notice}
            </p>
          )}
          <form onSubmit={handleSearch} className="flex gap-2">
            <TextInput aria-label="Search societies" value={societyQuery} onChange={(e) => setSocietyQuery(e.target.value)} placeholder="Search by name, city, or postal code" className="flex-1" />
            <Button type="submit" variant="outline" isLoading={searching} className="shrink-0">Search</Button>
          </form>
          {searching && (
            <p className="text-[13px] text-relay-ink-600" role="status">Searching societies…</p>
          )}
          {searched && !searching && societies.length === 0 && (
            <div className="rounded-2xl border border-dashed border-relay-surface-border bg-relay-navy-50/50 px-4 py-5 text-center space-y-2">
              <p className="text-sm font-semibold text-relay-ink-900">No society found</p>
              <p className="text-[13px] text-relay-ink-600">No registry entry matches that search. Register your society to continue.</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setRegistering(true)}>
                Register your society
              </Button>
            </div>
          )}
          {!searched && !searching && societies.length === 0 && (
            <p className="text-[13px] text-relay-ink-600">Search the registry for your society, or register it if it is new.</p>
          )}
          {societies.length > 0 && (
            <Field label="Select society" htmlFor="ob-society">
              <Select id="ob-society" value={selectedSocietyId} onChange={(e) => setSelectedSocietyId(e.target.value)}>
                {societies.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.city}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {societies.length > 0 && (
            <form onSubmit={handleSociety} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Tower (optional)" htmlFor="ob-tower">
                  <TextInput id="ob-tower" value={tower} onChange={(e) => setTower(e.target.value)} placeholder="A" />
                </Field>
                <Field label="Flat number" htmlFor="ob-flat">
                  <TextInput id="ob-flat" required value={flatNumber} onChange={(e) => setFlatNumber(e.target.value)} placeholder="101" />
                </Field>
              </div>
              <Button type="submit" className="w-full" isLoading={submitting} disabled={!selectedSocietyId}>
                Join society
              </Button>
            </form>
          )}
          {!(searched && !searching && societies.length === 0) && (
            <button
              type="button"
              onClick={() => setRegistering(true)}
              className="w-full text-center text-[13px] font-semibold text-relay-primary-600 hover:underline min-h-[32px]"
            >
              Can&apos;t find your society? Register it
            </button>
          )}
        </div>
      )}

      {currentStep === 'SOCIETY_REQUIRED' && registering && (
        <form onSubmit={handleRegisterSociety} className="space-y-4 rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-5 sm:px-6 py-6">
          <h2 className="text-base font-semibold text-relay-ink-900">Register society</h2>
          {submitting && (
            <p className="text-[13px] text-relay-ink-600" role="status">Registering society…</p>
          )}
          <Field label="Society name" htmlFor="ob-soc-name">
            <TextInput id="ob-soc-name" required value={newSocietyName} onChange={(e) => setNewSocietyName(e.target.value)} />
          </Field>
          <Field label="Society address" htmlFor="ob-soc-address">
            <TextInput id="ob-soc-address" required value={newSocietyAddress} onChange={(e) => setNewSocietyAddress(e.target.value)} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="City" htmlFor="ob-soc-city">
              <TextInput id="ob-soc-city" required value={city} onChange={(e) => setCity(e.target.value)} />
            </Field>
            <Field label="State" htmlFor="ob-soc-state">
              <TextInput id="ob-soc-state" required value={state} onChange={(e) => setState(e.target.value)} />
            </Field>
            <Field label="Postal code" htmlFor="ob-soc-postal">
              <TextInput id="ob-soc-postal" required value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
            </Field>
          </div>
          <CoordinateFields coords={societyCoords} idPrefix="ob-soc" />
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="flex-1" onClick={() => setRegistering(false)}>
              Back
            </Button>
            <Button type="submit" className="flex-1" isLoading={submitting}>
              Register
            </Button>
          </div>
        </form>
      )}

      {currentStep === 'SOCIETY_VERIFICATION_REQUIRED' && (
        <div className="space-y-4 rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-5 sm:px-6 py-6 text-center">
          <CheckCircle2 className="h-10 w-10 text-relay-primary-600 mx-auto" aria-hidden />
          <div>
            <h2 className="text-base font-semibold text-relay-ink-900">Verify membership</h2>
            <p className="text-sm text-relay-ink-600 mt-1">Confirm that you reside in this society to unlock community demand pooling.</p>
          </div>
          <Button onClick={handleVerify} isLoading={submitting} className="w-full">
            Verify membership
          </Button>
        </div>
      )}

      {currentStep === 'PAYMENT_AUTHORIZATION_REQUIRED' && (
        <form onSubmit={handleMandate} className="space-y-4 rounded-2xl border border-relay-surface-border bg-[#12161D] shadow-none px-5 sm:px-6 py-6">
          <h2 className="text-base font-semibold text-relay-ink-900">Payment mandate</h2>
          <p className="text-sm text-relay-ink-600 leading-relaxed">
            Authorize a spending ceiling for autonomous procurement. Relay can never charge
            beyond this limit, and every payment settles under it.
          </p>
          <Field label="Spending limit (INR)" htmlFor="ob-limit" hint="Maximum ₹1,000,000.">
            <TextInput id="ob-limit" inputMode="numeric" required value={spendingLimit} onChange={(e) => setSpendingLimit(e.target.value)} />
          </Field>
          <Button type="submit" className="w-full" isLoading={submitting}>
            Authorize mandate
          </Button>
        </form>
      )}
    </div>
  );
}

export default function OnboardingPage() {
  return (
    <div className="py-10 sm:py-14">
      <Container size="sm">
        <Suspense fallback={<LoadingState title="Loading onboarding" />}>
          <OnboardingForm />
        </Suspense>
      </Container>
    </div>
  );
}
