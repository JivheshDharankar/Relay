'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiClientError, getOnboardingStatus, getPayments, getResidentProfile } from '@/lib/api';
import type { OnboardingSummary } from '@/lib/api/onboarding';
import { PaymentSummary, ResidentProfile } from '@/types';
import { useSession } from './SessionContext';

export interface SessionMandate {
  id: string;
  maximumAmount: number;
  currency: string;
  status: string;
}

export interface ResidentContext {
  profile: ResidentProfile | null;
  payments: PaymentSummary | null;
  /** Session-correct mandate from portal/resident — authority for gating/limits. */
  mandate: SessionMandate | null;
  /**
   * portal/payments ignores the session (seed fallback). Its remaining-limit
   * and transactions are trustworthy only when its mandate id matches the
   * session mandate id.
   */
  paymentsTrusted: boolean;
  loading: boolean;
  error: string | null;
  unauthorized: boolean;
  /**
   * True once the resident has joined a society. The backend substitutes
   * fallback society/flat values before that point, so consumers must treat
   * identity as absent until this is true (profile is nulled below).
   */
  hasMembership: boolean;
  /**
   * Last-known-good onboarding summary. Resolved alongside identity so the
   * app shell can gate incomplete users without a second fetch. Null until
   * the first successful fetch; failures keep the previous value.
   */
  onboarding: OnboardingSummary | null;
  reload: () => Promise<void>;
}

/**
 * Loads the authenticated resident's live context. Returns nulls (never
 * hardcoded values) when the backend provides nothing or the user is anonymous.
 */
export function useResidentContext(): ResidentContext {
  const { status: sessionStatus } = useSession();
  const [profile, setProfile] = useState<ResidentProfile | null>(null);
  const [payments, setPayments] = useState<PaymentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [hasMembership, setHasMembership] = useState(false);
  const [onboarding, setOnboarding] = useState<OnboardingSummary | null>(null);

  const reload = useCallback(async () => {
    if (sessionStatus === 'loading') return;
    if (sessionStatus === 'anonymous') {
      setProfile(null);
      setPayments(null);
      setLoading(false);
      setError(null);
      setUnauthorized(false);
      setHasMembership(false);
      setOnboarding(null);
      return;
    }
    setLoading(true);
    setError(null);
    setUnauthorized(false);
    try {
      const [prof, pay] = await Promise.all([getResidentProfile(), getPayments()]);
      // Membership is the only signal that separates a real society identity
      // from the backend's pre-join fallback values. Fail open on a status
      // outage so established identity never disappears transiently.
      let joined = true;
      try {
        const summary = await getOnboardingStatus();
        setOnboarding(summary);
        joined = summary.hasMembership;
      } catch {
        joined = true;
      }
      setHasMembership(joined);
      setProfile(joined ? prof : null);
      setPayments(pay);
    } catch (err) {
      if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
        setUnauthorized(true);
        setProfile(null);
        setPayments(null);
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load resident context');
      }
    } finally {
      setLoading(false);
    }
  }, [sessionStatus]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const mandate: SessionMandate | null = profile?.activeMandate
    ? {
        id: profile.activeMandate.id,
        maximumAmount: profile.activeMandate.maximumAmount,
        currency: profile.activeMandate.currency,
        status: profile.activeMandate.status,
      }
    : null;
  const paymentsTrusted =
    mandate !== null &&
    payments?.mandate !== null &&
    payments?.mandate !== undefined &&
    payments.mandate.id === mandate.id;

  return { profile, payments, mandate, paymentsTrusted, loading, error, unauthorized, hasMembership, onboarding, reload };
}
